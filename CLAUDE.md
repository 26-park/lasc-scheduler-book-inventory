# LASC Scheduler

Teacher scheduling web app for LASC language school.

## Stack

- **Frontend**: Vanilla HTML, CSS, JavaScript (no frameworks)
- **Backend/DB**: Firebase Firestore
- **Hosting**: Firebase Hosting (assumed)

## Project Overview

A web application for managing teacher schedules at LASC (Language Arts and Studies Center / lascusa.com). Handles scheduling, assignment, and visibility of teacher sessions/classes.

## Key Conventions

- No build tools, bundlers, or transpilers — plain `.html`, `.css`, `.js` files
- Firebase SDK loaded via CDN or module imports
- Firestore used as the primary data store
- Keep JS modular across files but without a module bundler (use ES modules or script tags)

## Firebase

- Firestore is the database — all reads/writes go through the Firestore SDK
- Auth may be Firebase Auth (check `firebase-config.js` or equivalent)
- Security rules live in `firestore.rules`

## Development

Open `index.html` directly in a browser or serve via `firebase serve` / `firebase emulators:start`.

To deploy: `firebase deploy`
