/* LASC Attendance / Makeup Calculator
 *
 * Ported from the "LASC Makeup Options" spreadsheet.
 *
 * Model
 * -----
 * A student belongs to a branch (IRV / LA / RH) and a class type. Each
 * (branch, class type) pair maps to a PLAN describing how many class hours fall
 * on each weekday, plus the makeup class formats that student may take.
 *
 * Attendance % = attended hours / total hours, over the whole quarter.
 * Makeup credit hours are added to the numerator ONLY — they raise the
 * percentage without growing the denominator. 1 PT hour = 2 credit hours.
 *
 * No-class days (US federal holidays + School Calendar events) are skipped when
 * counting hours; the School Calendar in the Scheduler is the single source.
 */

// ==========================================
// PLANS — one per sheet in the source workbook
// hours maps JS getDay() (0=Sun … 6=Sat) to class hours on that weekday.
// ==========================================
const PT_RATE = 65;          // $ per PT hour
const PT_CREDIT_MULTIPLIER = 2;  // 1 PT hour counts as 2 credit hours
const MAKEUP_RATE = 15;      // $ per makeup credit hour

const PLANS = {
  // Sheet: "IRV/RH Morning"
  'morning-45': {
    label: 'Morning',
    regular: { desc: 'Mon–Thu, 4.5 hrs/day', hours: { 1: 4.5, 2: 4.5, 3: 4.5, 4: 4.5 } },
    makeups: [
      { key: 'evening', label: 'Evening Class', desc: 'Mon–Wed 5 hrs, Thu 3 hrs', hours: { 1: 5, 2: 5, 3: 5, 4: 3 } }
    ]
  },
  // Sheet: "All Evening / LA Morning"
  'evening-5533': {
    label: 'Evening / LA Morning',
    regular: { desc: 'Mon–Wed 5 hrs, Thu 3 hrs', hours: { 1: 5, 2: 5, 3: 5, 4: 3 } },
    makeups: [
      { key: 'morning', label: 'Morning Class', desc: 'Mon–Thu 4.5 hrs/day', hours: { 1: 4.5, 2: 4.5, 3: 4.5, 4: 4.5 } }
    ]
  },
  // Sheet: "IRV 2-Day"
  'irv-2day': {
    label: 'IRV 2-Day',
    regular: { desc: 'Tue–Wed, 9 hrs/day', hours: { 2: 9, 3: 9 } },
    makeups: [
      { key: 'morning', label: 'Morning Class', desc: 'Mon & Thu, 4.5 hrs/day', hours: { 1: 4.5, 4: 4.5 } },
      { key: 'evening', label: 'Evening Class', desc: 'Mon 5 hrs, Thu 3 hrs', hours: { 1: 5, 4: 3 } }
    ]
  },
  // Sheet: "LA ESL 2-Day"
  'la-esl-2day': {
    label: 'LA ESL 2-Day',
    regular: { desc: 'Mon & Wed, 9 hrs/day', hours: { 1: 9, 3: 9 } },
    makeups: [
      { key: 'morning', label: 'Morning Class', desc: 'Tue 5 hrs, Thu 3 hrs', hours: { 2: 5, 4: 3 } },
      { key: 'evening', label: 'Evening Class', desc: 'Mon–Wed 5 hrs, Thu 3 hrs', hours: { 1: 5, 2: 5, 3: 5, 4: 3 } }
    ]
  },
  // Sheet: "LA BE 2-Day"
  'la-be-2day': {
    label: 'LA BE 2-Day',
    regular: { desc: 'Tue–Wed, 9 hrs/day', hours: { 2: 9, 3: 9 } },
    makeups: [
      { key: 'be', label: 'BE Class', desc: 'Mon 5 hrs, Thu 3 hrs', hours: { 1: 5, 4: 3 } }
    ]
  }
};

// Class types offered at each branch, in menu order.
const BRANCH_CLASS_TYPES = {
  IRV: [
    { id: 'morning', label: 'Morning', plan: 'morning-45' },
    { id: 'evening', label: 'Evening', plan: 'evening-5533' },
    { id: '2day',    label: '2-Day',   plan: 'irv-2day' }
  ],
  LA: [
    { id: 'morning',  label: 'Morning',    plan: 'evening-5533' },
    { id: 'evening',  label: 'Evening',    plan: 'evening-5533' },
    { id: 'esl2day',  label: 'ESL 2-Day',  plan: 'la-esl-2day' },
    { id: 'be2day',   label: 'BE 2-Day',   plan: 'la-be-2day' }
  ],
  RH: [
    { id: 'morning', label: 'Morning', plan: 'morning-45' },
    { id: 'evening', label: 'Evening', plan: 'evening-5533' }
  ]
};

