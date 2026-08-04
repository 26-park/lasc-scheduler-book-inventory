const BRANCHES = ['IRV', 'LA', 'RH'];
const BRANCH_FULL = { LA: 'LA', RH: 'Rowland Heights', IRV: 'Irvine' };
const QUARTERS = ['Winter', 'Spring', 'Summer', 'Fall'];

// State
let books = [], inventory = [], pendingOrders = [], usersData = [];
let currentTab = 'inventory', currentHistTab = 'sales';
let currentBranch = 'LA';
let editingBookIsbn = null, receivingOrderId = null;
let historyData = [];
let currentUser = null, currentRole = null;
let asOfMode = false, asOfLabel = '', asOfStockMap = null;

function getQuarter(dateStr) {
  const m = parseInt((dateStr || '').substring(5,7), 10);
  if (m <= 3) return 'Winter'; if (m <= 6) return 'Spring';
  if (m <= 9) return 'Summer'; return 'Fall';
}

function fmtMoney(v) { return '$' + Number(v||0).toFixed(2); }
function fmtDate(s) { if(!s) return ''; const p=s.substring(0,10).split('-'); if(p.length<3) return s.substring(0,10); return `${p[1].padStart(2,'0')}/${p[2].padStart(2,'0')}/${p[0]}`; }
function fmtDateTime(s) { if(!s) return ''; const time = s.substring(11,16); return fmtDate(s) + (time ? ' ' + time : ''); }
function nowLA() {
  return new Date().toLocaleString('sv-SE', {timeZone:'America/Los_Angeles'}).replace('T',' ').substring(0,16);
}

// ==========================================
// DATA LOADING
// ==========================================
async function loadAll() {
  await Promise.all([loadBooks(), loadInventory(), loadPendingOrders()]);
  renderCurrentTab();
  populateBookSelects();
}

