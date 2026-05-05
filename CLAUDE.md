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

## Key Conventions

- No build tools, bundlers, or transpilers — plain `.html`, `.css`, `.js` files
- Firebase SDK loaded via CDN module imports inside each HTML file
- Firestore is the primary data store — all reads/writes go through the Firestore SDK
- No shared JS files; each page is self-contained

## Firebase

- Project config is inlined in each HTML file (firebase config object)
- Auth: not currently implemented
- Security rules: `firestore.rules`

## Development

Open `index.html` or `inventory.html` directly in a browser, or serve via:

```
firebase emulators:start
```

To deploy:

```
firebase deploy
```