const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const Q_LABELS = ['','Winter','Spring','Summer','Fall'];

// ==========================================
// STATE
// ==========================================
let currentUser = null, currentRole = 'staff';
let quarters = [], schoolEvents = [];
let selBranch = 'LA';
let selClassType = 'morning';
let lastResult = null;   // cached calc output, for Copy Summary

// ==========================================
// DATE UTILITIES (same conventions as index.html — local dates, never UTC)
// ==========================================
function dateToStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function strToDate(s) { return new Date(s + 'T00:00:00'); }
function fmtDate(s) { if(!s) return ''; const [y,m,d] = s.split('-'); return `${m.padStart(2,'0')}/${d.padStart(2,'0')}/${y}`; }
function addDays(s, n) { const d = strToDate(s); d.setDate(d.getDate() + n); return dateToStr(d); }
function todayStr() { return dateToStr(new Date()); }

const _usHolCache = {};
function getUSHolidays(year) {
  if (_usHolCache[year]) return _usHolCache[year];
  const h = {};
  function fixed(m, d, name) {
    const dt = new Date(year, m - 1, d);
    const dow = dt.getDay();
    if (dow === 0) dt.setDate(dt.getDate() + 1);
    else if (dow === 6) dt.setDate(dt.getDate() - 1);
    h[dateToStr(dt)] = name;
  }
  function nth(m, n, weekday, name) {
    if (n > 0) {
      const dt = new Date(year, m - 1, 1);
      dt.setDate(1 + ((weekday - dt.getDay() + 7) % 7) + (n - 1) * 7);
      h[dateToStr(dt)] = name;
    } else {
      const dt = new Date(year, m, 0);
      dt.setDate(dt.getDate() - ((dt.getDay() - weekday + 7) % 7));
      h[dateToStr(dt)] = name;
    }
  }
  fixed(1,1,"New Year's Day");
  nth(1,3,1,"MLK Day");
  nth(2,3,1,"Presidents' Day");
  nth(5,-1,1,"Memorial Day");
  fixed(6,19,"Juneteenth");
  fixed(7,4,"Independence Day");
  nth(9,1,1,"Labor Day");
  nth(10,2,1,"Columbus Day");
  fixed(11,11,"Veterans Day");
  nth(11,4,4,"Thanksgiving");
  fixed(12,25,"Christmas Day");
  _usHolCache[year] = h;
  return h;
}
function getHolidayName(dateStr) {
  return getUSHolidays(parseInt(dateStr.slice(0,4)))[dateStr] || null;
}

// A day with no classes. Mirrors isDateBlocked() in index.html so the two pages
// never disagree about which days count.
function isDateBlocked(dateStr) {
  if (schoolEvents.some(e => e.date === dateStr && e.type === 'school_open')) return false;
  if (getHolidayName(dateStr)) return true;
  if (schoolEvents.some(e => e.date === dateStr && (e.type === 'holiday' || e.type === 'anniversary'))) return true;
  return false;
}
function blockedReason(dateStr) {
  const evt = schoolEvents.find(e => e.date === dateStr && (e.type === 'holiday' || e.type === 'anniversary'));
  return getHolidayName(dateStr) || (evt && evt.name) || 'No classes';
}

// ==========================================
// CALENDAR MATH
// ==========================================
// Class days in [startStr, endStr], both ends inclusive, skipping no-class days.
function classDays(startStr, endStr, hoursByDow) {
  const days = [], skipped = [];
  if (!startStr || !endStr || startStr > endStr) return { days, skipped };
  const end = strToDate(endStr);
  const d = strToDate(startStr);
  let guard = 0;
  while (d <= end && guard++ < 2000) {
    const ds = dateToStr(d);
    const hrs = hoursByDow[d.getDay()] || 0;
    if (hrs > 0) {
      if (isDateBlocked(ds)) skipped.push({ date: ds, hours: hrs, reason: blockedReason(ds) });
      else days.push({ date: ds, hours: hrs });
    }
    d.setDate(d.getDate() + 1);
  }
  return { days, skipped };
}

