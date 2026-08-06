/* Shared utilities — index.html and inventory.html */

function escHtml(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
const esc = escHtml;

/* Accounts allowed to use the Attendance tab while it is being trialed.
   Add an email here to grant access — that is the only change needed.
   Every page calls applyAttendanceAccess() once auth resolves; the tab is
   hidden by default via .attendance-only in shared.css, and attendance.js
   redirects anyone not on this list who opens /attendance directly. */
const ATTENDANCE_USERS = ['esl@lascusa.com'];

function isAttendanceUser(email) {
  return ATTENDANCE_USERS.includes(String(email || '').trim().toLowerCase());
}

function applyAttendanceAccess(email) {
  if (isAttendanceUser(email)) document.body.classList.add('user-attendance');
}

function showToast(msg, type='') {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t); el._t = setTimeout(() => { el.className = 'toast'; }, 3000);
}
