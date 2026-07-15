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