// Walk forward from startStr until `creditHours` of makeup class have accrued.
// Returns the days used and whether the target was reachable.
function makeupSchedule(startStr, creditHours, hoursByDow) {
  const days = [];
  let acc = 0;
  if (!(creditHours > 0)) return { days, hours: 0, complete: true };
  const d = strToDate(startStr);
  let guard = 0;
  while (acc < creditHours && guard++ < 400) {
    const ds = dateToStr(d);
    const hrs = hoursByDow[d.getDay()] || 0;
    if (hrs > 0 && !isDateBlocked(ds)) { days.push({ date: ds, hours: hrs }); acc += hrs; }
    d.setDate(d.getDate() + 1);
  }
  return { days, hours: acc, complete: acc >= creditHours };
}

function sumHours(days) { return days.reduce((t, x) => t + x.hours, 0); }
function round2(n) { return Math.round(n * 100) / 100; }
function ceilHalf(n) { return Math.ceil(n * 2 - 1e-9) / 2; }   // round up to nearest 0.5 hr
function pct(n) { return (n * 100).toFixed(1) + '%'; }
function money(n) { return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

function activePlan() {
  const types = BRANCH_CLASS_TYPES[selBranch] || [];
  const t = types.find(x => x.id === selClassType) || types[0];
  return t ? PLANS[t.plan] : null;
}

// ==========================================
// SETUP UI
// ==========================================
function setBranch(b) {
  selBranch = b;
  document.querySelectorAll('.branch-btn').forEach(el => el.classList.toggle('active', el.dataset.branch === b));
  const types = BRANCH_CLASS_TYPES[b];
  if (!types.some(t => t.id === selClassType)) selClassType = types[0].id;
  renderClassTypes();
  calculate();
}

function renderClassTypes() {
  const el = document.getElementById('class-types');
  el.innerHTML = (BRANCH_CLASS_TYPES[selBranch] || []).map(t =>
    `<button class="type-btn${t.id === selClassType ? ' active' : ''}" data-type="${t.id}" onclick="setClassType('${t.id}')">${escHtml(t.label)}</button>`
  ).join('');
}

function setClassType(id) {
  selClassType = id;
  renderClassTypes();
  calculate();
}

function renderQuarters() {
  const sel = document.getElementById('a-quarter');
  const today = todayStr();
  const sorted = quarters.slice().sort((a, b) =>
    a.year !== b.year ? b.year - a.year : b.quarter - a.quarter);
  sel.innerHTML = '<option value="">— Select Quarter —</option>' + sorted.map(q =>
    `<option value="${escHtml(q.id)}">${q.year} Q${q.quarter} ${Q_LABELS[q.quarter]} · ${fmtDate(q.startDate)} – ${fmtDate(q.endDate)}</option>`
  ).join('');
  const current = sorted.find(q => q.startDate <= today && q.endDate >= today);
  if (current) { sel.value = current.id; onQuarterChange(); }
}

// Selecting a quarter fills the date range: the future period runs from today
// (or the quarter start, whichever is later) through the quarter's last day.
function onQuarterChange() {
  const q = quarters.find(x => x.id === document.getElementById('a-quarter').value);
  if (!q) { calculate(); return; }
  const today = todayStr();
  document.getElementById('a-future-start').value = today > q.startDate ? today : q.startDate;
  document.getElementById('a-future-end').value = q.endDate;
  calculate();
}

// ==========================================
// CALCULATION
// ==========================================
function calculate() {
  const plan = activePlan();
  const out = document.getElementById('result');
  const planHint = document.getElementById('plan-hint');
  if (!plan) { out.innerHTML = ''; return; }

  planHint.textContent = `Regular class: ${plan.regular.desc}`;

  const presentHrs = parseFloat(document.getElementById('a-present').value) || 0;
  const totalHrs   = parseFloat(document.getElementById('a-total').value) || 0;
  const absenceHrs = parseFloat(document.getElementById('a-absence').value) || 0;
  const required   = (parseFloat(document.getElementById('a-required').value) || 80) / 100;
  const fStart     = document.getElementById('a-future-start').value;
  const fEnd       = document.getElementById('a-future-end').value;

  // Remaining regular classes
  const future = classDays(fStart, fEnd, plan.regular.hours);
  const futureTotal = sumHours(future.days);
  const futurePresent = Math.max(0, futureTotal - absenceHrs);

  document.getElementById('future-readout').innerHTML = (!fStart || !fEnd)
    ? '<span style="color:#94a3b8;">Select a quarter to fill the date range.</span>'
    : `<b>${future.days.length}</b> class day${future.days.length === 1 ? '' : 's'} ·
       <b>${round2(futureTotal)}</b> hrs remaining` +
      (future.skipped.length ? ` <span style="color:#92400e;">(${future.skipped.length} no-class day${future.skipped.length === 1 ? '' : 's'} skipped)</span>` : '');

  renderSkipped(future.skipped);

  if (totalHrs <= 0) {
    out.innerHTML = `<div class="empty-state">Enter the student's attended and total hours to see the result.</div>`;
    lastResult = null;
    document.getElementById('plan-check').style.display = 'none';
    return;
  }

  const currentPct   = presentHrs / totalHrs;
  const projTotal    = totalHrs + futureTotal;
  const projPresent  = presentHrs + futurePresent;
  const projPct      = projTotal > 0 ? projPresent / projTotal : 0;

  // Makeup raises the numerator only, so the shortfall is measured against the
  // projected total: credit = required × projectedTotal − projectedPresent.
  const shortfall = required * projTotal - projPresent;
  const creditNeeded = shortfall > 0.001 ? ceilHalf(shortfall) : 0;

  lastResult = { plan, presentHrs, totalHrs, currentPct, futureTotal, futurePresent,
                 absenceHrs, projTotal, projPresent, projPct, required, creditNeeded, fStart, fEnd };

  let html = `
    <div class="stat-row">
      <div class="stat"><div class="stat-label">Current</div><div class="stat-val">${pct(currentPct)}</div>
        <div class="stat-sub">${round2(presentHrs)} / ${round2(totalHrs)} hrs</div></div>
      <div class="stat-arrow">&#8594;</div>
      <div class="stat"><div class="stat-label">${absenceHrs > 0 ? 'Projected end of quarter' : 'If no more absences'}</div>
        <div class="stat-val ${projPct >= required ? 'good' : 'bad'}">${pct(projPct)}</div>
        <div class="stat-sub">${round2(projPresent)} / ${round2(projTotal)} hrs</div></div>
      <div class="stat"><div class="stat-label">Required</div><div class="stat-val req">${pct(required)}</div>
        <div class="stat-sub">&nbsp;</div></div>
    </div>`;

  if (creditNeeded <= 0) {
    html += `<div class="ok-box"><b>&#10003; No makeup needed.</b> Attending every remaining class puts the
      student at ${pct(projPct)}, which meets the ${pct(required)} requirement.</div>`;
  } else {
    const maxPossible = projTotal > 0 ? (presentHrs + futureTotal) / projTotal : 0;
    if (absenceHrs > 0 && maxPossible >= required) {
      html += `<div class="warn-box">With <b>${round2(absenceHrs)} hrs</b> of expected absence the student falls short.
        Attending everything from here would reach ${pct(maxPossible)} and no makeup would be needed.</div>`;
    }
    const why = absenceHrs > 0
      ? `With ${round2(absenceHrs)} hrs of absence still expected, the student ends the quarter at ${pct(projPct)}.`
      : `Even attending every remaining class from ${fmtDate(fStart)} on, the student reaches only ${pct(projPct)}.`;
    html += `<div class="alert-box"><b>&#9888; Makeup required.</b> ${why}
      <b>${round2(creditNeeded)} credit hours</b> are needed to reach ${pct(required)}.</div>`;

    // Option 1 — Private Tutoring (1 hr = 2 credit hours)
    const ptHours = ceilHalf(creditNeeded / PT_CREDIT_MULTIPLIER);
    html += `<div class="opt-grid">
      <div class="opt">
        <div class="opt-head">Option 1 · Private Tutoring</div>
        <div class="opt-note">1 PT hour = ${PT_CREDIT_MULTIPLIER} credit hours · ${money(PT_RATE)}/hr</div>
        <div class="opt-big">${round2(ptHours)} PT hrs</div>
        <div class="opt-price">${money(ptHours * PT_RATE)}</div>
        <div class="opt-sub">= ${round2(ptHours * PT_CREDIT_MULTIPLIER)} credit hrs &#8594; ${pct((projPresent + ptHours * PT_CREDIT_MULTIPLIER) / projTotal)}</div>
      </div>`;

    // Option 2+ — makeup classes, one box per available format
    const mkStart = document.getElementById('a-makeup-start').value || todayStr();
    plan.makeups.forEach((m, i) => {
      const sched = makeupSchedule(mkStart, creditNeeded, m.hours);
      const useHrs = sched.complete ? sumHours(sched.days) : 0;
      html += `<div class="opt">
        <div class="opt-head">Option ${i + 2} · ${escHtml(m.label)}</div>
        <div class="opt-note">${escHtml(m.desc)} · ${money(MAKEUP_RATE)}/credit hr</div>
        <div class="opt-big">${round2(creditNeeded)} credit hrs</div>
        <div class="opt-price">${money(creditNeeded * MAKEUP_RATE)}</div>
        <div class="opt-sub">${sched.complete
          ? `${sched.days.length} makeup day${sched.days.length === 1 ? '' : 's'} · ${fmtDate(sched.days[0].date)} – ${fmtDate(sched.days[sched.days.length - 1].date)} (${round2(useHrs)} hrs available)`
          : `<span style="color:#b91c1c;">Not reachable within 400 days from ${fmtDate(mkStart)}</span>`}</div>
      </div>`;
    });
    html += `</div>`;
  }

  out.innerHTML = html;
  document.getElementById('plan-check').style.display = '';
  renderPlanInputs();
  runPlanCheck();
}

function renderSkipped(skipped) {
  const box = document.getElementById('skipped-list');
  const sum = document.getElementById('skipped-summary');
  sum.textContent = `No-class days skipped in the remaining period (${skipped.length})`;
  box.innerHTML = skipped.length
    ? skipped.map(s => `<div class="skip-row"><span>${fmtDate(s.date)} (${DOW_NAMES[strToDate(s.date).getDay()]})</span>
        <span class="skip-hrs">−${round2(s.hours)} hrs</span>
        <span class="skip-why">${escHtml(s.reason)}</span></div>`).join('')
    : '<div class="empty-state" style="padding:14px;">None.</div>';
}

// ==========================================
// PLAN CHECK — mirrors the workbook's "After Makeup" row.
// Enter any mix of PT hours and makeup credit hours and see the final result.
// ==========================================
function renderPlanInputs() {
  const plan = activePlan();
  const wrap = document.getElementById('plan-makeup-inputs');
  const existing = {};
  wrap.querySelectorAll('input[data-mk]').forEach(i => { existing[i.dataset.mk] = i.value; });
  wrap.innerHTML = plan.makeups.map(m => `
    <div class="form-group" style="margin-bottom:0;">
      <label>${escHtml(m.label)} (credit hrs)</label>
      <input type="number" min="0" step="0.5" data-mk="${escHtml(m.key)}"
             value="${escHtml(existing[m.key] || '')}" placeholder="0" oninput="runPlanCheck()">
    </div>`).join('');
}

function runPlanCheck() {
  if (!lastResult) return;
  const { projPresent, projTotal, required } = lastResult;
  const ptHours = parseFloat(document.getElementById('plan-pt').value) || 0;
  let makeupCredits = 0;
  document.querySelectorAll('#plan-makeup-inputs input[data-mk]').forEach(i => {
    makeupCredits += parseFloat(i.value) || 0;
  });

  const credits = ptHours * PT_CREDIT_MULTIPLIER + makeupCredits;
  const price = ptHours * PT_RATE + makeupCredits * MAKEUP_RATE;
  const finalPresent = projPresent + credits;
  const finalPct = projTotal > 0 ? finalPresent / projTotal : 0;

  document.getElementById('plan-result').innerHTML = `
    <div class="stat-row">
      <div class="stat"><div class="stat-label">Credit hours added</div><div class="stat-val small">${round2(credits)}</div></div>
      <div class="stat"><div class="stat-label">Total price</div><div class="stat-val small">${money(price)}</div></div>
      <div class="stat"><div class="stat-label">Final attendance</div>
        <div class="stat-val ${finalPct >= required ? 'good' : 'bad'}">${pct(finalPct)}</div>
        <div class="stat-sub">${round2(finalPresent)} / ${round2(projTotal)} hrs</div></div>
    </div>`;
}

// ==========================================
// COPY SUMMARY
// ==========================================
function copySummary() {
  if (!lastResult) { showToast('Nothing to copy yet.', 'error'); return; }
  const r = lastResult;
  const name = document.getElementById('a-student').value.trim() || '(student)';
  const qSel = document.getElementById('a-quarter');
  const qText = qSel.options[qSel.selectedIndex] ? qSel.options[qSel.selectedIndex].text : '';
  const typeLabel = (BRANCH_CLASS_TYPES[selBranch].find(t => t.id === selClassType) || {}).label || '';

  const lines = [
    `LASC Makeup Calculation — ${name}`,
    `${qText}`,
    `Branch: ${selBranch} · Class: ${typeLabel} (${r.plan.regular.desc})`,
    ``,
    `Attendance so far : ${round2(r.presentHrs)} / ${round2(r.totalHrs)} hrs = ${pct(r.currentPct)}`,
    `Remaining classes : ${round2(r.futureTotal)} hrs (${fmtDate(r.fStart)} – ${fmtDate(r.fEnd)})`,
    r.absenceHrs > 0 ? `Expected absence  : ${round2(r.absenceHrs)} hrs` : null,
    `Projected         : ${round2(r.projPresent)} / ${round2(r.projTotal)} hrs = ${pct(r.projPct)}`,
    `Required          : ${pct(r.required)}`,
    ``
  ].filter(x => x !== null);

  if (r.creditNeeded <= 0) {
    lines.push('Result: meets the requirement — no makeup needed.');
  } else {
    const ptHours = ceilHalf(r.creditNeeded / PT_CREDIT_MULTIPLIER);
    lines.push(`Result: ${round2(r.creditNeeded)} credit hours short.`);
    lines.push(`  Option 1 — Private Tutoring: ${round2(ptHours)} hrs = ${money(ptHours * PT_RATE)}`);
    r.plan.makeups.forEach((m, i) => {
      lines.push(`  Option ${i + 2} — ${m.label} (${m.desc}): ${round2(r.creditNeeded)} credit hrs = ${money(r.creditNeeded * MAKEUP_RATE)}`);
    });
  }

  const text = lines.join('\n');
  navigator.clipboard.writeText(text)
    .then(() => showToast('Summary copied to clipboard.', 'ok'))
    .catch(() => showToast('Could not copy to clipboard.', 'error'));
}

function resetForm() {
  ['a-student','a-present','a-total','a-absence','plan-pt'].forEach(id => { document.getElementById(id).value = ''; });
  document.querySelectorAll('#plan-makeup-inputs input[data-mk]').forEach(i => { i.value = ''; });
  document.getElementById('a-required').value = 80;
  document.getElementById('a-makeup-start').value = todayStr();
  onQuarterChange();
}

// ==========================================
// DATA LOADING
// ==========================================
async function loadAll() {
  const [qSnap, eSnap] = await Promise.all([
    db.collection('quarters').get(),
    db.collection('school_events').get()
  ]);
  quarters = qSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  schoolEvents = eSnap.docs.map(d => ({ id: d.id, ...d.data() }));
  renderQuarters();
  if (!quarters.length) {
    document.getElementById('no-quarters').style.display = '';
  }
  calculate();
}

// ==========================================
// AUTH
// ==========================================
function doSignOut() {
  firebase.auth().signOut().then(() => { window.location.href = '/'; });
}

firebase.auth().onAuthStateChanged(async user => {
  // Signed out, non-LASC, or not on the Attendance allow-list (utils.js) — send
  // them to the Scheduler rather than showing an empty page.
  if (user && user.email.endsWith('@lascusa.com') && isAttendanceUser(user.email)) {
    currentUser = user;
    try {
      const snap = await db.collection('users').doc(user.email).get();
      currentRole = snap.exists ? (snap.data().role || 'staff') : 'staff';
      if (!snap.exists) await db.collection('users').doc(user.email).set({ email: user.email, role: 'staff' });
    } catch(e) {
      currentRole = 'staff';
    }
    document.body.classList.add('role-' + currentRole);
    document.getElementById('user-email-display').textContent = user.email;
    const badge = document.getElementById('role-badge');
    badge.textContent = currentRole;
    badge.className = 'role-badge ' + currentRole;
    document.getElementById('user-info').style.display = 'flex';

    document.getElementById('a-makeup-start').value = todayStr();
    renderClassTypes();
    setBranch(selBranch);

    loadAll()
      .catch(() => showToast('Error loading quarters / school calendar.', 'error'))
      .finally(() => { const ld = document.getElementById('app-loading'); if (ld) ld.style.display = 'none'; });
  } else {
    window.location.href = '/';
  }
});
