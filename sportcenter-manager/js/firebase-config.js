// ============================================================
// firebase-config.js
// Sostituisci i valori sotto con quelli del tuo progetto Firebase:
// Firebase Console → Project Settings → General → Your apps → Web app
//
// Nota: queste chiavi identificano il progetto client-side, non sono
// segrete di per sé — la sicurezza reale è garantita dalle
// Firestore Security Rules (vedi firestore.rules) e dalle regole di
// Authentication. Vanno comunque tenute allineate all'ambiente giusto
// (dev/prod) se in futuro si separano i progetti.
// ============================================================

const firebaseConfig = {
  apiKey: "AIzaSyBrATC9FJmlyubCFCl_iXBMmCmzERErGi4",
  authDomain: "sportcenter-manager.firebaseapp.com",
  projectId: "sportcenter-manager",
  storageBucket: "sportcenter-manager.firebasestorage.app",
  messagingSenderId: "431511019856",
  appId: "1:431511019856:web:0eb0d904fd5185b2448c55",
  measurementId: "G-FEQK6M1VWF"
};

firebase.initializeApp(firebaseConfig);

const auth = firebase.auth();
const db = firebase.firestore();
