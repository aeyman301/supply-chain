import { initializeApp } from "firebase/app";
import { getDatabase } from "firebase/database";

const firebaseConfig = {
  apiKey: "AIzaSyDYF--dL7Yv9TylCOlVGiV3iviaaiqFJ5c",
  authDomain: "supply-chain-88a2e.firebaseapp.com",
  databaseURL:
    "https://supply-chain-88a2e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "supply-chain-88a2e",
  storageBucket: "supply-chain-88a2e.firebasestorage.app",
  messagingSenderId: "287209341838",
  appId: "1:287209341838:web:8f96ea5927b05b82879adf",
  measurementId: "G-ZLERFNCVS1",
};

export const app = initializeApp(firebaseConfig);
export const db = getDatabase(app);
