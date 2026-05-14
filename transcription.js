// ============================================================
// transcription.js — Transcription messages vocaux OVH
// Cabinet 24 Silvestri — Gmail Agent v3.2
// Google Cloud Speech-to-Text API (clé API)
// ============================================================

const SPEECH_API_KEY = process.env.SPEECH_API_KEY;
const SPEECH_URL     = 'https://speech.googleapis.com/v1/speech:recognize';

// ── EXTENSIONS AUDIO ACCEPTÉES ────────────────────────────────
const EXTENSIONS_AUDIO = ['mp3', 'wav', 'ogg', 'mp4', 'm4a', 'flac'];

const ENCODING_MAP = {
  mp3: 'MP3', wav: 'LINEAR16', ogg: 'OGG_OPUS',
  flac: 'FLAC', mp4: 'MP3', m4a: 'MP3',
};

// ── TRANSCRIPTION ─────────────────────────────────────────────
async function transcrire(audioBase64, extension) {
  const encoding = ENCODING_MAP[extension.toLowerCase()] || 'MP3';

  const body = {
    config: {
      encoding,
      sampleRateHertz:          16000,
      languageCode:             'fr-FR',
      model:                    'phone_call',
      enableAutomaticPunctuation: true,
      useEnhanced:              true,
    },
    audio: { content: audioBase64 },
  };

  const res = await fetch(`${SPEECH_URL}?key=${SPEECH_API_KEY}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`Speech-to-Text erreur ${res.status} : ${json.error?.message}`);
  }

  if (!json.results?.length) {
    return '(Aucune parole détectée dans le message vocal)';
  }

  const texte = json.results
    .map(r => r.alternatives[0].transcript)
    .join(' ');

  const confiance = json.results
    .map(r => r.alternatives[0].confidence || 0)
    .reduce((a, b) => a + b, 0) / json.results.length;

  console.log(`[speech] Confiance : ${Math.round(confiance * 100)}% — ${texte.substring(0, 80)}...`);
  return texte;
}

// ── EXTRACTION NUMÉRO DEPUIS SUJET ────────────────────────────
// "Message vocal du 0782481900" → "0782481900"
function extraireNumero(sujet) {
  const match = sujet.match(/Message vocal du\s+(.+)/i);
  if (!match) return null;
  return normaliserNumero(match[1]);
}

function normaliserNumero(raw) {
  let tel = String(raw).replace(/[^\d+]/g, '');
  if (tel.startsWith('+33'))  tel = '0' + tel.substring(3);
  if (tel.startsWith('0033')) tel = '0' + tel.substring(4);
  tel = tel.replace(/\D/g, '');
  return (tel.length === 10 && tel.startsWith('0')) ? tel : null;
}

function formaterNumero(tel) {
  if (!tel || tel.length !== 10) return tel || '';
  return tel.replace(/(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, '$1 $2 $3 $4 $5');
}

// ── IDENTIFICATION PATIENT PAR TÉLÉPHONE ──────────────────────
// Cherche dans l'index Sheets déjà chargé (Map email→patient)
// On construit un index téléphone séparé au premier appel
let telIndex = null;

function buildTelIndex(patientsMap) {
  if (telIndex) return telIndex;
  telIndex = new Map();
  for (const patient of patientsMap.values()) {
    if (patient.phone) {
      const normalized = normaliserNumero(patient.phone);
      if (normalized) telIndex.set(normalized, patient);
    }
  }
  console.log(`[speech] Index téléphone : ${telIndex.size} numéros`);
  return telIndex;
}

function identifierAppelant(numero, patientsMap) {
  if (!numero || !patientsMap) return null;
  const idx = buildTelIndex(patientsMap);
  return idx.get(numero) || null;
}

// ── TRAITEMENT COMPLET D'UN EMAIL RÉPONDEUR ───────────────────
// msg         : email complet (avec .attachments depuis Gmail API)
// patientsMap : Map email→patient depuis sheets.js
// gmail       : fonctions gmail.js (createDraft, replyEmail)
async function traiterRepondeur(msg, patientsMap, { replyEmail, applyLabelFn }) {
  const sujet  = msg.subject || '';
  const numero = extraireNumero(sujet);

  console.log(`[repondeur] Sujet : ${sujet}`);
  console.log(`[repondeur] Numéro extrait : ${numero || 'non trouvé'}`);

  // Identifier l'appelant
  const patient = identifierAppelant(numero, patientsMap);
  if (patient) {
    console.log(`[repondeur] Patient : ${patient.first_name} ${patient.last_name}`);
  } else {
    console.log(`[repondeur] Patient inconnu`);
  }

  // Trouver la pièce jointe audio
  const pj = (msg.attachments || []).find(a => {
    const ext = (a.name || '').split('.').pop().toLowerCase();
    return EXTENSIONS_AUDIO.includes(ext);
  });

  if (!pj) {
    console.warn(`[repondeur] Aucune PJ audio trouvée`);
    return null;
  }

  console.log(`[repondeur] PJ audio : ${pj.name} (${pj.size} octets)`);

  // Transcrire
  let transcription;
  try {
    const ext = pj.name.split('.').pop().toLowerCase();
    transcription = await transcrire(pj.data, ext);
  } catch (err) {
    console.error(`[repondeur] Erreur transcription : ${err.message}`);
    transcription = `(Erreur de transcription : ${err.message})`;
  }

  // Construire le HTML de réponse
  const telFormate = formaterNumero(numero);
  const identite   = patient
    ? `${patient.first_name} ${patient.last_name}`
    : null;

  const htmlBody = construireHtml(identite, telFormate, transcription);
  const textBody = construireTexte(identite, telFormate, transcription);

  // Répondre à l'email d'origine
  await replyEmail(msg.id, msg.from, `📝 Transcription : ${sujet}`, textBody, htmlBody);

  console.log(`[repondeur] Transcription envoyée — ${identite || 'patient inconnu'}`);
  return { transcription, identite, numero };
}

// ── TEMPLATES HTML / TEXTE ────────────────────────────────────
function construireHtml(identite, tel, transcription) {
  const blocIdentite = identite
    ? `<div style="background:#e8f5e9;border-left:4px solid #059669;padding:12px 16px;margin:0 0 14px;border-radius:0 8px 8px 0">
         <strong style="font-size:15px">${identite}</strong>
         <span style="color:#64748b;margin-left:8px">${tel}</span>
       </div>`
    : `<div style="background:#fff3e0;border-left:4px solid #d97706;padding:12px 16px;margin:0 0 14px;border-radius:0 8px 8px 0">
         <strong>Patient non identifié</strong>
         <span style="color:#64748b;margin-left:8px">${tel}</span>
       </div>`;

  return `<div style="font-family:Arial,sans-serif;max-width:600px">
    ${blocIdentite}
    <div style="background:#f8fafc;border-left:4px solid #2563eb;padding:16px;border-radius:0 8px 8px 0">
      <p style="margin:0;line-height:1.7;white-space:pre-wrap;color:#1e293b">${transcription}</p>
    </div>
  </div>`;
}

function construireTexte(identite, tel, transcription) {
  const who = identite ? `${identite} - ${tel}` : `Patient non identifié - ${tel}`;
  return `${who}\n\n${transcription}`;
}

module.exports = { traiterRepondeur, extraireNumero, identifierAppelant, buildTelIndex };
