// ==========================================
// RECON (temporary) — stock reconciliation worksheet
//
// Compares two independent reconstructions of today's stock:
//
//   Calculated = the 3/30/26 spreadsheet baseline + every Firestore
//                transaction (sales, stock_history, stock_out, transfers).
//   Snapshot   = the 7/16/26 PDF backup + only the transactions recorded
//                after that snapshot, rolled forward to today.
//
// Live stock (the inventory collection the app actually serves) is shown
// alongside as a third reference point. Read-only: this view never writes.
// ==========================================

const RECON_BRANCHES = ['IRV', 'LA', 'RH'];

// Sales and inventory rows written before the branch codes were standardized
// still carry the old campus names. Fold them into the current codes so the
// April transactions land on the right branch.
const RECON_LEGACY_BRANCH = { 'Irvine': 'IRV', 'Rowland Heights': 'RH' };
const reconBranch = b => RECON_LEGACY_BRANCH[b] || b;

let reconRows = null;
let reconTx = null;          // flat transaction list, fetched once
let reconFilter = 'diff';

// The spreadsheet's 3/30 column already reflects that day's restocking: the
// only baseline row touched by a 3/30 stock-in (LA "Evolve 3") holds exactly
// the restocked quantity, and excluding it lands the calculation on the live
// stock figure. So same-day transactions are treated as already counted.
let reconCountBaselineDay = false;

async function renderRecon() {
  const el = document.getElementById('recon-body');
  if (currentRole !== 'manager') {
    el.innerHTML = '<div class="empty-state">Managers only.</div>';
    return;
  }
  if (!reconTx) {
    el.innerHTML = '<div class="empty-state">Loading transactions…</div>';
    try {
      reconTx = await loadReconTx();
    } catch (e) {
      console.error(e);
      el.innerHTML = '<div class="empty-state">Could not load transaction history.</div>';
      return;
    }
  }
  reconRows = buildReconRows();
  drawRecon();
}

// Every stock-moving record, flattened to signed per-branch quantities.
// Fetched once per page load; the boundary toggle re-aggregates in memory.
async function loadReconTx() {
  const [salesSnap, inSnap, outSnap, trSnap] = await Promise.all([
    db.collection('sales').get(),
    db.collection('stock_history').get(),
    db.collection('stock_out').get(),
    db.collection('transfers').get()
  ]);

  const tx = [];
  tx.skipped = [];
  const push = (ts, branch, isbn, qty) => {
    const b = reconBranch(branch);
    if (!RECON_BRANCHES.includes(b) || !isbn) return;
    tx.push({ ts, branch: b, isbn, qty });
  };
  const dateOf = (d, r, field, label) => {
    const t = (r[field] || '').trim();
    if (!t) tx.skipped.push(label + ' ' + d.id + ' (no date)');
    return t;
  };

  salesSnap.docs.forEach(d => {
    const r = d.data();
    // One malformed legacy sale has isbn "undefined" and a blank soldAt.
    if (!r.isbn || r.isbn === 'undefined') { tx.skipped.push('sale ' + d.id + ' (no ISBN)'); return; }
    const t = dateOf(d, r, 'soldAt', 'sale');
    if (t) push(t, r.branch, r.isbn, -(Number(r.quantity) || 0));
  });
  inSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'stock-in');
    if (t) push(t, r.branch, r.isbn, Number(r.quantity) || 0);
  });
  outSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'stock-out');
    if (t) push(t, r.branch, r.isbn, -(Number(r.quantity) || 0));
  });
  trSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'transfer');
    if (!t) return;
    push(t, r.fromBranch, r.isbn, -(Number(r.quantity) || 0));
    push(t, r.toBranch, r.isbn, Number(r.quantity) || 0);
  });
  return tx;
}

function buildReconRows() {
  // Two delta maps over the same transaction set: everything counted against
  // the baseline, and only what happened after the PDF snapshot.
  const all = {}, post = {};
  let countedTx = 0;
  reconTx.forEach(t => {
    const k = t.branch + '|' + t.isbn;
    if (reconCountBaselineDay || t.ts.slice(0, 10) > RECON_BASELINE_DATE) {
      all[k] = (all[k] || 0) + t.qty;
      countedTx++;
    }
    if (t.ts > RECON_SNAPSHOT_CUTOFF) post[k] = (post[k] || 0) + t.qty;
  });

  // Live stock, current branch codes only. Rows still filed under a legacy
  // campus name are orphans, not additional stock — see the notes panel.
  const live = {}, orphans = [];
  inventory.forEach(r => {
    if (RECON_BRANCHES.includes(r.branch)) live[r.branch + '|' + r.isbn] = (live[r.branch + '|' + r.isbn] || 0) + (Number(r.stock) || 0);
    else orphans.push({ branch: r.branch, title: r.title, stock: Number(r.stock) || 0 });
  });

  const rows = [];
  books.forEach(b => {
    RECON_BRANCHES.forEach(br => {
      const k = br + '|' + b.isbn;
      const base = RECON_BASELINE[k];
      const hasBase = base !== undefined;
      const snap = RECON_SNAPSHOT[k];
      const tx = all[k] || 0, postTx = post[k] || 0;
      const liveQty = live[k];
      if (!hasBase && !snap && !tx && liveQty === undefined) return;
      const calc = hasBase ? base + tx : null;
      const rolled = (snap || 0) + postTx;
      rows.push({
        isbn: b.isbn, title: b.title, branch: br,
        base: hasBase ? base : null, tx, calc,
        snap: snap === undefined ? null : snap, postTx, rolled,
        live: liveQty === undefined ? null : liveQty,
        diff: calc === null ? null : calc - rolled
      });
    });
  });
  rows._orphans = orphans;
  rows._skipped = reconTx.skipped;
  rows._countedTx = countedTx;
  rows._totalTx = reconTx.length;
  return rows;
}

