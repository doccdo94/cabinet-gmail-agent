// ============================================================
// sheets.js — Index patients Doctolib via Google Sheets
// Cabinet 24 Silvestri — Gmail Agent v3.0 (Session 3)
// Sheet ID : 14R8X1jaIQ4FhASA8N0PJvnpkkvdiURq
// Colonnes : id, import_identifier, gender, last_name,
//            maiden_name, first_name, birthdate, email,
//            phone_number, secondary_phone, address,
//            zipcode, city, insurance_type, crucial_info, referrer
// ============================================================

const { google } = require('googleapis');

const SHEET_ID  = '14R8X1jaIQ4FhASA8N0PJvnpkkvdiURq';
const SHEET_TAB = 'Sheet1'; // onglet par défaut

// ── CACHE ─────────────────────────────────────────────────────
// Évite de requêter le Sheet à chaque email
// TTL 30 minutes — suffisant pour un cabinet
let cache = null;
let cacheTime = 0;
const CACHE_TTL_MS = 30 * 60 * 1000;

// ── AUTH (réutilise le même oauth2Client que gmail.js) ────────
// On reçoit l'auth en paramètre pour ne pas dupliquer la config
async function loadPatients(auth) {
  const now = Date.now();

  if (cache && now - cacheTime < CACHE_TTL_MS) {
    return cache; // cache encore valide
  }

  const sheets = google.sheets({ version: 'v4', auth });
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range:         `${SHEET_TAB}!A:P`, // colonnes A à P
  });

  const rows    = res.data.values || [];
  const headers = rows[0] || [];
  const idx     = (col) => headers.indexOf(col);

  // Construire un Map email → patient pour lookup O(1)
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const email = (row[idx('email')] || '').toLowerCase().trim();
    if (!email) continue;

    map.set(email, {
      id:          row[idx('id')]         || '',
      gender:      row[idx('gender')]     || '',    // M. / Mme / Mme/M.
      last_name:   row[idx('last_name')]  || '',
      first_name:  row[idx('first_name')] || '',
      birthdate:   row[idx('birthdate')]  || '',
      phone:       row[idx('phone_number')] || '',
      city:        row[idx('city')]       || '',
      crucial_info:row[idx('crucial_info')] || '',
    });
  }

  cache     = map;
  cacheTime = now;
  console.log(`[sheets] Index chargé : ${map.size} patients`);
  return map;
}

// ── LOOKUP PATIENT PAR EMAIL ──────────────────────────────────
async function findPatient(emailAddress, auth) {
  try {
    const map = await loadPatients(auth);
    const key = emailAddress.toLowerCase().trim();
    return map.get(key) || null;
  } catch (err) {
    console.error('[sheets] Erreur lookup patient:', err.message);
    return null;
  }
}

// ── FORCER UN RECHARGEMENT DU CACHE ──────────────────────────
function invalidateCache() {
  cache     = null;
  cacheTime = 0;
}

module.exports = { findPatient, invalidateCache };
