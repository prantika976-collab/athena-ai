// firebase.js
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore, collection, addDoc } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyAWBpCwzAAEtUCMQfKrrG-QEnaO0WOvfHw",
  authDomain: "athena-13a51.firebaseapp.com",
  projectId: "athena-13a51",
  storageBucket: "athena-13a51.firebasestorage.app",
  messagingSenderId: "599460594627",
  appId: "1:599460594627:web:eeec2f3b60064003163376"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

export { db, collection, addDoc };