function setReconFilter(f) {
  reconFilter = f;
  document.querySelectorAll('.recon-filter-btn').forEach(b => b.classList.toggle('active', b.dataset.rf === f));
  drawRecon();
}

function toggleReconBaselineDay() {
  reconCountBaselineDay = document.getElementById('recon-baseline-day').checked;
  reconRows = buildReconRows();
  drawRecon();
}

function drawRecon() {
  const rows = reconRows;
  const search = (document.getElementById('recon-search').value || '').trim().toLowerCase();
  let shown = rows.filter(r => {
    if (reconFilter === 'diff' && !(r.diff !== null && r.diff !== 0)) return false;
    if (reconFilter === 'nobase' && r.base !== null) return false;
    if (search && !(r.title.toLowerCase().includes(search) || r.isbn.toLowerCase().includes(search))) return false;
    return true;
  });
  shown.sort((a, b) => Math.abs(b.diff || 0) - Math.abs(a.diff || 0) || a.title.localeCompare(b.title) || a.branch.localeCompare(b.branch));

  const withBase = rows.filter(r => r.base !== null);
  const mismatched = withBase.filter(r => r.diff !== 0);
  const negative = withBase.filter(r => r.calc < 0);

  const cell = (v, cls) => `<td class="ta-r ${cls || ''}">${v === null ? '<span style="color:#cbd5e1;">—</span>' : v}</td>`;
  const body = shown.length === 0
    ? '<tr><td colspan="10" class="empty-state">No rows match.</td></tr>'
    : shown.map(r => {
        const d = r.diff;
        const dCol = d === null ? '' : d === 0 ? 'color:#16a34a;' : 'color:#dc2626;font-weight:600;';
        return `<tr>
          <td>${escHtml(r.branch)}</td>
          <td>${escHtml(r.title)}</td>
          ${cell(r.base)}${cell(r.tx)}${cell(r.calc)}
          ${cell(r.snap)}${cell(r.postTx)}${cell(r.rolled)}
          <td class="ta-r" style="${dCol}">${d === null ? '<span style="color:#cbd5e1;">—</span>' : (d > 0 ? '+' + d : d)}</td>
          ${cell(r.live)}
        </tr>`;
      }).join('');

  const orphanTotal = rows._orphans.reduce((a, o) => a + o.stock, 0);
  const stamps = reconTx.map(t => t.ts).sort();
  const postCount = reconTx.filter(t => t.ts > RECON_SNAPSHOT_CUTOFF).length;
  const notes = [
    `Transaction coverage: <strong>${rows._countedTx}</strong> of ${rows._totalTx} stock movements applied to the baseline, and <strong>${postCount}</strong> applied on top of the PDF. Both sides are open-ended at the top, so everything up to the latest record (${stamps[stamps.length - 1]}) is included — this page re-reads Firestore on every page load.`,
    `Baseline covers <strong>${withBase.length}</strong> of ${rows.length} branch/book rows — the spreadsheet only tracks the course books, so the rest have no 3/30 starting count.`,
    `<strong>${mismatched.length}</strong> of ${withBase.length} rows with a baseline disagree; <strong>${negative.length}</strong> compute to a negative stock, which is impossible.`,
    `Negative results mean the Firestore log is missing inbound stock: the April restocks recorded in the spreadsheet's Amazon / Cambridge / Pearson columns were never entered as stock-in records, and <code>init_inventory.js</code> overwrote stock levels directly without writing history.`,
    `<strong>${rows._orphans.length}</strong> inventory rows (${orphanTotal} units) are still filed under the old campus names "Irvine" / "Rowland Heights". The app never shows them; treating them as extra stock makes the match worse, so they look like pre-rename leftovers.`,
    ...(rows._skipped.length ? [`${rows._skipped.length} transaction(s) skipped as unusable: ${rows._skipped.join(', ')}.`] : []),
    ...RECON_SOURCE_NOTES
  ];

  document.getElementById('recon-body').innerHTML = `
    <div class="card" style="padding:12px 16px;margin-bottom:12px;">
      <div style="font-size:13px;color:#475569;line-height:1.7;">
        <strong>Calculated</strong> = ${RECON_BASELINE_DATE} spreadsheet baseline + all recorded transactions.<br>
        <strong>Rolled</strong> = ${RECON_SNAPSHOT_DATE} PDF snapshot + transactions after that date.<br>
        <strong>Diff</strong> = Calculated − Rolled. Nothing on this page writes to the database.
      </div>
      <ul style="margin:10px 0 0;padding-left:18px;font-size:12.5px;color:#475569;line-height:1.8;">
        ${notes.map(n => '<li>' + n + '</li>').join('')}
      </ul>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Branch</th><th>Title</th>
              <th class="ta-r">Base ${RECON_BASELINE_DATE.slice(5)}</th><th class="ta-r">All tx</th><th class="ta-r">Calculated</th>
              <th class="ta-r">PDF ${RECON_SNAPSHOT_DATE.slice(5)}</th><th class="ta-r">Tx after</th><th class="ta-r">Rolled</th>
              <th class="ta-r">Diff</th><th class="ta-r">Live</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}
