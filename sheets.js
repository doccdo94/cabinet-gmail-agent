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

const SHEET_ID  = '14R8X1jaIQ4FhASA8N0PJvnpkkvdiURqj';
const SHEET_TAB = 'export_patients-part-1'; // onglet Doctolib

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
    if (!row || row.length === 0) continue; // ligne vide
    const email = (row[idx('email')] || '').toLowerCase().trim();
    const phone = (row[idx('phone_number')] || '').trim();
    if (!email && !phone) continue; // ignorer lignes sans email ni téléphone

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

// ── LOOKUP PATIENT PAR EMAIL ou NOM ──────────────────────────
// from : champ From complet ex: "Florent Belle <flobel2222@yahoo.fr>"
// emailAddress : email extrait
async function findPatient(emailAddress, auth, fromFull = '') {
  try {
    const map = await loadPatients(auth);

    // 1. Lookup exact par email (cas nominal)
    const key = emailAddress.toLowerCase().trim();
    if (map.has(key)) return map.get(key);

    // 2. Fallback par nom d'affichage extrait du champ From
    // "Florent Belle <...>" → ["florent", "belle"]
    const displayName = fromFull.replace(/<.*>/, '').trim().toLowerCase();
    if (!displayName) return null;

    const parts = displayName.split(/\s+/);
    if (parts.length < 2) return null;

    for (const patient of map.values()) {
      const fn = patient.first_name.toLowerCase();
      const ln = patient.last_name.toLowerCase();
      // Match si les deux tokens apparaissent dans le nom (ordre quelconque)
      const match = parts.every(p => fn.includes(p) || ln.includes(p));
      if (match) {
        console.log(`[sheets] Match par nom : ${patient.first_name} ${patient.last_name}`);
        return patient;
      }
    }

    return null;
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

// Expose le Map complet pour la transcription (index téléphone)
async function getPatientMap(auth) {
  return await loadPatients(auth);
}

module.exports = { findPatient, invalidateCache, getPatientMap };