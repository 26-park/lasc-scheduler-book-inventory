/* Firebase initialization — shared by index.html and inventory.html */
const firebaseConfig = {
  apiKey: "AIzaSyBhGm70nO96hXjKaWVD6Yo1KkLUsoQVWk8",
  authDomain: "lasc-scheduler.firebaseapp.com",
  projectId: "lasc-scheduler",
  storageBucket: "lasc-scheduler.firebasestorage.app",
  messagingSenderId: "1024791105352",
  appId: "1:1024791105352:web:a5e1dd6a9421994f98ad7d"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Local (IndexedDB) cache. Repeat visits resume their listeners from the cached
// data and only pay for documents that actually changed, which is where most of
// the daily read quota used to go. synchronizeTabs keeps it working when the
// Scheduler and Inventory pages are open side by side. Must run before any
// query — every page starts its listeners after auth resolves, so it does.
// Failures are non-fatal: the app just runs without the cache.
db.enablePersistence({ synchronizeTabs: true }).catch(err => {
  console.warn('Firestore offline persistence unavailable:', err && err.code);
});
