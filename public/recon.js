// ==========================================
// RECON (temporary) — stock reconciliation worksheet
//
// Compares two independent reconstructions of today's stock:
//
//   Calculated = the 3/30/26 spreadsheet baseline + every Firestore
//                transaction (sales, stock_history, stock_out, transfers).
//   Rolled     = the 7/16/26 PDF backup + only the transactions recorded
//                after that snapshot, carried forward to today.
//
// Calculated is the figure being worked towards: as the movements missing from
// the log are entered it converges on Rolled. The table is read-only; the one
// thing that writes is "Set stock", further down.
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

// Hand-entered 3/30 counts, keyed "BRANCH|ISBN". They override the value read
// out of the spreadsheet, and supply one for the rows the spreadsheet never
// listed — which is the only way those rows ever get a Calculated.
let reconBaseEdits = null;
const reconBaseKey = (branch, isbn) => branch + '|' + isbn;
function reconBaseOf(branch, isbn) {
  const k = reconBaseKey(branch, isbn);
  const edit = reconBaseEdits ? reconBaseEdits[k] : undefined;
  return edit !== undefined ? edit : RECON_BASELINE[k];
}

async function loadReconBaseEdits() {
  const snap = await db.collection('recon_baseline').get();
  const out = {};
  snap.docs.forEach(d => {
    const r = d.data();
    if (typeof r.base === 'number') out[reconBaseKey(r.branch, r.isbn)] = r.base;
  });
  return out;
}

// Called by invalidateHistCache() after any stock write, so a sale or restock
// entered in this page session is picked up the next time the tab is drawn.
window.invalidateReconCache = function () { reconTx = null; };