async function loadBooks() {
  const snap = await db.collection('books').orderBy('title').get();
  books = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadInventory() {
  const snap = await db.collection('inventory').get();
  inventory = snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function loadPendingOrders() {
  const snap = await db.collection('pending_orders').orderBy('orderedAt','desc').get();
  pendingOrders = snap.docs.map(d => ({ ...d.data(), id: d.id }));
}

function getStock(isbn, branch) {
  const row = inventory.find(r => r.isbn === isbn && r.branch === branch);
  return row ? (Number(row.stock) || 0) : 0;
}

function getPending(isbn, branch) {
  return pendingOrders
    .filter(o => o.isbn === isbn && o.branch === branch && o.status === 'pending')
    .reduce((s, o) => s + Number(o.quantity), 0);
}

// Queue a stock change on a write batch. Uses a server-side increment so
// concurrent writes from other users/stale tabs never overwrite each other.
// Returns a function that syncs the local cache; call it after commit succeeds.
function batchStockUpdate(batch, isbn, title, branch, delta) {
  const existing = inventory.find(r => r.isbn === isbn && r.branch === branch);
  if (existing) {
    batch.update(db.collection('inventory').doc(existing.id),
      { stock: firebase.firestore.FieldValue.increment(delta) });
    return () => { existing.stock = (Number(existing.stock) || 0) + delta; };
  }
  const ref = db.collection('inventory').doc();
  const stock = Math.max(0, delta);
  batch.set(ref, { isbn, title, branch, stock });
  return () => { inventory.push({ id: ref.id, isbn, title, branch, stock }); };
}

async function updateStock(isbn, title, branch, delta) {
  const batch = db.batch();
  const applyLocal = batchStockUpdate(batch, isbn, title, branch, delta);
  await batch.commit();
  applyLocal();
  invalidateHistCache();
}

// ==========================================
// NAVIGATION
// ==========================================
function switchTab(tab) {
  document.querySelectorAll('.nav-tab').forEach(b => b.classList.remove('active'));
  const tabBtn = document.querySelector(`.nav-tab[onclick="switchTab('${tab}')"]`);
  if (tabBtn) tabBtn.classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.getElementById('view-' + tab).classList.add('active');
  currentTab = tab;
  localStorage.setItem('inventory_tab', tab);
  // Entering History used to drop the cache every time, refetching four
  // collections on each visit. In-session writes already invalidate it, so the
  // only reason to refetch on entry is to catch another device's changes —
  // do that on a staleness window instead of on every tab switch.
  if (tab === 'history' && Date.now() - _histCacheAt > HIST_STALE_MS) invalidateHistCache();
  renderCurrentTab();
}

function renderCurrentTab() {
  if (currentTab === 'inventory') renderInventory();
  else if (currentTab === 'orders') renderOrders();
  else if (currentTab === 'history') loadHistory();
  else if (currentTab === 'books') renderBooks();
  else if (currentTab === 'users') loadUsers();
}

function setBranch(b) {
  currentBranch = b;
  localStorage.setItem('inventory_branch', b);
  document.querySelectorAll('.branch-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.branch === b);
  });
  document.querySelectorAll('#sell-branch, #ord-branch').forEach(sel => {
    if (b !== 'ALL') sel.value = b;
  });
  if (b !== 'ALL') updateSellBookInfo();
  renderCurrentTab();
}

// ==========================================
// INVENTORY VIEW
// ==========================================
function renderInventory() {
  const search = (document.getElementById('inv-search').value || '').toLowerCase();
  const isAll = currentBranch === 'ALL';
  const isMgr = currentRole === 'manager';

  const stockOf = (isbn, branch) => asOfMode ? (asOfStockMap[isbn + '|' + branch] || 0) : getStock(isbn, branch);
  const inStockOnly = document.getElementById('inv-instock-only')?.checked !== false;

  let rows = books.filter(b => {
    if (search && !b.title.toLowerCase().includes(search) && !b.isbn.includes(search)) return false;
    if (inStockOnly) {
      const hasStock = isAll ? BRANCHES.some(br => stockOf(b.isbn, br) > 0) : stockOf(b.isbn, currentBranch) > 0;
      if (!hasStock) return false;
    }
    return true;
  });

  const costTh = isMgr ? `<th class="ta-r">Cost</th>` : '';
  const costTd = b => isMgr ? `<td class="ta-r">${fmtMoney(b.costPrice)}</td>` : '';

  if (isAll) {
    document.getElementById('inv-thead-row').innerHTML =
      `<th>ISBN</th><th>Title</th>${costTh}<th class="ta-r">Price</th>` +
      BRANCHES.map(br => `<th class="ta-r">${br}</th>`).join('') +
      `<th class="ta-r">Total</th>`;
  } else {
    document.getElementById('inv-thead-row').innerHTML =
      `<th>ISBN</th><th>Title</th>${costTh}<th class="ta-r">Price</th>` +
      `<th class="ta-r">Stock</th>` +
      (!asOfMode ? `<th></th>` : '');
  }

  const colCount = isAll ? (isMgr ? 8 : 7) : ((isMgr ? 5 : 4) + (asOfMode ? 0 : 1));

  if (!rows.length) {
    document.getElementById('inv-tbody').innerHTML = `<tr><td colspan="${colCount}" class="empty-state">No books in stock.</td></tr>`;
    return;
  }

  let html = '';
  rows.forEach(book => {
    let branchCells = '';
    let rowStock = 0;
    if (isAll) {
      const stocks = BRANCHES.map(br => stockOf(book.isbn, br));
      const pendings = BRANCHES.map(br => asOfMode ? 0 : getPending(book.isbn, br));
      const total = stocks.reduce((a, b) => a + b, 0);
      BRANCHES.forEach((br, i) => {
        const s = stocks[i], p = pendings[i];
        const cls = s === 0 ? 'stock-0' : (s <= 2 ? 'stock-low' : '');
        branchCells += `<td class="ta-r"><span class="${cls}">${s}</span>${p > 0 ? ` <span class="pending-badge">(+${p})</span>` : ''}</td>`;
      });
      branchCells += `<td class="ta-r" style="font-weight:600;">${total}</td>`;
    } else {
      const s = stockOf(book.isbn, currentBranch);
      rowStock = s;
      const p = asOfMode ? 0 : getPending(book.isbn, currentBranch);
      const cls = s === 0 ? 'stock-0' : (s <= 2 ? 'stock-low' : '');
      branchCells = `<td class="ta-r"><span class="${cls}">${s}</span>${p > 0 ? ` <span class="pending-badge">(+${p})</span>` : ''}</td>`;
    }

    const actionCell = (!isAll && !asOfMode)
      ? `<td style="padding:4px 8px;"><div style="display:flex;gap:4px;">
          <button class="btn btn-primary btn-xs" onclick="startSell('${esc(book.isbn)}')" ${rowStock === 0 ? 'disabled' : ''}>Sell</button>
          <button class="btn btn-secondary btn-xs manager-only" onclick="openAdjustModal('${esc(book.isbn)}')">Adjust</button>
          <button class="btn btn-secondary btn-xs manager-only" onclick="openTransferModal('${esc(book.isbn)}')">Transfer</button>
          <button class="btn btn-secondary btn-xs manager-only" onclick="openTeacherCopyModal('${esc(book.isbn)}')" ${rowStock === 0 ? 'disabled' : ''}>Teacher</button>
        </div></td>`
      : '';

    html += `<tr>
      <td class="td-dim">${esc(book.isbn)}</td>
      <td>${esc(book.title)}</td>
      ${costTd(book)}
      <td class="ta-r">${fmtMoney(book.sellingPrice)}</td>
      ${branchCells}
      ${actionCell}
    </tr>`;
  });
  document.getElementById('inv-tbody').innerHTML = html;
}

function toggleInStockOnly() {
  const on = document.getElementById('inv-instock-only').checked;
  localStorage.setItem('inv_instock_only', on ? '1' : '0');
  renderInventory();
}

// ==========================================
// PAST STOCK (as-of historical view)
// ==========================================
function toggleAsOfControls() {
  const el = document.getElementById('asof-controls');
  const show = el.style.display === 'none';
  el.style.display = show ? '' : 'none';
  // Leaving the panel while a past view is active returns to current stock.
  if (!show && asOfMode) resetAsOf();
}
// Reconstruct stock at a past point in time by starting from current stock
// and reversing every transaction that happened AFTER the chosen moment.
async function applyAsOf() {
  const val = document.getElementById('inv-asof').value; // YYYY-MM-DDTHH:MM
  if (!val) { showToast('Pick a date and time first.', 'error'); return; }
  const asOf = val.replace('T', ' ').substring(0, 16);
  try {
    await computeAsOfStock(asOf);
    asOfMode = true;
    asOfLabel = asOf;
    document.getElementById('inv-asof-reset').style.display = '';
    updateAsOfBanner();
    renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error loading past stock.', 'error');
  }
}

function resetAsOf() {
  asOfMode = false;
  asOfStockMap = null;
  document.getElementById('inv-asof-reset').style.display = 'none';
  updateAsOfBanner();
  renderInventory();
}

function updateAsOfBanner() {
  const el = document.getElementById('inv-asof-banner');
  if (asOfMode) {
    el.textContent = `Showing stock as of ${fmtDate(asOfLabel.substring(0,10))} ${asOfLabel.substring(11,16)} — read only (pending orders not shown)`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

async function computeAsOfStock(asOf) {
  const map = {};
  inventory.forEach(r => { map[r.isbn + '|' + r.branch] = (Number(r.stock) || 0); });
  const adj = (isbn, branch, qty) => {
    if (!isbn || !branch) return;
    const k = isbn + '|' + branch;
    map[k] = (map[k] || 0) + qty;
  };

  const [salesSnap, inSnap, outSnap, trSnap] = await Promise.all([
    db.collection('sales').orderBy('soldAt', 'desc').limit(5000).get(),
    db.collection('stock_history').orderBy('createdAt', 'desc').limit(5000).get(),
    db.collection('stock_out').orderBy('createdAt', 'desc').limit(5000).get(),
    db.collection('transfers').orderBy('createdAt', 'desc').limit(5000).get()
  ]);

  // Reverse only transactions that occurred strictly after the chosen moment.
  salesSnap.docs.forEach(d => {
    const r = d.data();
    if ((r.soldAt || '').substring(0, 16) > asOf) adj(r.isbn, r.branch, Number(r.quantity) || 0); // sale removed stock -> add back
  });
  inSnap.docs.forEach(d => {
    const r = d.data();
    if ((r.createdAt || '').substring(0, 16) > asOf) adj(r.isbn, r.branch, -(Number(r.quantity) || 0)); // restock added -> remove
  });
  outSnap.docs.forEach(d => {
    const r = d.data();
    if ((r.createdAt || '').substring(0, 16) > asOf) adj(r.isbn, r.branch, Number(r.quantity) || 0); // stock-out removed -> add back
  });
  trSnap.docs.forEach(d => {
    const r = d.data();
    if ((r.createdAt || '').substring(0, 16) > asOf) {
      adj(r.isbn, r.fromBranch, Number(r.quantity) || 0); // from-branch lost stock -> add back
      adj(r.isbn, r.toBranch, -(Number(r.quantity) || 0)); // to-branch gained -> remove
    }
  });

  asOfStockMap = map;
}

// ==========================================
// BOOK SELECTS
// ==========================================
function populateBookSelects() {
  const opts = '<option value="">— select —</option>' +
    books.map(b => `<option value="${esc(b.isbn)}">${esc(b.title)} (${esc(b.isbn)})</option>`).join('');
  ['sell-isbn','ord-isbn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = opts;
  });
  populateYearFilter();
}

function populateYearFilter() {
  const yr = new Date().getFullYear();
  let opts = '<option value="ALL">All Years</option>';
  for (let y = yr; y >= yr - 3; y--) opts += `<option value="${y}">${y}</option>`;
  document.getElementById('hist-year').innerHTML = opts;
}

// ==========================================
// SELL (Cart-based)
// ==========================================
let cartItems = [];
let paymentRows = [];   // used only in split-payment mode
let splitMode = false;

// Jump from an inventory row straight into a sale with the book preselected.
function startSell(isbn) {
  switchTab('sell');
  if (currentBranch !== 'ALL') document.getElementById('sell-branch').value = currentBranch;
  document.getElementById('sell-isbn').value = isbn;
  updateSellBookInfo();
  const qtyEl = document.getElementById('sell-qty');
  qtyEl.value = '1';
  qtyEl.focus();
  qtyEl.select();
}

function toggleSplitPayment() {
  splitMode = !splitMode;
  document.getElementById('split-payment-section').style.display = splitMode ? '' : 'none';
  document.getElementById('split-toggle').textContent = splitMode ? 'Single payment' : 'Split payment…';
  document.getElementById('sell-payment-method').disabled = splitMode;
  if (splitMode && !paymentRows.length) {
    // Seed with the currently selected method for the full amount.
    addPaymentRow(document.getElementById('sell-payment-method').value);
  }
  if (!splitMode) { paymentRows = []; renderPaymentRows(); }
  updatePaymentSummary();
}

// Payment rows that will actually be saved with the sale.
function effectivePaymentRows() {
  if (splitMode) return paymentRows;
  const method = document.getElementById('sell-payment-method').value;
  const disc = parseFloat(document.getElementById('sell-discount').value) || 0;
  return [{ method, amount: Math.max(0, cartSubtotal() - disc) }];
}

function onSellBookChange() {
  updateSellBookInfo();
}

function onSellBranchChange() {
  updateSellBookInfo();
}

function updateSellBookInfo() {
  const isbn = document.getElementById('sell-isbn').value;
  const branch = document.getElementById('sell-branch').value;
  const book = books.find(b => b.isbn === isbn);
  const infoEl = document.getElementById('sell-book-info');
  if (book && branch) {
    const stock = getStock(isbn, branch);
    const inCart = (cartItems.find(i => i.isbn === isbn) || {qty: 0}).qty;
    const available = stock - inCart;
    const stockCls = available <= 0 ? 'color:#dc2626;font-weight:600;' : (available <= 2 ? 'color:#d97706;font-weight:600;' : 'color:#16a34a;');
    infoEl.innerHTML = `${esc(book.title)} — ${fmtMoney(book.sellingPrice)} each &nbsp;|&nbsp; <span style="${stockCls}">${branch} stock: ${available}</span>${inCart > 0 ? ` <span style="color:#888;">(${inCart} in cart)</span>` : ''}`;
    infoEl.style.display = '';
  } else {
    infoEl.style.display = 'none';
  }
}

function addToCart() {
  const isbn = document.getElementById('sell-isbn').value;
  const qty = parseInt(document.getElementById('sell-qty').value) || 0;
  const branch = document.getElementById('sell-branch').value;
  const book = books.find(b => b.isbn === isbn);
  if (!book) { showToast('Please select a book.', 'error'); return; }
  if (qty < 1) { showToast('Invalid quantity.', 'error'); return; }

  const stock = getStock(isbn, branch);
  const inCart = (cartItems.find(i => i.isbn === isbn) || {qty: 0}).qty;
  if (inCart + qty > stock) {
    showToast(`Not enough stock at ${branch}. Available: ${stock - inCart}`, 'error');
    return;
  }

  const existing = cartItems.find(i => i.isbn === isbn);
  if (existing) {
    existing.qty += qty;
  } else {
    cartItems.push({ isbn, title: book.title, qty, unitPrice: book.sellingPrice });
  }
  document.getElementById('sell-isbn').value = '';
  document.getElementById('sell-qty').value = '1';
  document.getElementById('sell-book-info').style.display = 'none';
  renderCart();
  updateCartTotal();
}

function removeFromCart(idx) {
  cartItems.splice(idx, 1);
  renderCart();
  updateCartTotal();
  if (!cartItems.length) { paymentRows = []; renderPaymentRows(); updatePaymentSummary(); }
}

function cartSubtotal() {
  return cartItems.reduce((s, i) => s + i.unitPrice * i.qty, 0);
}

function renderCart() {
  const tbody = document.getElementById('cart-tbody');
  const section = document.getElementById('cart-section');
  if (!cartItems.length) { section.style.display = 'none'; return; }
  section.style.display = '';
  tbody.innerHTML = cartItems.map((item, i) => `
    <tr>
      <td style="padding:5px 8px;">${esc(item.title)}</td>
      <td style="text-align:right;padding:5px 8px;">${item.qty}</td>
      <td style="text-align:right;padding:5px 8px;color:#888;">${fmtMoney(item.unitPrice)}</td>
      <td style="text-align:right;padding:5px 8px;font-weight:600;">${fmtMoney(item.unitPrice * item.qty)}</td>
      <td style="padding:5px 4px;">
        <button class="btn btn-danger btn-sm" onclick="removeFromCart(${i})">✕</button>
      </td>
    </tr>`).join('');
}

function updateCartTotal() {
  const disc = parseFloat(document.getElementById('sell-discount').value) || 0;
  const subtotal = cartSubtotal();
  const total = Math.max(0, subtotal - disc);
  const el = document.getElementById('cart-total-row');
  if (!cartItems.length) { el.textContent = ''; return; }
  if (disc > 0) {
    el.innerHTML = `Subtotal: ${fmtMoney(subtotal)} &nbsp;—&nbsp; Discount: ${fmtMoney(disc)} &nbsp;—&nbsp; <strong>Total: ${fmtMoney(total)}</strong>`;
  } else {
    el.innerHTML = `<strong>Total: ${fmtMoney(total)}</strong>`;
  }
  updatePaymentSummary();
}

function addPaymentRow(method) {
  const disc = parseFloat(document.getElementById('sell-discount').value) || 0;
  const total = Math.max(0, cartSubtotal() - disc);
  const alreadyPaid = paymentRows.reduce((s, r) => s + Number(r.amount), 0);
  const remaining = Math.max(0, total - alreadyPaid);
  paymentRows.push({ method, amount: remaining });
  renderPaymentRows();
  updatePaymentSummary();
}

function renderPaymentRows() {
  const cont = document.getElementById('payment-rows');
  if (!paymentRows.length) { cont.innerHTML = ''; return; }
  cont.innerHTML = paymentRows.map((row, i) => `
    <div class="payment-row">
      <div class="form-group"><label>${esc(row.method)}</label>
        <input type="number" value="${row.amount}" min="0" step="0.01"
          oninput="paymentRows[${i}].amount=parseFloat(this.value)||0;updatePaymentSummary()">
      </div>
      <button class="btn btn-danger btn-sm" onclick="removePaymentRow(${i})">✕</button>
    </div>`).join('');
}

function removePaymentRow(i) {
  paymentRows.splice(i, 1);
  renderPaymentRows();
  updatePaymentSummary();
}

function updatePaymentSummary() {
  const el = document.getElementById('sell-payment-summary');
  if (!cartItems.length) { el.textContent = ''; return; }
  const rows = effectivePaymentRows();
  if (!rows.length) { el.textContent = ''; return; }
  const disc = parseFloat(document.getElementById('sell-discount').value) || 0;
  const total = Math.max(0, cartSubtotal() - disc);
  const paid = rows.reduce((s, r) => s + Number(r.amount), 0);
  const diff = paid - total;
  let txt = rows.map(r => `${r.method}: ${fmtMoney(r.amount)}`).join(' + ');
  if (splitMode && Math.abs(diff) > 0.01) txt += ` (${diff > 0 ? 'Change: ' + fmtMoney(diff) : 'Short: ' + fmtMoney(-diff)})`;
  el.textContent = txt;
}

function resetSellForm() {
  cartItems = [];
  paymentRows = [];
  splitMode = false;
  document.getElementById('split-payment-section').style.display = 'none';
  document.getElementById('split-toggle').textContent = 'Split payment…';
  const paySel = document.getElementById('sell-payment-method');
  paySel.disabled = false;
  paySel.value = 'Cash';
  document.getElementById('sell-more').open = false;
  document.getElementById('sell-isbn').value = '';
  document.getElementById('sell-qty').value = '1';
  document.getElementById('sell-student').value = '';
  document.getElementById('sell-discount').value = '0';
  document.getElementById('sell-note').value = '';
  document.getElementById('sell-date').value = '';
  document.getElementById('sell-time').value = nowLA().substring(11,16);
  document.getElementById('sell-book-info').style.display = 'none';
  document.getElementById('cart-section').style.display = 'none';
  document.getElementById('cart-total-row').textContent = '';
  renderPaymentRows();
  document.getElementById('sell-warn').style.display = 'none';
  document.getElementById('sell-payment-summary').textContent = '';
}

async function processSell() {
  const branch = document.getElementById('sell-branch').value;
  const student = document.getElementById('sell-student').value.trim();
  const discount = parseFloat(document.getElementById('sell-discount').value) || 0;
  const note = document.getElementById('sell-note').value.trim();
  const warnEl = document.getElementById('sell-warn');

  if (!cartItems.length) { warnEl.textContent = 'Cart is empty.'; warnEl.style.display = ''; return; }
  const payRows = effectivePaymentRows();
  if (!payRows.length) { warnEl.textContent = 'Add at least one payment method.'; warnEl.style.display = ''; return; }

  for (const item of cartItems) {
    const current = getStock(item.isbn, branch);
    if (current < item.qty) {
      warnEl.textContent = `Insufficient stock for "${item.title}" at ${branch}. Current: ${current}`;
      warnEl.style.display = '';
      return;
    }
  }

  const subtotal = cartSubtotal();
  const paymentSummary = payRows.map(r => `${r.method}:$${r.amount}`).join(', ');
  const txnId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const sellDateVal = document.getElementById('sell-date').value;
  const sellTimeVal = document.getElementById('sell-time').value;
  const soldAt = sellDateVal ? sellDateVal + ' ' + (sellTimeVal || nowLA().substring(11,16)) : nowLA();

  try {
    // Single atomic batch: all stock decrements + sale records commit together,
    // so a mid-sale failure can never leave stock changed without a record.
    const batch = db.batch();
    const applyLocal = [];
    let discountRemaining = discount;
    for (const item of cartItems) {
      applyLocal.push(batchStockUpdate(batch, item.isbn, item.title, branch, -item.qty));
      const itemSubtotal = item.unitPrice * item.qty;
      const itemPaid = Math.max(0, itemSubtotal - discountRemaining);
      discountRemaining = 0;
      batch.set(db.collection('sales').doc(), {
        txnId, isbn: item.isbn, title: item.title, branch,
        quantity: item.qty, sellingPrice: itemSubtotal,
        discount: 0, txnDiscount: discount, totalPaid: itemPaid,
        student, paymentSummary, note, soldAt,
        createdBy: currentUser ? currentUser.email : ''
      });
    }
    await batch.commit();
    applyLocal.forEach(fn => fn());
    invalidateHistCache();
    const cartDesc = cartItems.length === 1
      ? `${cartItems[0].title} ×${cartItems[0].qty}`
      : `${cartItems.length} items`;
    const totalPaid = Math.max(0, subtotal - discount);
    showToast(`Sold: ${cartDesc} — ${fmtMoney(totalPaid)}`, 'ok');
    resetSellForm();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error processing sale.', 'error');
  }
}

// ==========================================
// STOCK ADJUST (replaces Stock In / Stock Out)
// ==========================================
let adjustModalIsbn = null, adjustModalBranch = null;

function openAdjustModal(isbn) {
  const book = books.find(b => b.isbn === isbn);
  if (!book) return;
  adjustModalIsbn = isbn;
  adjustModalBranch = currentBranch;
  const stock = getStock(isbn, currentBranch);
  document.getElementById('ma-book-info').textContent = `${book.title} — ${currentBranch}`;
  document.getElementById('ma-current').textContent = stock;
  document.getElementById('ma-delta').value = '';
  document.getElementById('ma-note').value = '';
  document.getElementById('ma-date').value = '';
  document.getElementById('ma-warn').style.display = 'none';
  document.getElementById('modal-adjust').classList.add('open');
}

function closeAdjustModal() {
  document.getElementById('modal-adjust').classList.remove('open');
  adjustModalIsbn = null;
  adjustModalBranch = null;
}

async function processAdjust() {
  const isbn = adjustModalIsbn;
  const branch = adjustModalBranch;
  const delta = parseInt(document.getElementById('ma-delta').value);
  const note = document.getElementById('ma-note').value.trim();
  const dateInput = document.getElementById('ma-date').value;
  const warnEl = document.getElementById('ma-warn');
  const warn = msg => { warnEl.textContent = msg; warnEl.style.display = ''; };

  if (!delta || delta === 0) return warn('Enter a non-zero adjustment amount.');

  const book = books.find(b => b.isbn === isbn);
  if (!book) return;

  // datetime-local gives "YYYY-MM-DDTHH:MM"; stored timestamps use a space.
  const createdAt = dateInput ? dateInput.replace('T', ' ') : nowLA();
  if (createdAt > nowLA()) return warn('That date is in the future.');

  if (delta < 0) {
    const current = getStock(isbn, branch);
    if (current + delta < 0) return warn(`Not enough stock at ${branch}. Current: ${current}`);
  }

  try {
    const batch = db.batch();
    const applyLocal = batchStockUpdate(batch, isbn, book.title, branch, delta);
    if (delta > 0) {
      batch.set(db.collection('stock_history').doc(), {
        isbn, title: book.title, branch, quantity: delta,
        note, orderSource: '', createdAt,
        createdBy: currentUser ? currentUser.email : ''
      });
    } else {
      batch.set(db.collection('stock_out').doc(), {
        isbn, title: book.title, branch, quantity: Math.abs(delta),
        note, createdAt,
        createdBy: currentUser ? currentUser.email : ''
      });
    }
    await batch.commit();
    applyLocal();
    invalidateHistCache();
    const when = dateInput ? ` (${createdAt})` : '';
    showToast(delta > 0
      ? `Restocked: ${book.title} +${delta} at ${branch}${when}`
      : `Removed: ${book.title} ${delta} at ${branch}${when}`, 'ok');
    closeAdjustModal();
    renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error adjusting stock.', 'error');
  }
}

// ==========================================
// TRANSFER
// ==========================================
function openTransferModal(isbn) {
  const opts = '<option value="">— select —</option>' +
    books.map(b => `<option value="${esc(b.isbn)}" ${b.isbn === isbn ? 'selected' : ''}>${esc(b.title)} (${esc(b.isbn)})</option>`).join('');
  document.getElementById('mt-isbn').innerHTML = opts;
  if (currentBranch !== 'ALL') {
    document.getElementById('mt-from').value = currentBranch;
    const toOptions = BRANCHES.filter(b => b !== currentBranch);
    document.getElementById('mt-to').value = toOptions[0];
  }
  document.getElementById('mt-qty').value = '1';
  document.getElementById('mt-note').value = '';
  document.getElementById('mt-warn').style.display = 'none';
  onTransferModalChange();
  document.getElementById('modal-transfer').classList.add('open');
}

function closeTransferModal() {
  document.getElementById('modal-transfer').classList.remove('open');
}

function onTransferModalChange() {
  const isbn = document.getElementById('mt-isbn').value;
  const branch = document.getElementById('mt-from').value;
  const el = document.getElementById('mt-stock-info');
  if (isbn && branch) {
    const s = getStock(isbn, branch);
    el.textContent = `Stock at ${branch}: ${s}`;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

async function processTransfer() {
  const isbn = document.getElementById('mt-isbn').value;
  const fromBranch = document.getElementById('mt-from').value;
  const toBranch = document.getElementById('mt-to').value;
  const qty = parseInt(document.getElementById('mt-qty').value);
  const note = document.getElementById('mt-note').value.trim();
  const warnEl = document.getElementById('mt-warn');

  if (fromBranch === toBranch) { warnEl.textContent = 'From and To branch must be different.'; warnEl.style.display = ''; return; }
  const book = books.find(b => b.isbn === isbn);
  if (!book) { warnEl.textContent = 'Please select a book.'; warnEl.style.display = ''; return; }
  if (!qty || qty < 1) { warnEl.textContent = 'Invalid quantity.'; warnEl.style.display = ''; return; }

  const current = getStock(isbn, fromBranch);
  if (current < qty) { warnEl.textContent = `Insufficient stock at ${fromBranch}. Current: ${current}`; warnEl.style.display = ''; return; }

  try {
    const batch = db.batch();
    const applyFrom = batchStockUpdate(batch, isbn, book.title, fromBranch, -qty);
    const applyTo = batchStockUpdate(batch, isbn, book.title, toBranch, qty);
    batch.set(db.collection('transfers').doc(), {
      isbn, title: book.title, fromBranch, toBranch, quantity: qty,
      note, createdAt: nowLA(),
      createdBy: currentUser ? currentUser.email : ''
    });
    await batch.commit();
    applyFrom(); applyTo();
    invalidateHistCache();
    showToast(`Transferred: ${book.title} ×${qty} ${fromBranch} → ${toBranch}`, 'ok');
    closeTransferModal();
    renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error processing transfer.', 'error');
  }
}

// ==========================================
// TEACHER COPY (give a book to a teacher — recorded as stock out)
// ==========================================
let teacherCopyIsbn = null, teacherCopyBranch = null;

function openTeacherCopyModal(isbn) {
  const book = books.find(b => b.isbn === isbn);
  if (!book) return;
  teacherCopyIsbn = isbn;
  teacherCopyBranch = currentBranch;
  document.getElementById('mtc-book-info').textContent = `${book.title} — ${currentBranch}`;
  document.getElementById('mtc-current').textContent = getStock(isbn, currentBranch);
  document.getElementById('mtc-teacher').value = '';
  document.getElementById('mtc-qty').value = '1';
  document.getElementById('mtc-note').value = '';
  document.getElementById('mtc-warn').style.display = 'none';
  document.getElementById('modal-teacher').classList.add('open');
}

function closeTeacherCopyModal() {
  document.getElementById('modal-teacher').classList.remove('open');
  teacherCopyIsbn = null;
  teacherCopyBranch = null;
}

async function processTeacherCopy() {
  const isbn = teacherCopyIsbn;
  const branch = teacherCopyBranch;
  const teacher = document.getElementById('mtc-teacher').value.trim();
  const qty = parseInt(document.getElementById('mtc-qty').value) || 0;
  const note = document.getElementById('mtc-note').value.trim();
  const warnEl = document.getElementById('mtc-warn');

  const book = books.find(b => b.isbn === isbn);
  if (!book) return;
  if (!teacher) { warnEl.textContent = "Enter the teacher's name."; warnEl.style.display = ''; return; }
  if (qty < 1) { warnEl.textContent = 'Invalid quantity.'; warnEl.style.display = ''; return; }
  const current = getStock(isbn, branch);
  if (current < qty) { warnEl.textContent = `Not enough stock at ${branch}. Current: ${current}`; warnEl.style.display = ''; return; }

  try {
    const batch = db.batch();
    const applyLocal = batchStockUpdate(batch, isbn, book.title, branch, -qty);
    batch.set(db.collection('stock_out').doc(), {
      isbn, title: book.title, branch, quantity: qty,
      teacher, note, createdAt: nowLA(),
      createdBy: currentUser ? currentUser.email : ''
    });
    await batch.commit();
    applyLocal();
    invalidateHistCache();
    showToast(`Teacher copy: ${book.title} ×${qty} → ${teacher}`, 'ok');
    closeTeacherCopyModal();
    renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error saving teacher copy.', 'error');
  }
}

// ==========================================
// ORDERS
// ==========================================
async function addOrder() {
  const isbn = document.getElementById('ord-isbn').value;
  const branch = document.getElementById('ord-branch').value;
  const qty = parseInt(document.getElementById('ord-qty').value);
  const source = document.getElementById('ord-source').value.trim();
  const note = document.getElementById('ord-note').value.trim();

  const book = books.find(b => b.isbn === isbn);
  if (!book) { showToast('Please select a book.', 'error'); return; }
  if (!qty || qty < 1) { showToast('Invalid quantity.', 'error'); return; }

  try {
    const ref = await db.collection('pending_orders').add({
      isbn, title: book.title, branch, quantity: qty,
      orderSource: source, note, orderedAt: nowLA(), status: 'pending'
    });
    pendingOrders.unshift({ id: ref.id, isbn, title: book.title, branch, quantity: qty,
      orderSource: source, note, orderedAt: nowLA(), status: 'pending' });
    showToast(`Order placed: ${book.title} ×${qty} for ${branch}`, 'ok');
    closeOrderModal();
    renderOrders();
  } catch(e) {
    console.error(e);
    showToast('Error placing order.', 'error');
  }
}

function renderOrders() {
  const branchFilter = document.getElementById('ord-filter-branch').value;
  const statusFilter = document.getElementById('ord-filter-status').value;

  let rows = pendingOrders.filter(o => {
    if (branchFilter !== 'ALL' && o.branch !== branchFilter) return false;
    if (statusFilter !== 'ALL' && o.status !== statusFilter) return false;
    return true;
  });

  if (!rows.length) {
    document.getElementById('orders-tbody').innerHTML = '<tr><td colspan="9" class="empty-state">No orders.</td></tr>';
    return;
  }

  document.getElementById('orders-tbody').innerHTML = rows.map((o, i) => {
    const badgeCls = o.status === 'pending' ? 'badge-pending' : (o.status === 'received' ? 'badge-received' : 'badge-cancelled');
    const actions = currentRole !== 'manager' ? '' : o.status === 'pending'
      ? `<button class="btn btn-success btn-sm" onclick="openReceiveModal('${o.id}')">Receive</button>
         <button class="btn btn-secondary btn-sm" onclick="cancelOrder('${o.id}')">Cancel</button>`
      : (o.status === 'cancelled'
        ? `<button class="btn btn-secondary btn-sm" onclick="restoreOrder('${o.id}')">Restore</button>`
        : '');
    return `<tr>
      <td class="td-dim">${rows.length - i}</td>
      <td>${esc(o.title)}</td>
      <td>${esc(o.branch)}</td>
      <td>${o.quantity}</td>
      <td>${esc(o.orderSource||'')}</td>
      <td>${esc(o.note||'')}</td>
      <td class="td-dim">${esc((o.orderedAt||'').substring(0,10))}</td>
      <td><span class="badge ${badgeCls}">${o.status}</span></td>
      <td><div style="display:flex;gap:4px;">${actions}</div></td>
    </tr>`;
  }).join('');
}

function openOrderModal() {
  document.getElementById('ord-isbn').value = '';
  document.getElementById('ord-qty').value = '1';
  document.getElementById('ord-source').value = '';
  document.getElementById('ord-note').value = '';
  if (currentBranch !== 'ALL') document.getElementById('ord-branch').value = currentBranch;
  document.getElementById('modal-order').classList.add('open');
}

function closeOrderModal() {
  document.getElementById('modal-order').classList.remove('open');
}

function openReceiveModal(docId) {
  const order = pendingOrders.find(o => o.id === docId);
  if (!order) return;
  receivingOrderId = docId;
  document.getElementById('receive-modal-content').innerHTML =
    `<div style="font-size:13px;margin-bottom:12px;">
      <strong>${esc(order.title)}</strong><br>
      Branch: ${esc(order.branch)} &mdash; Ordered: ${order.quantity}
    </div>`;
  document.getElementById('receive-qty').value = order.quantity;
  document.getElementById('receive-qty').max = order.quantity;
  document.getElementById('receive-modal').classList.add('open');
}

function closeReceiveModal() {
  document.getElementById('receive-modal').classList.remove('open');
  receivingOrderId = null;
}

async function confirmReceive() {
  if (!receivingOrderId) return;
  const order = pendingOrders.find(o => o.id === receivingOrderId);
  if (!order) return;
  const receiveQty = parseInt(document.getElementById('receive-qty').value);
  if (!receiveQty || receiveQty < 1) { showToast('Invalid quantity.', 'error'); return; }

  const orderedQty = Number(order.quantity);
  const qtyToRecv = Math.min(receiveQty, orderedQty);
  const remaining = orderedQty - qtyToRecv;

  try {
    const book = books.find(b => b.isbn === order.isbn);
    const title = book ? book.title : order.title;

    const stockNote = order.note ? order.note + ' (from pending order)' : 'From pending order';
    const batch = db.batch();
    const applyLocal = batchStockUpdate(batch, order.isbn, title, order.branch, qtyToRecv);
    batch.set(db.collection('stock_history').doc(), {
      isbn: order.isbn, title, branch: order.branch,
      quantity: qtyToRecv, note: stockNote, orderSource: order.orderSource||'', createdAt: nowLA(),
      createdBy: currentUser ? currentUser.email : ''
    });
    batch.update(db.collection('pending_orders').doc(receivingOrderId), { quantity: qtyToRecv, status: 'received' });

    let remainderRef = null, remainderNote = '';
    if (remaining > 0) {
      remainderNote = order.note ? order.note + ' (remainder)' : 'Remainder from order';
      remainderRef = db.collection('pending_orders').doc();
      batch.set(remainderRef, {
        isbn: order.isbn, title, branch: order.branch,
        quantity: remaining, orderSource: order.orderSource||'', note: remainderNote,
        orderedAt: nowLA(), status: 'pending'
      });
    }

    await batch.commit();
    applyLocal();
    invalidateHistCache();
    order.quantity = qtyToRecv; order.status = 'received';

    if (remainderRef) {
      pendingOrders.unshift({ id: remainderRef.id, isbn: order.isbn, title, branch: order.branch,
        quantity: remaining, orderSource: order.orderSource||'', note: remainderNote, orderedAt: nowLA(), status: 'pending' });
      showToast(`Received ${qtyToRecv}. New order for remaining ${remaining}.`, 'ok');
    } else {
      showToast(`Order fully received!`, 'ok');
    }

    closeReceiveModal();
    renderOrders();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error receiving order.', 'error');
  }
}

async function cancelOrder(docId) {
  if (!confirm('Cancel this order?')) return;
  await db.collection('pending_orders').doc(docId).update({ status: 'cancelled' });
  const o = pendingOrders.find(o => o.id === docId);
  if (o) o.status = 'cancelled';
  renderOrders();
  showToast('Order cancelled.', 'ok');
}

async function restoreOrder(docId) {
  await db.collection('pending_orders').doc(docId).update({ status: 'pending' });
  const o = pendingOrders.find(o => o.id === docId);
  if (o) o.status = 'pending';
  renderOrders();
  showToast('Order restored.', 'ok');
}

// ==========================================
// HISTORY
// ==========================================
let histBranch = 'LA';
function setHistBranch(b) {
  histBranch = b;
  document.querySelectorAll('.hist-branch-btn').forEach(btn =>
    btn.classList.toggle('active', btn.dataset.hb === b));
  loadHistory();
}

// Cached raw history (all four collections) plus per-record stock-after
// values. Rebuilt on entering the History tab and after any write that
// touches inventory or history records; filter changes reuse the cache.
let _histCache = null;
let _histCacheAt = 0;               // when the cache was last built (staleness clock)
const HIST_STALE_MS = 60000;        // re-fetch on tab entry only if older than this
let _histPage = 1;                  // current History page (1-based)
const HIST_PAGE_SIZE = 50;          // entries per page (a cart counts as one entry)
let _histTotalsScope = 'page';      // 'page' = totals for this page; 'all' = all filtered
function invalidateHistCache() {
  _histCache = null;
}

async function buildHistCache() {
  const [salesSnap, inSnap, outSnap, trSnap] = await Promise.all([
    db.collection('sales').orderBy('soldAt', 'desc').limit(5000).get(),
    db.collection('stock_history').orderBy('createdAt', 'desc').limit(5000).get(),
    db.collection('stock_out').orderBy('createdAt', 'desc').limit(5000).get(),
    db.collection('transfers').orderBy('createdAt', 'desc').limit(5000).get()
  ]);
  const toRows = snap => snap.docs.map(d => ({ _docId: d.id, ...d.data() }));
  const cache = {
    sales: toRows(salesSnap),
    stockin: toRows(inSnap),
    stockout: toRows(outSnap),
    transfers: toRows(trSnap),
    stockAfter: {}
  };

  // Stock AFTER each transaction: start from current stock and walk the
  // combined timeline newest -> oldest, rolling back each record's effect.
  const dateOf = { sales: r => r.soldAt, stockin: r => r.createdAt, stockout: r => r.createdAt, transfers: r => r.createdAt };
  const events = [];
  ['sales', 'stockin', 'stockout', 'transfers'].forEach(tab => {
    cache[tab].forEach(r => {
      const eff = histStockEffects(tab, r);
      if (eff.length) events.push({ id: tab + '|' + r._docId, date: dateOf[tab](r) || '', eff });
    });
  });
  events.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const running = {};
  events.forEach(ev => {
    const after = {};
    ev.eff.forEach(e => {
      const key = e.isbn + '|' + e.branch;
      if (!(key in running)) running[key] = getStock(e.isbn, e.branch);
      after[key] = running[key];
      running[key] -= e.delta;
    });
    cache.stockAfter[ev.id] = after;
  });
  _histCache = cache;
  _histCacheAt = Date.now();
}

// Signed stock change of a record from the perspective of the selected branch.
function changeOf(tab, r) {
  const q = Number(r.quantity) || 0;
  if (tab === 'stockin') return q;
  if (tab === 'sales' || tab === 'stockout') return -q;
  if (tab === 'transfers') {
    if (r.fromBranch === histBranch) return -q;
    if (r.toBranch === histBranch) return q;
  }
  return 0;
}

// Like stockAfterOf, but transfers show only the selected branch when one is chosen.
function stockAfterAllOf(tab, r) {
  if (tab !== 'transfers' || histBranch === 'ALL') return stockAfterOf(tab, r);
  const m = _histCache && _histCache.stockAfter['transfers|' + r._docId];
  if (!m) return '';
  const v = m[r.isbn + '|' + histBranch];
  return v === undefined ? '' : String(v);
}

// Plain-text "stock after this transaction" for a history record.
function stockAfterOf(tab, r) {
  const m = _histCache && _histCache.stockAfter[tab + '|' + r._docId];
  if (!m) return '';
  if (tab === 'transfers') {
    const f = m[r.isbn + '|' + r.fromBranch], t = m[r.isbn + '|' + r.toBranch];
    return `${r.fromBranch} ${f === undefined ? '—' : f} · ${r.toBranch} ${t === undefined ? '—' : t}`;
  }
  const v = m[r.isbn + '|' + r.branch];
  return v === undefined ? '' : String(v);
}

function switchHistoryTab(tab) {
  document.querySelectorAll('[id^="htab-"]').forEach(b => b.classList.remove('active'));
  document.getElementById('htab-' + tab).classList.add('active');
  currentHistTab = tab;
  localStorage.setItem('inventory_hist_tab', tab);
  loadHistory();
}

function onHistYearQuarterChange() {
  document.getElementById('hist-from').value = '';
  document.getElementById('hist-to').value = '';
  document.getElementById('hist-date-clear').style.display = 'none';
  loadHistory();
}

function onHistDateRangeChange() {
  const from = document.getElementById('hist-from').value;
  const to = document.getElementById('hist-to').value;
  document.getElementById('hist-date-clear').style.display = (from || to) ? '' : 'none';
  if (from || to) {
    document.getElementById('hist-year').value = 'ALL';
    document.getElementById('hist-quarter').value = 'ALL';
  }
  loadHistory();
}

function clearHistDateRange() {
  document.getElementById('hist-from').value = '';
  document.getElementById('hist-to').value = '';
  document.getElementById('hist-date-clear').style.display = 'none';
  loadHistory();
}

function restoreHistFilters() {
  let f; try { f = JSON.parse(localStorage.getItem('inv_hist_filters') || 'null'); } catch(e) { f = null; }
  if (!f) return;
  const set = (id, val) => { const el = document.getElementById(id); if (el && val != null) el.value = val; };
  if (f.branch && ['LA','RH','IRV','ALL'].includes(f.branch) && (f.branch !== 'ALL' || currentRole === 'manager')) {
    histBranch = f.branch;
    document.querySelectorAll('.hist-branch-btn').forEach(btn =>
      btn.classList.toggle('active', btn.dataset.hb === histBranch));
  }
  set('hist-year', f.year);
  set('hist-quarter', f.quarter);
  set('hist-from', f.fromDate);
  set('hist-to', f.toDate);
  if (f.fromDate || f.toDate) {
    const clr = document.getElementById('hist-date-clear'); if (clr) clr.style.display = '';
  }
}

async function loadHistory() {
  if (currentTab !== 'history') return;
  const branch = histBranch;
  const year = document.getElementById('hist-year').value;
  const quarter = document.getElementById('hist-quarter').value;
  const fromDate = document.getElementById('hist-from').value;
  const toDate = document.getElementById('hist-to').value;
  localStorage.setItem('inv_hist_filters', JSON.stringify({ branch, year, quarter, fromDate, toDate }));

  if (!_histCache) await buildHistCache();
  let rows;
  if (currentHistTab === 'all') {
    // Merge all four record types into one timeline, newest first.
    rows = [];
    [['sales','soldAt'], ['stockin','createdAt'], ['stockout','createdAt'], ['transfers','createdAt']]
      .forEach(([tab, df]) => {
        _histCache[tab].forEach(r => rows.push({ ...r, _tab: tab, _date: r[df] || '' }));
      });
    rows.sort((a, b) => b._date.localeCompare(a._date) || a._docId.localeCompare(b._docId));
  } else {
    rows = _histCache[currentHistTab].slice();
  }

  const dateField = currentHistTab === 'sales' ? 'soldAt' : 'createdAt';
  const dateOfRow = currentHistTab === 'all' ? (r => r._date) : (r => r[dateField] || '');
  const tabOfRow = r => currentHistTab === 'all' ? r._tab : currentHistTab;

  if (branch !== 'ALL') {
    rows = rows.filter(r => tabOfRow(r) === 'transfers'
      ? (r.fromBranch === branch || r.toBranch === branch)
      : r.branch === branch);
  }

  if (fromDate || toDate) {
    rows = rows.filter(r => {
      const d = dateOfRow(r).substring(0, 10);
      if (fromDate && d < fromDate) return false;
      if (toDate && d > toDate) return false;
      return true;
    });
  } else {
    if (year !== 'ALL') rows = rows.filter(r => dateOfRow(r).substring(0, 4) === year);
    if (quarter !== 'ALL') rows = rows.filter(r => getQuarter(dateOfRow(r)) === quarter);
  }

  if (currentHistTab === 'sales') rows = groupCartRows(rows);

  historyData = rows;
  _histPage = 1;
  renderHistory();
}

// Orchestrates the History table: applies the search filter, splits the rows
// into pages (keeping multi-item carts whole), renders the current page, the
// pager, and the totals for the chosen scope.
function renderHistory() {
  const fullRows = filterHistRows(historyData);
  const entries = histEntries(fullRows);
  const totalPages = Math.max(1, Math.ceil(entries.length / HIST_PAGE_SIZE));
  if (_histPage > totalPages) _histPage = totalPages;
  if (_histPage < 1) _histPage = 1;
  const start = (_histPage - 1) * HIST_PAGE_SIZE;
  const pageEntries = entries.slice(start, start + HIST_PAGE_SIZE);
  const pageRows = pageEntries.flat();
  const rowOffset = entries.slice(0, start).reduce((n, e) => n + e.length, 0);
  renderHistoryTable(pageRows, fullRows.length, rowOffset);
  renderHistPagination(entries.length, totalPages);
  updateHistTotals(_histTotalsScope === 'page' ? pageRows : fullRows);
}

// Group rows into pageable entries: a multi-item sales cart is one entry (so a
// page break never splits it); every other row is its own entry. Carts are
// already contiguous in the sales view (groupCartRows), and only that sub-tab
// renders them grouped, so other tabs are one-row entries.
function histEntries(rows) {
  if (currentHistTab !== 'sales') return rows.map(r => [r]);
  const cnt = {};
  rows.forEach(r => { if (r.txnId) cnt[r.txnId] = (cnt[r.txnId] || 0) + 1; });
  const entries = [], seen = new Set();
  rows.forEach(r => {
    if (r.txnId && cnt[r.txnId] > 1) {
      if (seen.has(r.txnId)) return;
      seen.add(r.txnId);
      entries.push(rows.filter(x => x.txnId === r.txnId));
    } else {
      entries.push([r]);
    }
  });
  return entries;
}

function histGoPage(p) { _histPage = p; renderHistory(); }

function setHistTotalsScope(s) {
  _histTotalsScope = s === 'all' ? 'all' : 'page';
  renderHistory();
}

function renderHistPagination(totalEntries, totalPages) {
  const el = document.getElementById('hist-pagination');
  if (!el) return;
  if (!totalEntries) { el.innerHTML = ''; return; }
  const p = _histPage;
  const btn = (glyph, label, page, disabled) =>
    `<button class="btn btn-secondary btn-sm" title="${label}" aria-label="${label}" ${disabled ? 'disabled' : ''} onclick="histGoPage(${page})">${glyph}</button>`;
  el.innerHTML =
    btn('&#8249;', 'Previous page', p - 1, p <= 1) +
    `<span style="margin:0 6px;">${p} / ${totalPages}</span>` +
    btn('&#8250;', 'Next page', p + 1, p >= totalPages);
}

// Totals for the given rows (either the current page or all filtered rows,
// per the scope toggle). Renders the Sales summary cards (sales sub-tab only)
// and the toolbar In/Out/Sales/Transfer/Net chips. changeOf() carries the
// branch-aware sign, so Net follows the chosen branch.
function updateHistTotals(rows) {
  rows = rows || [];
  const sc = document.getElementById('hist-totals-scope');
  if (sc) sc.value = _histTotalsScope;
  const tabOf = r => currentHistTab === 'all' ? r._tab : currentHistTab;

  // Sales summary cards — only on the sales sub-tab.
  const summEl = document.getElementById('hist-summary');
  if (summEl) {
    if (currentHistTab === 'sales') {
      const totalQty = rows.reduce((s, r) => s + Number(r.quantity || 0), 0);
      const totalRev = rows.reduce((s, r) => s + Number(r.totalPaid || 0), 0);
      const totalDiscount = rows.reduce((s, r) => s + Number(r.sellingPrice || 0), 0) - totalRev;
      const pay = salesPaymentBreakdown(rows);
      const payCards = Object.keys(pay).sort().map(m =>
        `<div class="summary-card"><div class="label">${esc(m)}</div><div class="value">${fmtMoney(pay[m])}</div></div>`).join('');
      summEl.innerHTML =
        `<div class="summary-card"><div class="label">Count</div><div class="value">${totalQty}</div></div>
         <div class="summary-card"><div class="label">Revenue</div><div class="value">${fmtMoney(totalRev)}</div></div>
         <div class="summary-card"><div class="label">Discount</div><div class="value">${fmtMoney(totalDiscount)}</div></div>
         ${payCards}`;
      summEl.style.display = 'flex';
    } else {
      summEl.style.display = 'none';
      summEl.innerHTML = '';
    }
  }

  // Toolbar chips.
  const el = document.getElementById('hist-totals');
  if (!el) return;
  let inQ = 0, outQ = 0, salesQ = 0, trQ = 0, net = 0;
  rows.forEach(r => {
    const tab = tabOf(r);
    const qn = Number(r.quantity) || 0;
    if (tab === 'sales') salesQ += qn;
    else if (tab === 'stockin') inQ += qn;
    else if (tab === 'stockout') outQ += qn;
    else if (tab === 'transfers') trQ += qn;
    net += changeOf(tab, r);
  });
  const chip = (label, txt, color) =>
    `<span style="white-space:nowrap;">${label} <b style="color:${color};">${txt}</b></span>`;
  const neg = n => n === 0 ? '0' : '-' + n;
  const div = `<span style="width:1px;height:14px;background:#e2e8f0;"></span>`;
  el.innerHTML =
    chip('In', inQ === 0 ? '0' : '+' + inQ, '#16a34a') +
    chip('Out', neg(outQ), '#dc2626') +
    chip('Sales', neg(salesQ), '#dc2626') +
    chip('Transfer', String(trQ), '#0369a1') +
    div +
    chip('Net', (net > 0 ? '+' : '') + net, net >= 0 ? '#16a34a' : '#dc2626');
}

let _histSearchTimer = null;
function onHistSearchInput() {
  clearTimeout(_histSearchTimer);
  _histSearchTimer = setTimeout(() => { _histPage = 1; renderHistory(); }, 200);
}

function filterHistRows(rows) {
  const q = (document.getElementById('hist-search').value || '').trim().toLowerCase();
  if (!q) return rows;
  const matches = r => [r.title, r.isbn, r.student, r.teacher, r.note, r.branch, r.fromBranch, r.toBranch,
    r.orderSource, r.paymentSummary, fmtBy(r.createdBy || ''), r.soldAt, r.createdAt]
    .some(v => v && String(v).toLowerCase().includes(q));
  if (currentHistTab === 'sales') {
    // Keep whole cart transactions together when any item in the cart matches.
    const matchedTxns = new Set(rows.filter(r => r.txnId && matches(r)).map(r => r.txnId));
    return rows.filter(r => matches(r) || (r.txnId && matchedTxns.has(r.txnId)));
  }
  return rows.filter(matches);
}

// Cart items share a txnId but can be interleaved with unrelated sales when
// soldAt timestamps are equal (same-day entries) — Firestore's secondary sort
// order is undefined. Pull each txn's rows together at the group's first
// appearance so the rendered cart block is always contiguous.
function groupCartRows(rows) {
  const byTxn = {};
  rows.forEach(r => { if (r.txnId) (byTxn[r.txnId] = byTxn[r.txnId] || []).push(r); });
  const emitted = new Set();
  const out = [];
  rows.forEach(r => {
    if (r.txnId && byTxn[r.txnId].length > 1) {
      if (!emitted.has(r.txnId)) { emitted.add(r.txnId); out.push(...byTxn[r.txnId]); }
    } else {
      out.push(r);
    }
  });
  return out;
}

function fmtBy(email) {
  if (!email) return '';
  const at = email.indexOf('@');
  return at > 0 ? email.substring(0, at) : email;
}

// Sum sales revenue by payment method (Cash / Card / Zelle / …) over the given
// sales rows. paymentSummary is stored per transaction as "Cash:$65, Zelle:$30"
// and copied onto every line item of a cart, so count each transaction once
// (by txnId) to avoid multiplying a split payment across its items.
function salesPaymentBreakdown(rows) {
  const seen = new Set();
  const totals = {};
  rows.forEach(r => {
    const key = r.txnId || r._docId;
    if (seen.has(key)) return;
    seen.add(key);
    (r.paymentSummary || '').split(',').forEach(part => {
      const seg = part.trim();
      if (!seg) return;
      const i = seg.lastIndexOf(':$');
      if (i < 0) return;
      const method = seg.slice(0, i).trim();
      const amt = Number(seg.slice(i + 2).replace(/[^0-9.]/g, '')) || 0;
      if (method) totals[method] = (totals[method] || 0) + amt;
    });
  });
  return totals;
}

function renderHistoryTable(rows, totalCount, rowOffset) {
  const theadRow = document.getElementById('hist-thead-row');
  const tbody = document.getElementById('hist-tbody');
  // Row ordinals count down from the newest across the whole filtered list, so
  // they stay continuous as you page (page 2 picks up where page 1 left off).
  const N = (totalCount || rows.length) - (rowOffset || 0);

  const mgr = currentRole === 'manager';
  if (currentHistTab === 'all') {
    theadRow.innerHTML = '<th>#</th><th>Type</th><th>Title</th><th>Branch</th><th class="ta-r">Change</th><th class="ta-r" title="Branch stock right after this transaction">Stock</th><th>Detail</th><th>Note</th><th>Date</th><th>By</th>'+(mgr?'<th></th>':'');
    const typeMeta = {
      sales:     { label: 'Sale',     cls: 't-sale' },
      stockin:   { label: 'In',       cls: 't-in' },
      stockout:  { label: 'Out',      cls: 't-out' },
      transfers: { label: 'Transfer', cls: 't-tr' }
    };
    tbody.innerHTML = rows.length ? rows.map((r, i) => {
      const t = r._tab;
      const chg = changeOf(t, r);
      const chgHtml = (t === 'transfers' && histBranch === 'ALL')
        ? `<span class="td-dim">&#8596; ${Number(r.quantity) || 0}</span>`
        : `<span style="color:${chg > 0 ? '#16a34a' : '#dc2626'};font-weight:600;">${chg > 0 ? '+' : ''}${chg}</span>`;
      const branchTxt = t === 'transfers' ? `${r.fromBranch} → ${r.toBranch}` : (r.branch || '');
      const detail = t === 'sales'
        ? [r.student, r.paymentSummary, fmtMoney(r.totalPaid)].filter(Boolean).join(' · ')
        : (t === 'stockin' ? (r.orderSource || '')
        : (t === 'stockout' && r.teacher ? `Teacher: ${r.teacher}` : ''));
      return `<tr>
        <td class="td-dim">${N - i}</td>
        <td><span class="type-badge ${typeMeta[t].cls}">${typeMeta[t].label}</span></td>
        <td>${esc(r.title)}</td>
        <td class="nowrap">${esc(branchTxt)}</td>
        <td class="ta-r">${chgHtml}</td>
        <td class="ta-r td-dim nowrap">${esc(stockAfterAllOf(t, r))}</td>
        <td style="font-size:12px;">${esc(detail)}</td>
        <td>${esc(r.note||'')}</td>
        <td class="td-dim nowrap">${fmtDateTime(r._date)}</td>
        <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
        ${mgr ? `<td class="nowrap"><button class="btn btn-secondary btn-xs" onclick="editHistoryRecord('${r._docId}','${t}')">Edit</button> <button class="btn btn-danger btn-xs" onclick="deleteHistoryRecord('${r._docId}','${t}')">Del</button></td>` : ''}
      </tr>`;
    }).join('') : '<tr><td colspan="'+(mgr?11:10)+'" class="empty-state">No records.</td></tr>';

  } else if (currentHistTab === 'sales') {
    theadRow.innerHTML = '<th>#</th><th>Title</th><th>Branch</th><th>Student</th><th class="ta-r">Qty</th><th class="ta-r" title="Branch stock right after this transaction">Stock</th><th class="ta-r">Price</th><th class="ta-r">Discount</th><th class="ta-r">Paid</th><th>Payment</th><th>Note</th><th>Date</th><th>By</th>'+(mgr?'<th></th>':'');

    const txnGroups = {};
    rows.forEach((r, i) => {
      if (r.txnId) {
        if (!txnGroups[r.txnId]) txnGroups[r.txnId] = [];
        txnGroups[r.txnId].push(i);
      }
    });

    if (!rows.length) {
      tbody.innerHTML = `<tr><td colspan="${mgr ? 14 : 13}" class="empty-state">No sales records.</td></tr>`;
    } else {
      let html = '';
      rows.forEach((r, i) => {
        const grpIdx = r.txnId ? txnGroups[r.txnId] : null;
        const isMulti = grpIdx && grpIdx.length > 1;

        if (!isMulti) {
          html += `<tr>
            <td class="td-dim">${N - i}</td>
            <td>${esc(r.title)}</td>
            <td>${esc(r.branch)}</td>
            <td>${esc(r.student||'')}</td>
            <td class="ta-r">${r.quantity}</td>
            <td class="ta-r td-dim">${esc(stockAfterOf('sales', r))}</td>
            <td class="ta-r">${fmtMoney(r.sellingPrice)}</td>
            <td class="ta-r">${(r.discount||r.txnDiscount) ? fmtMoney(r.discount||r.txnDiscount) : '—'}</td>
            <td class="ta-r" style="font-weight:600;">${fmtMoney(r.totalPaid)}</td>
            <td style="font-size:11px;">${esc(r.paymentSummary||'')}</td>
            <td>${esc(r.note||'')}</td>
            <td class="td-dim nowrap">${fmtDateTime(r.soldAt)}</td>
            <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
            ${mgr ? `<td class="nowrap"><button class="btn btn-secondary btn-xs" onclick="editHistoryRecord('${r._docId}','sales')">Edit</button> <button class="btn btn-danger btn-xs" onclick="deleteHistoryRecord('${r._docId}','sales')">Del</button></td>` : ''}
          </tr>`;
          return;
        }

        // Multi-item cart: one collapsed summary row at the group's first
        // position; per-item rows are hidden until the summary is clicked.
        if (grpIdx[0] !== i) return;
        const grp = grpIdx.map(idx => rows[idx]);
        const grpQty   = grp.reduce((s, g) => s + Number(g.quantity||0), 0);
        const grpTotal = grp.reduce((s, g) => s + Number(g.sellingPrice||0), 0);
        const grpPaid  = grp.reduce((s, g) => s + Number(g.totalPaid||0), 0);
        const grpDisc  = r.txnDiscount || 0;

        html += `<tr class="txn-summary" id="txn-row-${r.txnId}" onclick="toggleTxn('${r.txnId}')">
          <td class="td-dim">${N - i}</td>
          <td><span class="txn-chev">▸</span><span class="cart-badge">CART ×${grp.length}</span>${esc(r.title)} <span class="td-dim">+ ${grp.length - 1} more</span></td>
          <td>${esc(r.branch)}</td>
          <td>${esc(r.student||'')}</td>
          <td class="ta-r">${grpQty}</td>
          <td></td>
          <td class="ta-r">${fmtMoney(grpTotal)}</td>
          <td class="ta-r">${grpDisc ? fmtMoney(grpDisc) : '—'}</td>
          <td class="ta-r" style="font-weight:600;">${fmtMoney(grpPaid)}</td>
          <td style="font-size:11px;">${esc(r.paymentSummary||'')}</td>
          <td>${esc(r.note||'')}</td>
          <td class="td-dim nowrap">${fmtDateTime(r.soldAt)}</td>
          <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
          ${mgr ? `<td class="nowrap"><button class="btn btn-danger btn-xs" onclick="event.stopPropagation();deleteSalesTxn('${esc(r.txnId)}')">Del all</button></td>` : ''}
        </tr>`;

        grp.forEach(g => {
          html += `<tr class="txn-item txn-item-${r.txnId}" style="display:none;">
            <td></td>
            <td style="padding-left:26px;color:#0369a1;">└ ${esc(g.title)}</td>
            <td></td><td></td>
            <td class="ta-r">${g.quantity}</td>
            <td class="ta-r td-dim">${esc(stockAfterOf('sales', g))}</td>
            <td class="ta-r">${fmtMoney(g.sellingPrice)}</td>
            <td></td><td></td><td></td><td></td><td></td><td></td>
            ${mgr ? '<td></td>' : ''}
          </tr>`;
        });
      });
      tbody.innerHTML = html;
    }

  } else if (currentHistTab === 'stockin') {
    theadRow.innerHTML = '<th>#</th><th>Title</th><th>Branch</th><th class="ta-r">Qty</th><th class="ta-r" title="Branch stock right after this transaction">Stock</th><th>Source</th><th>Note</th><th>Date</th><th>By</th>'+(mgr?'<th></th>':'');
    tbody.innerHTML = rows.length ? rows.map((r, i) => `<tr>
      <td class="td-dim">${N - i}</td>
      <td>${esc(r.title)}</td><td>${esc(r.branch)}</td>
      <td class="ta-r">${r.quantity}</td>
      <td class="ta-r td-dim">${esc(stockAfterOf('stockin', r))}</td>
      <td>${esc(r.orderSource||'')}</td><td>${esc(r.note||'')}</td>
      <td class="td-dim nowrap">${fmtDateTime(r.createdAt)}</td>
      <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
      ${mgr?`<td class="nowrap"><button class="btn btn-secondary btn-xs" onclick="editHistoryRecord('${r._docId}','stockin')">Edit</button> <button class="btn btn-danger btn-xs" onclick="deleteHistoryRecord('${r._docId}','stockin')">Del</button></td>`:''}
    </tr>`).join('') : '<tr><td colspan="'+(mgr?10:9)+'" class="empty-state">No stock-in records.</td></tr>';

  } else if (currentHistTab === 'stockout') {
    theadRow.innerHTML = '<th>#</th><th>Title</th><th>Branch</th><th class="ta-r">Qty</th><th class="ta-r" title="Branch stock right after this transaction">Stock</th><th>Teacher</th><th>Note</th><th>Date</th><th>By</th>'+(mgr?'<th></th>':'');
    tbody.innerHTML = rows.length ? rows.map((r, i) => `<tr>
      <td class="td-dim">${N - i}</td>
      <td>${esc(r.title)}</td><td>${esc(r.branch)}</td>
      <td class="ta-r">${r.quantity}</td>
      <td class="ta-r td-dim">${esc(stockAfterOf('stockout', r))}</td>
      <td>${esc(r.teacher||'')}</td>
      <td>${esc(r.note||'')}</td>
      <td class="td-dim nowrap">${fmtDateTime(r.createdAt)}</td>
      <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
      ${mgr?`<td class="nowrap"><button class="btn btn-secondary btn-xs" onclick="editHistoryRecord('${r._docId}','stockout')">Edit</button> <button class="btn btn-danger btn-xs" onclick="deleteHistoryRecord('${r._docId}','stockout')">Del</button></td>`:''}
    </tr>`).join('') : '<tr><td colspan="'+(mgr?10:9)+'" class="empty-state">No stock-out records.</td></tr>';

  } else if (currentHistTab === 'transfers') {
    theadRow.innerHTML = '<th>#</th><th>Title</th><th>From</th><th>To</th><th class="ta-r">Qty</th><th title="Stock at both branches right after this transfer">Stock</th><th>Note</th><th>Date</th><th>By</th>'+(mgr?'<th></th>':'');
    tbody.innerHTML = rows.length ? rows.map((r, i) => `<tr>
      <td class="td-dim">${N - i}</td>
      <td>${esc(r.title)}</td><td>${esc(r.fromBranch)}</td><td>${esc(r.toBranch)}</td>
      <td class="ta-r">${r.quantity}</td>
      <td class="td-dim nowrap">${esc(stockAfterOf('transfers', r))}</td>
      <td>${esc(r.note||'')}</td>
      <td class="td-dim nowrap">${fmtDateTime(r.createdAt)}</td>
      <td class="td-dim">${esc(fmtBy(r.createdBy||''))}</td>
      ${mgr?`<td class="nowrap"><button class="btn btn-secondary btn-xs" onclick="editHistoryRecord('${r._docId}','transfers')">Edit</button> <button class="btn btn-danger btn-xs" onclick="deleteHistoryRecord('${r._docId}','transfers')">Del</button></td>`:''}
    </tr>`).join('') : '<tr><td colspan="'+(mgr?10:9)+'" class="empty-state">No transfer records.</td></tr>';
  }
}

// Expand/collapse a cart transaction's item rows in the sales history table.
function toggleTxn(txnId) {
  const summary = document.getElementById('txn-row-' + txnId);
  if (!summary) return;
  const open = summary.classList.toggle('txn-open');
  document.querySelectorAll('.txn-item-' + txnId).forEach(el => {
    el.style.display = open ? '' : 'none';
  });
}

// History Edit / Delete
const _histCollMap = { sales:'sales', stockin:'stock_history', stockout:'stock_out', transfers:'transfers' };
let _editHistDocId = null, _editHistTab = null;

// Shared form-field builders for the history record editor.
const _ehFg = (label, inner) => `<div class="form-group" style="margin-bottom:10px;"><label>${label}</label>${inner}</div>`;
const _ehTi = (id, val) => `<input type="text" id="${id}" value="${esc(val||'')}">`;
const _ehNi = (id, val) => `<input type="number" id="${id}" value="${val||0}" min="0" step="any" style="width:100%;">`;
const _ehBrSel = (id, val) => `<select id="${id}" style="width:100%;"><option value="IRV"${val==='IRV'?' selected':''}>IRV</option><option value="LA"${val==='LA'?' selected':''}>LA</option><option value="RH"${val==='RH'?' selected':''}>RH</option></select>`;
const _ehDi = (id, val) => `<input type="date" id="${id}" value="${(val||'').substring(0,10)}" style="width:100%;">`;
const _ehBookSel = (id, curIsbn, curTitle) => {
  const matchIsbn = curIsbn || (books.find(b => b.title === curTitle)?.isbn || '');
  const opts = '<option value="">— select book —</option>' +
    books.map(b => `<option value="${esc(b.isbn)}"${b.isbn === matchIsbn ? ' selected' : ''}>${esc(b.title)}${b.isbn ? ' (' + esc(b.isbn) + ')' : ''}</option>`).join('');
  return `<select id="${id}" style="width:100%;">${opts}</select>`;
};

// Payment methods offered when selling; the history editor reuses this list so a
// record can only ever be edited into a method the sell form can produce.
const PAYMENT_METHODS = ['Cash', 'Card', 'Zelle', 'Check'];

// paymentSummary is stored as "Cash:$65" or, for a split, "Cash:$65, Zelle:$30".
// Split it into parts so each method can be edited; amount is null for a legacy
// record that stored a bare method name with no amount.
function parsePaymentSummary(s) {
  return (s || '').split(',').map(p => p.trim()).filter(Boolean).map(seg => {
    const i = seg.lastIndexOf(':$');
    return i < 0 ? { method: seg, amount: null }
                 : { method: seg.slice(0, i).trim(), amount: seg.slice(i + 2).trim() };
  });
}
function formatPaymentSummary(parts) {
  return parts.filter(p => p.method)
    .map(p => (p.amount === null || p.amount === '') ? p.method : `${p.method}:$${p.amount}`)
    .join(', ');
}
// One dropdown per payment part. Amounts are kept exactly as recorded (shown
// beside the dropdown) so changing a method never rewrites what was collected.
const _ehPaySel = (id, val) => {
  const parts = parsePaymentSummary(val);
  if (!parts.length) parts.push({ method: '', amount: null });
  return parts.map((p, i) => {
    const known = PAYMENT_METHODS.includes(p.method);
    const opts = [`<option value=""${p.method ? '' : ' selected'}>— none —</option>`]
      .concat(PAYMENT_METHODS.map(m => `<option value="${m}"${m === p.method ? ' selected' : ''}>${m}</option>`))
      .concat(p.method && !known ? [`<option value="${esc(p.method)}" selected>${esc(p.method)}</option>`] : [])
      .join('');
    const amt = p.amount === null ? ''
      : `<span style="font-size:12px;color:#666;white-space:nowrap;">$${esc(p.amount)}</span>`;
    return `<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;">`
      + `<select id="${id}-${i}" data-amount="${p.amount === null ? '' : esc(p.amount)}"`
      + ` data-has-amount="${p.amount === null ? '0' : '1'}" style="flex:1;">${opts}</select>${amt}</div>`;
  }).join('');
};

// Stock effect a history record HAS on inventory (positive = adds stock).
function histStockEffects(tab, r) {
  const q = Number(r.quantity) || 0;
  if (!q || !r.isbn) return [];
  if (tab === 'sales')     return [{ isbn:r.isbn, title:r.title, branch:r.branch, delta:-q }];
  if (tab === 'stockin')   return [{ isbn:r.isbn, title:r.title, branch:r.branch, delta:+q }];
  if (tab === 'stockout')  return [{ isbn:r.isbn, title:r.title, branch:r.branch, delta:-q }];
  if (tab === 'transfers') return [
    { isbn:r.isbn, title:r.title, branch:r.fromBranch, delta:-q },
    { isbn:r.isbn, title:r.title, branch:r.toBranch,   delta:+q }
  ];
  return [];
}

// Apply effects to inventory; sign=+1 applies, sign=-1 reverses.
async function applyStockEffects(effects, sign) {
  for (const e of effects) {
    if (!e.isbn || !e.branch || !e.delta) continue;
    await updateStock(e.isbn, e.title || '', e.branch, sign * e.delta);
  }
}

// Validate that applying these (already-signed) effects keeps every stock >= 0.
// Returns an error message string if it would go negative, otherwise null.
function aggregateStockEffects(effects) {
  const agg = {};
  for (const e of effects) {
    if (!e.isbn || !e.branch || !e.delta) continue;
    const key = e.isbn + '|' + e.branch;
    if (!agg[key]) agg[key] = { isbn:e.isbn, title:e.title, branch:e.branch, delta:0 };
    agg[key].delta += e.delta;
  }
  return Object.values(agg);
}

// Rows an edit or deletion would push below zero, described for the operator.
function negativeStockEffects(effects) {
  return aggregateStockEffects(effects).map(a => {
    const current = getStock(a.isbn, a.branch);
    if (current + a.delta >= 0) return null;
    const book = books.find(b => b.isbn === a.isbn);
    return `"${(book ? book.title : a.title) || a.isbn}" at ${a.branch}: ${current} → ${current + a.delta}`;
  }).filter(Boolean);
}

function validateStockEffects(effects) {
  const bad = negativeStockEffects(effects);
  return bad.length ? `Cannot apply: ${bad[0]}.` : null;
}

function editHistoryRecord(docId, tab) {
  _editHistDocId = docId; _editHistTab = tab;
  const r = historyData.find(x => x._docId === docId);
  if (!r) return;
  const fg = _ehFg, ti = _ehTi, ni = _ehNi, brSel = _ehBrSel, di = _ehDi, bookSel = _ehBookSel, paySel = _ehPaySel;
  let fields = '';
  if (tab === 'sales') {
    fields =
      fg('Title', bookSel('eh-title', r.isbn, r.title)) +
      fg('Branch', brSel('eh-branch', r.branch)) +
      fg('Student', ti('eh-student', r.student)) +
      fg('Qty', ni('eh-qty', r.quantity)) +
      fg('Price', ni('eh-price', r.sellingPrice)) +
      fg('Discount', ni('eh-discount', r.txnDiscount||r.discount||0)) +
      fg('Paid', ni('eh-paid', r.totalPaid)) +
      fg('Payment', paySel('eh-payment', r.paymentSummary)) +
      fg('Note', ti('eh-note', r.note)) +
      fg('Date', di('eh-date', r.soldAt));
  } else if (tab === 'stockin') {
    fields =
      fg('Title', bookSel('eh-title', r.isbn, r.title)) +
      fg('Branch', brSel('eh-branch', r.branch)) +
      fg('Qty', ni('eh-qty', r.quantity)) +
      fg('Source', ti('eh-source', r.orderSource)) +
      fg('Note', ti('eh-note', r.note)) +
      fg('Date', di('eh-date', r.createdAt));
  } else if (tab === 'stockout') {
    fields =
      fg('Title', bookSel('eh-title', r.isbn, r.title)) +
      fg('Branch', brSel('eh-branch', r.branch)) +
      fg('Qty', ni('eh-qty', r.quantity)) +
      fg('Teacher', ti('eh-teacher', r.teacher)) +
      fg('Note', ti('eh-note', r.note)) +
      fg('Date', di('eh-date', r.createdAt));
  } else if (tab === 'transfers') {
    fields =
      fg('Title', bookSel('eh-title', r.isbn, r.title)) +
      fg('From', brSel('eh-from', r.fromBranch)) +
      fg('To', brSel('eh-to', r.toBranch)) +
      fg('Qty', ni('eh-qty', r.quantity)) +
      fg('Note', ti('eh-note', r.note)) +
      fg('Date', di('eh-date', r.createdAt));
  }
  document.getElementById('edit-hist-fields').innerHTML = fields;
  document.getElementById('edit-hist-modal').classList.add('open');
}

function closeEditHistModal() {
  document.getElementById('edit-hist-modal').classList.remove('open');
  _editHistDocId = null; _editHistTab = null;
}
async function saveHistoryEdit() {
  if (!_editHistDocId || !_editHistTab) return;
  const coll = _histCollMap[_editHistTab];
  const oldRecord = historyData.find(x => x._docId === _editHistDocId);
  const g = id => { const el = document.getElementById(id); return el ? el.value : null; };
  const update = {};
  if (g('eh-title') !== null) {
    const selIsbn = g('eh-title');
    const book = books.find(b => b.isbn === selIsbn);
    if (book) { update.title = book.title; update.isbn = book.isbn; }
  }
  if (g('eh-qty')     !== null) update.quantity      = Number(g('eh-qty')) || 0;
  if (g('eh-note')    !== null) update.note          = g('eh-note').trim();
  if (g('eh-source')  !== null) update.orderSource   = g('eh-source').trim();
  if (g('eh-student') !== null) update.student       = g('eh-student').trim();
  if (g('eh-teacher') !== null) update.teacher       = g('eh-teacher').trim();
  if (g('eh-branch')  !== null) update.branch        = g('eh-branch');
  if (g('eh-from')    !== null) update.fromBranch    = g('eh-from');
  if (g('eh-to')      !== null) update.toBranch      = g('eh-to');
  if (g('eh-price')   !== null) update.sellingPrice  = Number(g('eh-price')) || 0;
  if (g('eh-discount')!== null) update.txnDiscount   = Number(g('eh-discount')) || 0;
  if (g('eh-paid')    !== null) update.totalPaid      = Number(g('eh-paid')) || 0;
  const paySels = document.querySelectorAll('#edit-hist-fields [id^="eh-payment-"]');
  if (paySels.length) {
    update.paymentSummary = formatPaymentSummary(Array.from(paySels).map(el => ({
      method: el.value,
      amount: el.dataset.hasAmount === '1' ? el.dataset.amount : null
    })));
  }
  if (g('eh-date')    !== null && g('eh-date')) {
    // Keep the record's original time-of-day; the picker only edits the date part.
    const origTime = ((_editHistTab === 'sales' ? oldRecord?.soldAt : oldRecord?.createdAt) || '').substring(11,16);
    const dateVal = g('eh-date') + ' ' + (origTime || '00:00');
    if (_editHistTab === 'sales') update.soldAt = dateVal;
    else update.createdAt = dateVal;
  }
  // Build the net inventory change: reverse the old record's effect, apply the new one.
  let applyList = [];
  if (oldRecord) {
    const newRecord = Object.assign({}, oldRecord, update);
    applyList = histStockEffects(_editHistTab, oldRecord).map(e => ({ ...e, delta: -e.delta }))
      .concat(histStockEffects(_editHistTab, newRecord));
    const err = validateStockEffects(applyList);
    if (err) { showToast(err, 'error'); return; }
  }
  try {
    await db.collection(coll).doc(_editHistDocId).update(update);
    await applyStockEffects(applyList, +1);
    invalidateHistCache();
    showToast('Updated. Inventory adjusted.', 'ok');
    closeEditHistModal();
    loadHistory();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) { console.error(e); showToast('Error saving.', 'error'); }
}
async function deleteHistoryRecord(docId, tab) {
  const coll = _histCollMap[tab];
  const record = historyData.find(x => x._docId === docId);
  // Reverse the deleted record's effect on stock.
  const applyList = record ? histStockEffects(tab, record).map(e => ({ ...e, delta: -e.delta })) : [];
  // Removing a record that stock has since been counted around can legitimately
  // leave the number negative. Say so and let the operator decide, rather than
  // refusing to correct the history.
  const negatives = negativeStockEffects(applyList);
  if (!confirm('Delete this record? Inventory will be adjusted accordingly.'
      + (negatives.length ? `\n\nThis takes stock below zero:\n${negatives.join('\n')}` : ''))) return;
  try {
    await db.collection(coll).doc(docId).delete();
    await applyStockEffects(applyList, +1);
    invalidateHistCache();
    showToast('Deleted. Inventory adjusted.', 'ok');
    loadHistory();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) { console.error(e); showToast('Error deleting.', 'error'); }
}

// Delete every line item of a multi-item sale (shared txnId) at once.
async function deleteSalesTxn(txnId) {
  const recs = historyData.filter(x => x.txnId === txnId);
  if (!recs.length) return;
  let applyList = [];
  recs.forEach(r => {
    applyList = applyList.concat(histStockEffects('sales', r).map(e => ({ ...e, delta: -e.delta })));
  });
  if (!confirm(`Delete this entire order (${recs.length} item(s))? Inventory will be adjusted accordingly.`)) return;
  try {
    const batch = db.batch();
    recs.forEach(r => batch.delete(db.collection('sales').doc(r._docId)));
    await batch.commit();
    await applyStockEffects(applyList, +1);
    invalidateHistCache();
    showToast(`Deleted order (${recs.length} item(s)). Inventory adjusted.`, 'ok');
    loadHistory();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) { console.error(e); showToast('Error deleting order.', 'error'); }
}

// ==========================================
// BOOKS CATALOG
// ==========================================
function isAutoIsbn(isbn) {
  return !isbn || isbn.startsWith('NA-');
}

function displayIsbn(isbn) {
  return isAutoIsbn(isbn) ? '—' : isbn;
}

function renderBooks() {
  const search = (document.getElementById('bk-search').value || '').toLowerCase();
  let rows = books.filter(b => !search ||
    b.title.toLowerCase().includes(search) ||
    (!isAutoIsbn(b.isbn) && b.isbn.includes(search)));

  document.getElementById('books-tbody').innerHTML = rows.length ? rows.map(b => `<tr>
    <td class="td-dim">${displayIsbn(b.isbn)}</td>
    <td>${esc(b.title)}</td>
    <td class="ta-r">${fmtMoney(b.costPrice)}</td>
    <td class="ta-r">${fmtMoney(b.sellingPrice)}</td>
    <td>
      <div style="display:flex;gap:4px;">
        <button class="btn btn-secondary btn-sm manager-only" onclick="editBook('${esc(b.id)}')">Edit</button>
        <button class="btn btn-danger btn-sm manager-only" onclick="deleteBook('${esc(b.id)}')">Delete</button>
      </div>
    </td>
  </tr>`).join('') : '<tr><td colspan="5" class="empty-state">No books.</td></tr>';
}

function openBookModal() {
  cancelBookEdit();
  document.getElementById('modal-book').classList.add('open');
}

function closeBookModal() {
  document.getElementById('modal-book').classList.remove('open');
  editingBookIsbn = null;
}

function editBook(docId) {
  const b = books.find(x => x.id === docId);
  if (!b) return;
  editingBookIsbn = b.isbn;
  document.getElementById('bk-isbn').value = isAutoIsbn(b.isbn) ? '' : b.isbn;
  document.getElementById('bk-title').value = b.title;
  document.getElementById('bk-cost').value = b.costPrice || 0;
  document.getElementById('bk-sell').value = b.sellingPrice || 0;
  document.getElementById('book-form-title').textContent = 'Edit Book';
  document.getElementById('modal-book').classList.add('open');
}

// Clears the book form; also closes the modal (called after save/cancel).
function cancelBookEdit() {
  editingBookIsbn = null;
  document.getElementById('bk-isbn').value = '';
  document.getElementById('bk-title').value = '';
  document.getElementById('bk-cost').value = '';
  document.getElementById('bk-sell').value = '';
  document.getElementById('book-form-title').textContent = 'Add Book';
  document.getElementById('modal-book').classList.remove('open');
}

// Stock and history are keyed by ISBN, not by the book's document id, so
// changing a book's ISBN without rewriting the records that point at it
// orphans them: getStock stops finding the stock row, and the history stops
// joining to the book. Rewrite every referencing document alongside the book.
//
// Historical records (sales, restocks, stock-outs, transfers) keep the title
// they were written with — that is the record of what was sold — while rows
// describing current state (inventory, pending orders) follow the book.
const ISBN_HISTORY_COLLECTIONS = ['sales', 'stock_history', 'stock_out', 'transfers'];

async function countIsbnReferences(isbn) {
  const snaps = await Promise.all(
    [...ISBN_HISTORY_COLLECTIONS, 'inventory', 'pending_orders']
      .map(c => db.collection(c).where('isbn', '==', isbn).get()));
  return snaps.reduce((n, s) => n + s.size, 0);
}

async function cascadeIsbnChange(oldIsbn, newIsbn, title) {
  const commitAll = async docs => {
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach(fn => fn(batch));
      await batch.commit();
    }
  };

  let moved = 0, merged = 0;
  for (const coll of ISBN_HISTORY_COLLECTIONS) {
    const snap = await db.collection(coll).where('isbn', '==', oldIsbn).get();
    await commitAll(snap.docs.map(d => b => b.update(d.ref, { isbn: newIsbn })));
    moved += snap.size;
  }

  const ordSnap = await db.collection('pending_orders').where('isbn', '==', oldIsbn).get();
  await commitAll(ordSnap.docs.map(d => b => b.update(d.ref, { isbn: newIsbn, title })));
  moved += ordSnap.size;

  // Inventory is keyed by isbn + branch, so the destination row may already
  // exist at that branch. Fold the stock together instead of leaving a
  // duplicate pair the app would only half-see.
  const [oldSnap, newSnap] = await Promise.all([
    db.collection('inventory').where('isbn', '==', oldIsbn).get(),
    db.collection('inventory').where('isbn', '==', newIsbn).get()
  ]);
  const destByBranch = {};
  newSnap.docs.forEach(d => { destByBranch[d.data().branch] = d.ref; });
  await commitAll(oldSnap.docs.map(d => b => {
    const r = d.data();
    const dest = destByBranch[r.branch];
    if (dest) {
      b.update(dest, { stock: firebase.firestore.FieldValue.increment(Number(r.stock) || 0) });
      b.delete(d.ref);
      merged++;
    } else {
      b.update(d.ref, { isbn: newIsbn, title });
      moved++;
    }
  }));

  return { moved, merged };
}

async function saveBook() {
  const isbnInput = document.getElementById('bk-isbn').value.trim();
  const title = document.getElementById('bk-title').value.trim();
  const costPrice = parseFloat(document.getElementById('bk-cost').value) || 0;
  const sellingPrice = parseFloat(document.getElementById('bk-sell').value) || 0;

  if (!title) { showToast('Title is required.', 'error'); return; }

  try {
    if (editingBookIsbn) {
      const b = books.find(x => x.isbn === editingBookIsbn);
      if (!b) return;
      const newIsbn = isbnInput || b.isbn;
      if (isbnInput && isbnInput !== editingBookIsbn && books.some(x => x.isbn === isbnInput)) {
        showToast('ISBN already exists.', 'error'); return;
      }
      const isbnChanged = newIsbn !== editingBookIsbn;
      if (isbnChanged) {
        const refs = await countIsbnReferences(editingBookIsbn);
        if (refs && !confirm(
            `Changing the ISBN of "${b.title}" from ${editingBookIsbn} to ${newIsbn}.\n\n` +
            `${refs} stock and history record(s) point at the old ISBN and will be moved across, ` +
            `so nothing is left stranded. Continue?`)) return;
      }
      await db.collection('books').doc(b.id).update({ isbn: newIsbn, title, costPrice, sellingPrice });
      Object.assign(b, { isbn: newIsbn, title, costPrice, sellingPrice });
      if (isbnChanged) {
        const { moved, merged } = await cascadeIsbnChange(editingBookIsbn, newIsbn, title);
        await loadInventory();
        showToast(`Book updated. ${moved} record(s) moved to the new ISBN${merged ? `, ${merged} stock row(s) merged` : ''}.`, 'ok');
      } else {
        showToast('Book updated.', 'ok');
      }
    } else {
      if (isbnInput && books.some(b => b.isbn === isbnInput)) {
        showToast('ISBN already exists.', 'error'); return;
      }
      const ref = await db.collection('books').add({
        isbn: isbnInput || '__pending__', title, costPrice, sellingPrice
      });
      const isbn = isbnInput || 'NA-' + ref.id.substring(0, 8);
      if (!isbnInput) await ref.update({ isbn });
      books.push({ id: ref.id, isbn, title, costPrice, sellingPrice });
      books.sort((a, b) => a.title.localeCompare(b.title));
      showToast('Book added!', 'ok');
    }
    cancelBookEdit();
    renderBooks();
    populateBookSelects();
    if (currentTab === 'inventory') renderInventory();
  } catch(e) {
    console.error(e);
    showToast('Error saving book.', 'error');
  }
}

async function deleteBook(docId) {
  const b = books.find(x => x.id === docId);
  if (!b) return;
  if (!confirm(`Delete "${b.title}"? This does not remove inventory records.`)) return;
  await db.collection('books').doc(docId).delete();
  books = books.filter(x => x.id !== docId);
  renderBooks();
  populateBookSelects();
  if (currentTab === 'inventory') renderInventory();
  showToast('Book deleted.', 'ok');
}

// ==========================================
// HELPERS
// ==========================================
// Prevent duplicate Firestore writes from double-clicks: ignore re-entry while
// the wrapped async action is still in flight, and disable the clicked button.
let _writesInFlight = 0;
window.addEventListener('beforeunload', e => {
  if (_writesInFlight > 0) { e.preventDefault(); e.returnValue = ''; }
});
function singleFlight(fn) {
  let busy = false;
  return async function(...args) {
    if (busy) return;
    const evt = window.event;
    const btn = evt && evt.target && evt.target.closest ? evt.target.closest('button') : null;
    busy = true;
    _writesInFlight++;
    if (btn) btn.disabled = true;
    try {
      return await fn.apply(this, args);
    } finally {
      busy = false;
      _writesInFlight--;
      if (btn) btn.disabled = false;
    }
  };
}
processSell = singleFlight(processSell);
processAdjust = singleFlight(processAdjust);
processTransfer = singleFlight(processTransfer);
processTeacherCopy = singleFlight(processTeacherCopy);
addOrder = singleFlight(addOrder);
confirmReceive = singleFlight(confirmReceive);
saveHistoryEdit = singleFlight(saveHistoryEdit);
deleteHistoryRecord = singleFlight(deleteHistoryRecord);
deleteSalesTxn = singleFlight(deleteSalesTxn);
saveBook = singleFlight(saveBook);
deleteBook = singleFlight(deleteBook);
addUser = singleFlight(addUser);
deleteUser = singleFlight(deleteUser);
cancelOrder = singleFlight(cancelOrder);
restoreOrder = singleFlight(restoreOrder);

function exportInventoryCSV() {
  const stockOf = (isbn, branch) => asOfMode ? (asOfStockMap[isbn + '|' + branch] || 0) : getStock(isbn, branch);
  let csv = 'ISBN,Title,Cost Price,Selling Price,IRV,LA,RH,Total\n';
  books.forEach(b => {
    const irv = stockOf(b.isbn,'IRV'), la = stockOf(b.isbn,'LA'), rh = stockOf(b.isbn,'RH');
    csv += [b.isbn, `"${b.title}"`, b.costPrice||0, b.sellingPrice||0, irv, la, rh, irv+la+rh].join(',') + '\n';
  });
  const fname = asOfMode ? `inventory_asof_${asOfLabel.substring(0,10)}.csv` : 'inventory.csv';
  downloadCSV(csv, fname);
}

function exportHistoryCSV() {
  const rows = filterHistRows(historyData);
  if (!rows.length) { showToast('No data to export.', 'error'); return; }
  let csv = '';
  if (currentHistTab === 'all') {
    const label = { sales: 'Sale', stockin: 'Stock In', stockout: 'Stock Out', transfers: 'Transfer' };
    csv = '#,Type,Title,Branch,Change,Stock After,Detail,Note,Date\n';
    rows.forEach((r, i) => {
      const t = r._tab;
      const chg = (t === 'transfers' && histBranch === 'ALL') ? (Number(r.quantity) || 0) : changeOf(t, r);
      const branchTxt = t === 'transfers' ? `${r.fromBranch} -> ${r.toBranch}` : (r.branch || '');
      const detail = t === 'sales'
        ? [r.student, r.paymentSummary, fmtMoney(r.totalPaid)].filter(Boolean).join(' / ')
        : (t === 'stockin' ? (r.orderSource || '')
        : (t === 'stockout' && r.teacher ? `Teacher: ${r.teacher}` : ''));
      csv += [rows.length-i, label[t], `"${r.title}"`, `"${branchTxt}"`, chg, `"${stockAfterAllOf(t, r)}"`, `"${detail}"`, `"${r.note||''}"`, r._date].join(',') + '\n';
    });
  } else if (currentHistTab === 'sales') {
    csv = '#,TxnID,Title,Branch,Student,Qty,Stock After,Price,TxnDiscount,Paid,Payment,Note,Date\n';
    rows.forEach((r, i) => { csv += [rows.length-i,r.txnId||'',`"${r.title}"`,r.branch,`"${r.student||''}"`,r.quantity,stockAfterOf('sales', r),r.sellingPrice,r.txnDiscount||r.discount||0,r.totalPaid,`"${r.paymentSummary||''}"`,`"${r.note||''}"`,r.soldAt].join(',') + '\n'; });
  } else if (currentHistTab === 'stockin') {
    csv = '#,Title,Branch,Qty,Stock After,Source,Note,Date\n';
    rows.forEach((r, i) => { csv += [rows.length-i,`"${r.title}"`,r.branch,r.quantity,stockAfterOf('stockin', r),`"${r.orderSource||''}"`,`"${r.note||''}"`,r.createdAt].join(',') + '\n'; });
  } else if (currentHistTab === 'stockout') {
    csv = '#,Title,Branch,Qty,Stock After,Teacher,Note,Date\n';
    rows.forEach((r, i) => { csv += [rows.length-i,`"${r.title}"`,r.branch,r.quantity,stockAfterOf('stockout', r),`"${r.teacher||''}"`,`"${r.note||''}"`,r.createdAt].join(',') + '\n'; });
  } else if (currentHistTab === 'transfers') {
    csv = '#,Title,From,To,Qty,Stock After,Note,Date\n';
    rows.forEach((r, i) => { csv += [rows.length-i,`"${r.title}"`,r.fromBranch,r.toBranch,r.quantity,`"${stockAfterOf('transfers', r)}"`,`"${r.note||''}"`,r.createdAt].join(',') + '\n'; });
  }
  downloadCSV(csv, currentHistTab + '_history.csv');
}

function downloadCSV(csv, filename) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// Close modals on outside click
document.getElementById('receive-modal').addEventListener('click', function(e) {
  if (e.target === this) closeReceiveModal();
});
document.getElementById('modal-adjust').addEventListener('click', function(e) {
  if (e.target === this) closeAdjustModal();
});
document.getElementById('modal-transfer').addEventListener('click', function(e) {
  if (e.target === this) closeTransferModal();
});
document.getElementById('modal-teacher').addEventListener('click', function(e) {
  if (e.target === this) closeTeacherCopyModal();
});
document.getElementById('modal-order').addEventListener('click', function(e) {
  if (e.target === this) closeOrderModal();
});
document.getElementById('modal-book').addEventListener('click', function(e) {
  if (e.target === this) closeBookModal();
});
document.getElementById('modal-user').addEventListener('click', function(e) {
  if (e.target === this) closeUserModal();
});

// ==========================================
// AUTH
// ==========================================
const googleProvider = new firebase.auth.GoogleAuthProvider();

function doSignOut() {
  firebase.auth().signOut().then(() => { window.location.href = '/'; });
}

firebase.auth().onAuthStateChanged(async user => {
  if (user && user.email.endsWith('@lascusa.com')) {
    currentUser = user;
    try {
      const snap = await db.collection('users').doc(user.email).get();
      if (snap.exists) {
        currentRole = snap.data().role || 'staff';
      } else {
        currentRole = 'staff';
        await db.collection('users').doc(user.email).set({ email: user.email, role: 'staff' });
      }
    } catch(e) {
      currentRole = 'staff';
    }
    document.body.classList.add('role-' + currentRole);
    document.getElementById('user-email-display').textContent = user.email;
    const badge = document.getElementById('role-badge');
    badge.textContent = currentRole;
    badge.className = 'role-badge ' + currentRole;
    document.getElementById('user-info').style.display = 'flex';
    const savedInStock = localStorage.getItem('inv_instock_only');
    if (savedInStock !== null) document.getElementById('inv-instock-only').checked = savedInStock === '1';
    document.getElementById('sell-time').value = nowLA().substring(11,16);
    loadAll().then(() => {
      const urlTab = new URLSearchParams(location.search).get('tab');
      const savedTab = localStorage.getItem('inventory_tab');
      const savedHistTab = localStorage.getItem('inventory_hist_tab');
      const tabToLoad = urlTab || savedTab || 'inventory';

      // Restore the selected branch (ALL is manager-only).
      const savedBranch = localStorage.getItem('inventory_branch');
      const branchToUse = (savedBranch && ['LA','RH','IRV','ALL'].includes(savedBranch)
        && (savedBranch !== 'ALL' || currentRole === 'manager')) ? savedBranch : currentBranch;
      setBranch(branchToUse);

      // Restore history filters before loading the history tab.
      restoreHistFilters();

      if (tabToLoad !== 'inventory') switchTab(tabToLoad);
      if (savedHistTab && savedHistTab !== 'sales') switchHistoryTab(savedHistTab);
    }).finally(() => {
      const ld = document.getElementById('app-loading'); if (ld) ld.style.display = 'none';
    });
  } else {
    window.location.href = '/';
  }
});

// ==========================================
// USERS MANAGEMENT
// ==========================================
function openUserModal() {
  document.getElementById('new-user-email').value = '';
  document.getElementById('new-user-role').value = 'staff';
  document.getElementById('modal-user').classList.add('open');
}

function closeUserModal() {
  document.getElementById('modal-user').classList.remove('open');
}

async function loadUsers() {
  if (currentRole !== 'manager') return;
  try {
    const snap = await db.collection('users').orderBy('email').get();
    usersData = snap.docs.map(d => ({ uid: d.id, ...d.data() }));
    renderUsers();
  } catch(e) {
    showToast('Error loading users.', 'error');
  }
}

function renderUsers() {
  const cont = document.getElementById('users-list');
  if (!usersData.length) { cont.innerHTML = '<div class="empty-state">No users yet.</div>'; return; }
  cont.innerHTML = usersData.map(u => `
    <div class="user-row">
      <span style="flex:1;">${esc(u.email)}</span>
      <select onchange="changeRole('${esc(u.uid)}', this.value)" style="padding:4px 8px;border:1px solid #d0d0d0;border-radius:5px;font-size:12px;font-family:inherit;">
        <option value="staff" ${u.role === 'staff' ? 'selected' : ''}>Staff</option>
        <option value="manager" ${u.role === 'manager' ? 'selected' : ''}>Manager</option>
      </select>
      <button class="btn btn-danger btn-sm" onclick="deleteUser('${esc(u.uid)}')">Remove</button>
    </div>`).join('');
}

async function addUser() {
  const email = document.getElementById('new-user-email').value.trim().toLowerCase();
  const role = document.getElementById('new-user-role').value;
  if (!email || !email.endsWith('@lascusa.com')) { showToast('Please enter a lascusa.com email address.', 'error'); return; }
  try {
    await db.collection('users').doc(email).set({ email, role }, { merge: true });
    const existing = usersData.find(u => u.uid === email);
    if (existing) {
      existing.role = role;
    } else {
      usersData.push({ uid: email, email, role });
      usersData.sort((a, b) => a.email.localeCompare(b.email));
    }
    renderUsers();
    closeUserModal();
    showToast(`${email} (${role}) saved`, 'ok');
  } catch(e) {
    showToast('Error saving user.', 'error');
  }
}

async function changeRole(uid, role) {
  try {
    await db.collection('users').doc(uid).update({ role });
    const u = usersData.find(x => x.uid === uid);
    if (u) u.role = role;
    showToast('Role updated.', 'ok');
  } catch(e) {
    showToast('Error updating role.', 'error');
  }
}

async function deleteUser(uid) {
  if (!confirm('Remove this user?')) return;
  try {
    await db.collection('users').doc(uid).delete();
    usersData = usersData.filter(u => u.uid !== uid);
    renderUsers();
    showToast('User removed.', 'ok');
  } catch(e) {
    showToast('Error removing user.', 'error');
  }
}
