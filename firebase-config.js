/** Firebase-Konfiguration des neuen Projekts „Zeig mal!“.
 * Die sechs Platzhalter durch die Werte aus der Firebase Console ersetzen.
 * „HIER_EINTRAGEN“ in der Prüfzeile darunter bleibt unverändert.
 */
export const firebaseConfig = {
  apiKey: ""AIzaSyD46SxH_WmlxMMv432by-7XLUr0R1zW_6U"",
  authDomain: "zeig-mal-spiel.firebaseapp.com",
  databaseURL: "https://zeig-mal-spiel-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "zeig-mal-spiel",
  storageBucket: "zeig-mal-spiel.firebasestorage.app",
  messagingSenderId: "268787095561",
  appId: "1:268787095561:web:1d2a18ca3511a4db7440d8"
};

export const firebaseIsConfigured = !Object.values(firebaseConfig).some(
  (value) => typeof value !== "string" || value.includes("HIER_EINTRAGEN")
);