async function renderRecon() {
  const el = document.getElementById('recon-body');
  if (currentRole !== 'manager') {
    el.innerHTML = '<div class="empty-state">Managers only.</div>';
    return;
  }
  if (!reconTx || !reconBaseEdits) {
    el.innerHTML = '<div class="empty-state">Loading transactions…</div>';
    try {
      if (!reconBaseEdits) reconBaseEdits = await loadReconBaseEdits();
      if (!reconTx) reconTx = await loadReconTx();
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
// Fetched once and reused until a stock write invalidates the cache.
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
  // Corrections written by "Set stock" are excluded from both
  // sides: they adjust the record to match a count, they are not a movement
  // of books, and counting a correction inside the comparison that produced
  // it would just chase its own tail.
  inSnap.docs.forEach(d => {
    const r = d.data();
    if (r.reconAdjustment) return;
    const t = dateOf(d, r, 'createdAt', 'stock-in');
    if (t) push(t, r.branch, r.isbn, r.title, Number(r.quantity) || 0);
  });
  outSnap.docs.forEach(d => {
    const r = d.data();
    if (r.reconAdjustment) return;
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
  // the baseline, and only what happened after the PDF snapshot. The baseline
  // is the count as the 3/30 column stood, so anything recorded that day
  // counts as movement on top of it, same as any later date.
  const all = {}, post = {};
  let countedTx = 0;
  reconTx.forEach(t => {
    const k = t.branch + '|' + t.isbn;
    all[k] = (all[k] || 0) + t.qty;
    countedTx++;
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
      const base = reconBaseOf(br, b.isbn);
      const hasBase = base !== undefined;
      const snap = RECON_SNAPSHOT[k];
      const tx = all[k] || 0, postTx = post[k] || 0;
      const liveQty = live[k];
      const calc = hasBase ? base + tx : null;
      const rolled = (snap || 0) + postTx;
      rows.push({
        isbn: b.isbn, title: b.title, branch: br,
        base: hasBase ? base : null, baseEdited: reconBaseEdits[k] !== undefined, tx, calc,
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

// ==========================================
// SET STOCK
//
// Calculated is the figure being worked towards: the 3/30 count plus every
// movement on record. As the missing movements go in it converges on Rolled,
// and once a row's two figures agree that value is the one to put into stock.
// Rows that never quite agree still get Calculated, to be corrected by hand
// afterwards, with Rolled shown alongside so it is clear which had settled.
//
// Rows with no baseline and nothing ever recorded are a different case: there
// is nothing to reconcile and the 7/16 hand count is the only figure in
// existence, so they simply take it. Rows with movements but no baseline stay
// out — neither route reaches a figure for those.
//
// Each change is written as a normal stock adjustment rather than a silent
// overwrite of the number, because a stock level that moves with no record of
// why is what broke the history in the first place. The adjustments carry
// reconAdjustment:true so the comparison above keeps measuring the same thing
// afterwards.
// ==========================================
// What stock currently holds does not enter into this. Those numbers were
// forced to match by hand at various points, so agreeing with one proves
// nothing; every row with a usable figure is written, and the ones that
// already hold it simply do not move.
function reconApplyPlan() {
  const plan = [], skipped = { noBaseline: [], negative: [] };
  (reconRows || []).forEach(r => {
    let target = null, source = null;
    if (r.calc !== null) {
      // A negative Calculated means movements are still missing; stock can
      // never be negative, so those rows wait rather than being written.
      if (r.calc < 0) { skipped.negative.push(r); return; }
      target = r.calc; source = 'Calculated';
    } else if (r.tx === 0) {
      // No 3/30 starting count and nothing ever recorded: there is nothing to
      // reconcile, and the 7/16 hand count is the only figure there is. Take it.
      target = r.rolled; source = 'PDF count';
    } else {
      // Movements are on record but the starting count is not, so today's
      // figure cannot be derived either way. These need a baseline first.
      skipped.noBaseline.push(r); return;
    }
    const current = r.live === null ? 0 : r.live;
    const row = inventory.find(x => x.isbn === r.isbn && x.branch === r.branch);
    plan.push({ ...r, current, target, source, delta: target - current, docId: row ? row.id : null });
  });
  plan.sort((a, b) => a.title.localeCompare(b.title) || a.branch.localeCompare(b.branch));
  plan.skipped = skipped;
  return plan;
}

// One click, one prompt, one write. The table above is the review step -- a
// second on-screen list of the same rows only invited comparing two counts
// that answer different questions.
async function applyReconStock() {
  const plan = reconApplyPlan();
  const sk = plan.skipped;
  if (!plan.length) { showToast('Nothing can be set yet — no row has a usable figure.'); return; }
  const fromCalc = plan.filter(p => p.source === 'Calculated').length;
  const held = sk.negative.length + sk.noBaseline.length;
  if (!confirm(
      `Set stock for ${plan.length} book/branch row(s)?

`
      + `${fromCalc} take their Calculated figure`
      + (plan.length - fromCalc ? `, and ${plan.length - fromCalc} with no baseline take the ${RECON_SNAPSHOT_DATE} count` : '')
      + `.`
      + (held ? `

${held} row(s) are left alone: ${sk.negative.length} with a Calculated below zero, ${sk.noBaseline.length} with movements but no ${RECON_BASELINE_DATE} count.` : '')
      + `

Each change is recorded as a stock adjustment.`)) return;
  await writeReconStock(plan);
}

async function writeReconStock(plan) {
  const stamp = nowLA();
  const by = currentUser ? currentUser.email : '';
  // Rows that already hold their figure need no adjustment record; writing a
  // zero-quantity one would only add noise to the history.
  const moves = plan.filter(p => p.delta !== 0);
  try {
    for (let i = 0; i < moves.length; i += 200) {
      const batch = db.batch();
      moves.slice(i, i + 200).forEach(p => {
        const doc = { isbn: p.isbn, title: p.title, branch: p.branch, quantity: Math.abs(p.delta),
          note: p.source === 'Calculated'
            ? `Reconciled to the calculated figure (${RECON_BASELINE_DATE} count plus recorded movements)`
            : `Set from the ${RECON_SNAPSHOT_DATE} count (no baseline, nothing on record)`,
          createdAt: stamp, createdBy: by, reconAdjustment: true };
        if (p.delta > 0) doc.orderSource = '';
        batch.set(db.collection(p.delta > 0 ? 'stock_history' : 'stock_out').doc(), doc);
        if (p.docId) batch.update(db.collection('inventory').doc(p.docId),
          { stock: firebase.firestore.FieldValue.increment(p.delta) });
        else batch.set(db.collection('inventory').doc(),
          { isbn: p.isbn, title: p.title, branch: p.branch, stock: p.target });
      });
      await batch.commit();
    }
    await loadInventory();
    invalidateHistCache();
    showToast(`Stock set for ${plan.length} row(s)${moves.length === plan.length ? '' : ` (${moves.length} changed)`}.`, 'ok');
    await renderRecon();
    if (currentTab === 'inventory') renderInventory();
  } catch (e) {
    console.error(e);
    showToast('Error applying stock changes.', 'error');
  }
}

// Drop every hand-entered baseline and go back to the spreadsheet throughout.
// A single row is reverted by clearing its box; this is for starting over.
async function resetReconBaseEdits() {
  const keys = Object.keys(reconBaseEdits || {});
  if (!keys.length) { showToast('No hand-entered baselines to reset.'); return; }
  if (!confirm(`Discard ${keys.length} hand-entered baseline(s) and go back to the spreadsheet figures?`)) return;
  try {
    const snap = await db.collection('recon_baseline').get();
    for (let i = 0; i < snap.docs.length; i += 300) {
      const batch = db.batch();
      snap.docs.slice(i, i + 300).forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
    reconBaseEdits = {};
    reconRows = buildReconRows();
    drawRecon();
    showToast(`${keys.length} baseline(s) reset.`, 'ok');
  } catch (e) {
    console.error(e);
    showToast('Could not reset the baselines.', 'error');
  }
}

// Writing the baseline back so it survives a reload and reaches everyone else.
// Clearing the box removes the override rather than storing a blank, so the
// spreadsheet value comes back if there was one. Typing the figure the
// spreadsheet already holds does the same: it is agreement, not a correction,
// and storing it would mark the row amber as though it had been overruled.
async function setReconBase(branch, isbn, raw) {
  const k = reconBaseKey(branch, isbn);
  const txt = String(raw).trim();
  const docId = branch + '__' + isbn;
  const n = txt === '' ? null : Math.round(Number(txt));
  if (n !== null && !Number.isFinite(n)) { showToast('Enter a whole number.', 'error'); drawRecon(); return; }
  try {
    if (n === null || n === RECON_BASELINE[k]) {
      await db.collection('recon_baseline').doc(docId).delete();
      delete reconBaseEdits[k];
    } else {
      await db.collection('recon_baseline').doc(docId).set({
        branch, isbn, base: n,
        updatedAt: nowLA(), updatedBy: currentUser ? currentUser.email : ''
      });
      reconBaseEdits[k] = n;
    }
    reconRows = buildReconRows();
    drawRecon();
  } catch (e) {
    console.error(e);
    showToast('Could not save that baseline.', 'error');
    drawRecon();
  }
}

function drawRecon() {
  const rows = reconRows;
  const search = (document.getElementById('recon-search').value || '').trim().toLowerCase();
  // Anything not settled: Calculated disagreeing with Rolled, or no baseline at
  // all so there is nothing to compare. A null diff is not zero, so both fall
  // out of the same test. Rows already at zero are done and drop off the list.
  const qualifies = r => r.diff !== 0;

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
    ? '<tr><td colspan="8" class="empty-state">No rows match.</td></tr>'
    : shown.map(g => g.rows.map((r, i) => {
        const d = r.diff;
        const top = i === 0 ? 'border-top:2px solid #e2e8f0;' : '';
        // Dim the cells rather than the row: the title spans the whole group,
        // so a faded first row would fade the title for every branch under it.
        const dim = qualifies(r) ? '' : 'opacity:.5;';
        // A row that balances is done; lock its baseline so a stray keystroke
        // cannot undo it. Recording a movement reopens it on its own.
        const settled = r.diff === 0;
        const dCol = dim ? '' : d === null ? '' : d === 0 ? 'color:#16a34a;' : 'color:#dc2626;font-weight:600;';
        return `<tr>
          ${i === 0 ? `<td rowspan="${g.rows.length}" style="${top}vertical-align:middle;">${escHtml(g.title)}</td>` : ''}
          <td style="${top}${dim}">${escHtml(r.branch)}</td>
          <td class="ta-r" style="${top}${dim}padding:2px 4px;">
            <input type="number" value="${r.base === null ? '' : r.base}" placeholder="—"
              ${settled ? 'disabled' : `onchange="setReconBase('${escHtml(r.branch)}','${escHtml(r.isbn)}',this.value)"`}
              title="${settled
                ? 'Settled at Diff 0 — locked. It unlocks again if a movement puts the row back out of balance.'
                : r.baseEdited ? 'Entered by hand — clear the box to go back to the spreadsheet'
                : 'Starting count on ' + RECON_BASELINE_DATE}"
              style="width:62px;text-align:right;font:inherit;font-size:12px;padding:2px 4px;border:1px solid ${settled ? '#e2e8f0' : r.baseEdited ? '#f59e0b' : '#e2e8f0'};border-radius:4px;background:${settled ? '#f8fafc' : r.baseEdited ? '#fffbeb' : '#fff'};${settled ? 'color:#94a3b8;cursor:not-allowed;' : ''}">
          </td>
          ${cell(r.tx, top + dim)}${cell(r.calc, top + dim)}
          <td class="ta-r" style="${top}${dim}"${r.postTx ? ` title="${RECON_SNAPSHOT_DATE} PDF ${r.snap === null ? 0 : r.snap} ${r.postTx > 0 ? '+' : '−'} ${Math.abs(r.postTx)} recorded after"` : ''}>${r.rolled}${r.postTx ? '<span style="color:#94a3b8;font-size:11px;"> *</span>' : ''}</td>
          <td class="ta-r" style="${top}${dim}${dCol}">${d === null ? '<span style="color:#cbd5e1;">—</span>' : (d > 0 ? '+' + d : d)}</td>
        </tr>`;
      }).join('')).join('');

  const orphanTotal = rows._orphans.reduce((a, o) => a + o.stock, 0);
  const stamps = reconTx.map(t => t.ts).sort();
  const postCount = reconTx.filter(t => t.ts > RECON_SNAPSHOT_CUTOFF).length;
  const notes = [
    `Transaction coverage: all <strong>${rows._countedTx}</strong> recorded stock movements are applied to the baseline, <strong>${postCount}</strong> of them on top of the PDF as well. Neither side is capped, so everything up to the latest record (${stamps[stamps.length - 1]}) counts — and the tab re-reads Firestore whenever stock changes.`,
    ...(reconTx.realigned ? [`<strong>${reconTx.realigned}</strong> movements were filed under a superseded ISBN and have been re-attached to the catalog book by title. Editing a book's ISBN does not rewrite its existing sales and restocks, so without this they would drop out of the count entirely.`] : []),
    `Baseline covers <strong>${withBase.length}</strong> of ${rows.length} branch/book rows — the spreadsheet only tracks the course books, so the rest have no 3/30 starting count.`,
    `<strong>${mismatched.length}</strong> of ${withBase.length} rows with a baseline disagree; <strong>${negative.length}</strong> compute to a negative stock, which is impossible.`,
    `Negative results mean the Firestore log is missing inbound stock: the April restocks recorded in the spreadsheet's Amazon / Cambridge / Pearson columns were never entered as stock-in records, and a one-off seeding script (<code>init_inventory.js</code>, since removed) overwrote stock levels directly without writing history.`,
    `<strong>${rows._orphans.length}</strong> inventory rows (${orphanTotal} units) are still filed under the old campus names "Irvine" / "Rowland Heights". The app never shows them; treating them as extra stock makes the match worse, so they look like pre-rename leftovers.`,
    ...(rows._skipped.length ? [`${rows._skipped.length} transaction(s) skipped as unusable: ${rows._skipped.join(', ')}.`] : []),
    ...RECON_SOURCE_NOTES
  ];

  const columns = [
    ['Title / Branch', 'The book, and the campus. A title\'s three branches are always shown together; a branch already settled at Diff 0 is dimmed.'],
    [`Base ${RECON_BASELINE_DATE.slice(5)}`, `Starting count from the "3/30/26" column of the branch Inventory sheet. Type into the box to correct it, or to supply one where the spreadsheet has no row — that is what gives a row a Calculated at all. Hand-entered values are shown amber; clearing the box drops back to the spreadsheet. Rows already balancing at Diff 0 are locked, and unlock again if a movement puts them back out of balance.`],
    ['All tx', `Net of every recorded stock movement, including any dated ${RECON_BASELINE_DATE} itself: sales and stock-outs subtract, stock-ins and incoming transfers add.`],
    ['Calculated', 'Base + All tx. What the stock should be today if the transaction log were complete.'],
    ['Rolled', `The ${RECON_SNAPSHOT_DATE} PDF backup — an independent hand-taken snapshot — plus any movements recorded after it, so it lands on today. The same "stock today" figure, arrived at from the other direction. A <span style="color:#94a3b8;">*</span> marks the rows where something was recorded after the PDF; hover for the breakdown.`],
    ['Diff', 'Calculated − Rolled. Zero is green. A negative number means the calculation is short — the size of the inbound stock still missing from the transaction log.']
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
        <strong>Diff</strong> = Calculated − Rolled. Rows already settled at Diff 0 are dimmed; everything else is outstanding.
      </div>
      <details style="margin-top:10px;font-size:12.5px;color:#475569;line-height:1.6;">
        <summary style="cursor:pointer;font-weight:600;color:#334155;">What the columns mean</summary>
        <div style="margin-top:8px;">${dl(columns)}</div>
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
              <th class="ta-r" title="Editable — type a starting count, clear the box to drop back to the spreadsheet">Base ${RECON_BASELINE_DATE.slice(5)}</th><th class="ta-r">All tx</th><th class="ta-r">Calculated</th>
              <th class="ta-r">Rolled</th>
              <th class="ta-r">Diff</th>
            </tr>
          </thead>
          <tbody>${body}</tbody>
        </table>
      </div>
    </div>`;
}
