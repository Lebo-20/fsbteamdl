import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';

const firebaseConfig = {
  apiKey: "AIzaSyD8GtgTCdy9LNlkiGlmfdz--vtsZyyfMio",
  authDomain: "botfsub-85a55.firebaseapp.com",
  projectId: "botfsub-85a55",
  storageBucket: "botfsub-85a55.firebasestorage.app",
  messagingSenderId: "1079899746576",
  appId: "1:1079899746576:web:8d6a18f8385f79d73eb595"
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
