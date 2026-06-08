# LASC Scheduler

Web app for LASC language school (lascusa.com) — teacher scheduling and book inventory management.

## Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no frameworks)
- **Backend/DB**: Firebase Firestore
- **Hosting**: Firebase Hosting

## Pages

- **`index.html`** — Scheduler: teacher list, per-teacher schedule (weekly grid), PT session tracker, contracts
- **`inventory.html`** — Book Inventory: stock management, sell, stock-in/out, orders, transfer between branches (LA / RH / IRV)

Both pages share a top navigation bar (Scheduler | Inventory tabs) and the same LASC logo.

## Shared Files

- **`shared.css`** — common styles (layout, components, role-based UI visibility)
- **`utils.js`** — `escHtml` / `showToast` utilities, included by both pages
- **`firebase-init.js`** — Firebase app init and `db` export, included by both pages

## Language

- **All program text must be in English** — UI labels, button text, placeholder text, toast messages, comments, variable names, everything in the code
- Conversation with the user is in Korean; the codebase and application are entirely in English
- Never write Korean characters inside `.html`, `.css`, or `.js` files

## Key Conventions

- No build tools, bundlers, or transpilers — plain `.html`, `.css`, `.js` files
- Firebase SDK loaded via CDN script tags; `firebase-init.js` handles `initializeApp` and exports `db`
- Firestore is the primary data store — all reads/writes go through the Firestore SDK
- Role-based UI: `body.role-staff .manager-only { display:none }` in `shared.css`; roles stored in Firestore `/users/{email}.role`

## Firebase

- Project: `lasc-scheduler` (see `firebase-init.js` for config)
- Auth: Google Sign-In (`@lascusa.com` accounts only), managed inside each HTML file
- Security rules: `firestore.rules` — manager vs. staff write permissions per collection

## Development

Open `index.html` or `inventory.html` directly in a browser, or serve via:

```
firebase emulators:start
```

To deploy:

```
firebase deploy
```
