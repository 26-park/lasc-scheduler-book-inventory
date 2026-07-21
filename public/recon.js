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

// Editing a book's ISBN rewrites only the books doc — every sale, restock and
// inventory row already written keeps the superseded ISBN, so those records
// would otherwise be dropped from the reconciliation. Re-attach them to the
// catalog by exact title, which is how they were matched when imported.
function reconResolveIsbn(isbn, title) {
  if (reconCatalog.has(isbn)) return isbn;
  return reconTitleIsbn[(title || '').trim().toLowerCase()] || null;
}
let reconCatalog = new Set(), reconTitleIsbn = {};
function reconIndexCatalog() {
  reconCatalog = new Set(books.map(b => b.isbn));
  reconTitleIsbn = {};
  books.forEach(b => { reconTitleIsbn[b.title.trim().toLowerCase()] = b.isbn; });
}

let reconRows = null;
let reconTx = null;          // flat transaction list, fetched once per change

// Called by invalidateHistCache() after any stock write, so a sale or restock
// entered in this page session is picked up the next time the tab is drawn.
window.invalidateReconCache = function () { reconTx = null; };
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

  reconIndexCatalog();
  const tx = [];
  tx.skipped = [];
  tx.realigned = 0;
  const push = (ts, branch, isbn, title, qty) => {
    const b = reconBranch(branch);
    if (!RECON_BRANCHES.includes(b)) return;
    const resolved = reconResolveIsbn(isbn, title);
    if (!resolved) { tx.skipped.push(`${title || isbn} (not in book catalog)`); return; }
    if (resolved !== isbn) tx.realigned++;
    tx.push({ ts, branch: b, isbn: resolved, qty });
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
    if (t) push(t, r.branch, r.isbn, r.title, -(Number(r.quantity) || 0));
  });
  inSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'stock-in');
    if (t) push(t, r.branch, r.isbn, r.title, Number(r.quantity) || 0);
  });
  outSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'stock-out');
    if (t) push(t, r.branch, r.isbn, r.title, -(Number(r.quantity) || 0));
  });
  trSnap.docs.forEach(d => {
    const r = d.data();
    const t = dateOf(d, r, 'createdAt', 'transfer');
    if (!t) return;
    push(t, r.fromBranch, r.isbn, r.title, -(Number(r.quantity) || 0));
    push(t, r.toBranch, r.isbn, r.title, Number(r.quantity) || 0);
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
    if (!RECON_BRANCHES.includes(r.branch)) { orphans.push({ branch: r.branch, title: r.title, stock: Number(r.stock) || 0 }); return; }
    const isbn = reconResolveIsbn(r.isbn, r.title);
    if (!isbn) return;
    live[r.branch + '|' + isbn] = (live[r.branch + '|' + isbn] || 0) + (Number(r.stock) || 0);
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
  const qualifies = r => {
    if (reconFilter === 'diff' && !(r.diff !== null && r.diff !== 0)) return false;
    if (reconFilter === 'nobase' && r.base !== null) return false;
    return true;
  };

  // Group by book so a title's branches stay together: a book is listed when
  // any one of its branches qualifies, and then every branch is shown, which
  // is what makes a row readable — a gap at one campus usually only means
  // something next to what the other two are doing.
  const groups = new Map();
  rows.forEach(r => {
    if (search && !(r.title.toLowerCase().includes(search) || r.isbn.toLowerCase().includes(search))) return;
    if (!groups.has(r.isbn)) groups.set(r.isbn, { title: r.title, rows: [], hit: false });
    const g = groups.get(r.isbn);
    g.rows.push(r);
    if (qualifies(r)) g.hit = true;
  });
  const order = { IRV: 0, LA: 1, RH: 2 };
  const shown = [...groups.values()].filter(g => g.hit);
  shown.forEach(g => g.rows.sort((a, b) => order[a.branch] - order[b.branch]));
  // Worst offenders first, so the biggest gaps stay at the top of the page.
  shown.sort((a, b) =>
    Math.max(...b.rows.map(r => Math.abs(r.diff || 0))) - Math.max(...a.rows.map(r => Math.abs(r.diff || 0))) ||
    a.title.localeCompare(b.title));

  const withBase = rows.filter(r => r.base !== null);
  const mismatched = withBase.filter(r => r.diff !== 0);
  const negative = withBase.filter(r => r.calc < 0);

  const cell = (v, style) => `<td class="ta-r" style="${style || ''}">${v === null ? '<span style="color:#cbd5e1;">—</span>' : v}</td>`;
  const body = shown.length === 0
    ? '<tr><td colspan="9" class="empty-state">No rows match.</td></tr>'
    : shown.map(g => g.rows.map((r, i) => {
        const d = r.diff;
        const top = i === 0 ? 'border-top:2px solid #e2e8f0;' : '';
        // Dim the cells rather than the row: the title spans the whole group,
        // so a faded first row would fade the title for every branch under it.
        const dim = qualifies(r) ? '' : 'opacity:.5;';
        const dCol = dim ? '' : d === null ? '' : d === 0 ? 'color:#16a34a;' : 'color:#dc2626;font-weight:600;';
        return `<tr>
          ${i === 0 ? `<td rowspan="${g.rows.length}" style="${top}vertical-align:middle;">${escHtml(g.title)}</td>` : ''}
          <td style="${top}${dim}">${escHtml(r.branch)}</td>
          ${cell(r.base, top + dim)}${cell(r.tx, top + dim)}${cell(r.calc, top + dim)}
          <td class="ta-r" style="${top}${dim}"${r.postTx ? ` title="${RECON_SNAPSHOT_DATE} PDF ${r.snap === null ? 0 : r.snap} ${r.postTx > 0 ? '+' : '−'} ${Math.abs(r.postTx)} recorded after"` : ''}>${r.rolled}${r.postTx ? '<span style="color:#94a3b8;font-size:11px;"> *</span>' : ''}</td>
          <td class="ta-r" style="${top}${dim}${dCol}">${d === null ? '<span style="color:#cbd5e1;">—</span>' : (d > 0 ? '+' + d : d)}</td>
          ${cell(r.live, top + dim)}
        </tr>`;
      }).join('')).join('');

  const orphanTotal = rows._orphans.reduce((a, o) => a + o.stock, 0);
  const stamps = reconTx.map(t => t.ts).sort();
  const postCount = reconTx.filter(t => t.ts > RECON_SNAPSHOT_CUTOFF).length;
  const notes = [
    `Transaction coverage: <strong>${rows._countedTx}</strong> of ${rows._totalTx} stock movements applied to the baseline, and <strong>${postCount}</strong> applied on top of the PDF. Both sides are open-ended at the top, so everything up to the latest record (${stamps[stamps.length - 1]}) is included — this page re-reads Firestore on every page load.`,
    ...(reconTx.realigned ? [`<strong>${reconTx.realigned}</strong> movements were filed under a superseded ISBN and have been re-attached to the catalog book by title. Editing a book's ISBN does not rewrite its existing sales and restocks, so without this they would drop out of the count entirely.`] : []),
    `Baseline covers <strong>${withBase.length}</strong> of ${rows.length} branch/book rows — the spreadsheet only tracks the course books, so the rest have no 3/30 starting count.`,
    `<strong>${mismatched.length}</strong> of ${withBase.length} rows with a baseline disagree; <strong>${negative.length}</strong> compute to a negative stock, which is impossible.`,
    `Negative results mean the Firestore log is missing inbound stock: the April restocks recorded in the spreadsheet's Amazon / Cambridge / Pearson columns were never entered as stock-in records, and a one-off seeding script (<code>init_inventory.js</code>, since removed) overwrote stock levels directly without writing history.`,
    `<strong>${rows._orphans.length}</strong> inventory rows (${orphanTotal} units) are still filed under the old campus names "Irvine" / "Rowland Heights". The app never shows them; treating them as extra stock makes the match worse, so they look like pre-rename leftovers.`,
    ...(rows._skipped.length ? [`${rows._skipped.length} transaction(s) skipped as unusable: ${rows._skipped.join(', ')}.`] : []),
    ...RECON_SOURCE_NOTES
  ];

  const filters = [
    ['Mismatches', 'Books where at least one branch has a baseline and Calculated does not equal Rolled. These are the books whose two histories disagree — the working list.'],
    ['All rows', 'Every book/branch the reconciliation knows about, matching or not. Use it to confirm a book that looks fine really is fine.'],
    ['No baseline', 'Books with no 3/30 starting count, because the spreadsheet only tracks the course books. Calculated is blank for these, so they can never be checked against the PDF — they need a starting count entered before they mean anything.']
  ];
  const columns = [
    ['Title / Branch', 'The book, and the campus. A title\'s three branches are always shown together; branches that do not match the current filter are dimmed.'],
    [`Base ${RECON_BASELINE_DATE.slice(5)}`, `Starting count from the "3/30/26" column of the branch Inventory sheet. Blank means the spreadsheet has no row for this book at this branch.`],
    ['All tx', 'Net of every recorded stock movement counted against the baseline: sales and stock-outs subtract, stock-ins and incoming transfers add.'],
    ['Calculated', 'Base + All tx. What the stock should be today if the transaction log were complete.'],
    ['Rolled', `The ${RECON_SNAPSHOT_DATE} PDF backup — an independent hand-taken snapshot — plus any movements recorded after it, so it lands on today. The same "stock today" figure, arrived at from the other direction. A <span style="color:#94a3b8;">*</span> marks the rows where something was recorded after the PDF; hover for the breakdown.`],
    ['Diff', 'Calculated − Rolled. Zero is green. A negative number means the calculation is short — the size of the inbound stock still missing from the transaction log.'],
    ['Live', 'What the app currently shows on the Inventory tab. Blank means no inventory row exists for this book at this branch.']
  ];
  const dl = pairs => pairs.map(([t, d]) =>
    `<div style="display:flex;gap:10px;padding:5px 0;border-top:1px solid #f1f5f9;">
       <div style="flex:0 0 128px;font-weight:600;color:#334155;">${t}</div>
       <div style="flex:1;">${d}</div>
     </div>`).join('');

  document.getElementById('recon-body').innerHTML = `
    <div class="card" style="padding:12px 16px;margin-bottom:12px;">
      <div style="font-size:13px;color:#475569;line-height:1.7;">
        <strong>Calculated</strong> = ${RECON_BASELINE_DATE} spreadsheet baseline + all recorded transactions.<br>
        <strong>Rolled</strong> = ${RECON_SNAPSHOT_DATE} PDF snapshot + transactions after that date.<br>
        <strong>Diff</strong> = Calculated − Rolled. Nothing on this page writes to the database.
      </div>
      <details style="margin-top:10px;font-size:12.5px;color:#475569;line-height:1.6;">
        <summary style="cursor:pointer;font-weight:600;color:#334155;">What the filters and columns mean</summary>
        <div style="margin-top:8px;font-weight:600;color:#334155;">Filters</div>
        ${dl(filters)}
        <div style="margin-top:12px;font-weight:600;color:#334155;">Columns</div>
        ${dl(columns)}
      </details>
      <ul style="margin:10px 0 0;padding-left:18px;font-size:12.5px;color:#475569;line-height:1.8;">
        ${notes.map(n => '<li>' + n + '</li>').join('')}
      </ul>
    </div>
    <div class="card" style="padding:0;overflow:hidden;">
      <div class="tbl-wrap">
        <table>
          <thead>
            <tr>
              <th>Title</th><th>Branch</th>
              <th class="ta-r">Base ${RECON_BASELINE_DATE.slice(5)}</th><th class="ta-r">All tx</th><th class="ta-r">Calculated</th>
              <th class="ta-r">Rolled</th>
              <th class="ta-r">Diff</th><th class="ta-r">Live</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}
