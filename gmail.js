// ============================================================
// gmail.js — Auth OAuth2 + lecture emails + labels + brouillons
// Cabinet 24 Silvestri — Gmail Agent v3.0 (Session 3)
// ============================================================

const { google } = require('googleapis');

// ── CLIENT OAUTH2 ─────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.RENDER_URL + '/auth/callback'
);

if (process.env.GMAIL_REFRESH_TOKEN) {
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
}

const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

// ── AUTH FLOW ─────────────────────────────────────────────────

// Étape 1 : générer l'URL de consentement Google
function getAuthUrl() {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // force le refresh_token même si déjà accordé
    scope: [
      'https://www.googleapis.com/auth/gmail.modify',     // lire + écrire labels + brouillons
      'https://www.googleapis.com/auth/spreadsheets.readonly', // index patients Doctolib (S4)
    ],
  });
}

// Étape 2 : callback → échange code → tokens
async function handleCallback(code) {
  const { tokens } = await oauth2Client.getToken(code);
  oauth2Client.setCredentials(tokens);
  return tokens; // afficher refresh_token pour le copier dans .env
}

// ── WATCH (push notifications Gmail) ─────────────────────────
// À appeler une fois pour s'abonner, puis toutes les 6-7 jours
async function renewWatch() {
  const res = await gmail.users.watch({
    userId: 'me',
    requestBody: {
      topicName: process.env.PUBSUB_TOPIC,
      labelIds: ['INBOX'],
      labelFilterBehavior: 'INCLUDE', // uniquement INBOX, pas Promotions/Social/Spam
    },
  });
  console.log(`[watch] Actif jusqu'au : ${new Date(parseInt(res.data.expiration)).toLocaleString('fr-FR')}`);
  return res.data;
}

// ── DECODE WEBHOOK PUB/SUB ────────────────────────────────────
// Corps brut de la requête POST envoyée par Google
function decodeWebhook(body) {
  if (!body?.message?.data) return null;
  try {
    const decoded = Buffer.from(body.message.data, 'base64').toString('utf8');
    return JSON.parse(decoded);
    // → { emailAddress: '24silvestri@gmail.com', historyId: '123456' }
  } catch {
    return null;
  }
}

// ── RÉCUPÉRER LES NOUVEAUX MESSAGES (via history API) ─────────
// Plus fiable que d'utiliser directement l'ID du message du webhook,
// car Gmail peut grouper plusieurs emails dans une seule notification
async function getNewMessages(startHistoryId) {
  let res;
  try {
    res = await gmail.users.history.list({
      userId: 'me',
      startHistoryId,
      historyTypes: ['messageAdded'],
      labelId: 'INBOX',
    });
  } catch (err) {
    // historyId trop ancien (>30j) → on réinitialise proprement
    if (err.code === 404) {
      console.warn('[history] historyId périmé, réinitialisation');
      return [];
    }
    throw err;
  }

  const history = res.data.history || [];
  const messages = [];

  for (const record of history) {
    for (const added of record.messagesAdded || []) {
      // Filtrer les messages qui n'ont plus le label INBOX
      // (ex : déplacés vers Promotions par Gmail entre la notif et la lecture)
      if (!added.message.labelIds?.includes('INBOX')) continue;

      const msg = await getEmailContent(added.message.id);
      if (msg) messages.push(msg);
    }
  }

  return messages;
}

// ── LIRE UN EMAIL COMPLET ─────────────────────────────────────
async function getEmailContent(messageId) {
  const res = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const msg = res.data;
  const headers = msg.payload.headers;
  const getHeader = (name) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  const from    = getHeader('From');
  const subject = getHeader('Subject');
  const date    = getHeader('Date');
  const body    = extractBody(msg.payload);

  // Extraire les pièces jointes audio (pour répondeur)
  const attachments = await extractAttachments(msg.payload, messageId);

  return {
    id:          messageId,
    threadId:    msg.threadId,
    from,
    subject,
    date,
    body:        cleanBody(body),
    attachments, // [{name, size, data (base64), mimeType}]
  };
}

// ── EXTRAIRE LES PIÈCES JOINTES ───────────────────────────────
async function extractAttachments(payload, messageId) {
  const attachments = [];
  const AUDIO_TYPES = ['audio/', 'application/octet-stream'];

  async function walk(part) {
    if (part.filename && part.body) {
      const isAudio = AUDIO_TYPES.some(t => (part.mimeType || '').startsWith(t))
                   || /\.(mp3|wav|ogg|mp4|m4a|flac)$/i.test(part.filename);
      if (!isAudio) return;

      let data = part.body.data; // inline base64
      if (!data && part.body.attachmentId) {
        // Télécharger depuis Gmail
        const att = await gmail.users.messages.attachments.get({
          userId: 'me',
          messageId,
          id: part.body.attachmentId,
        });
        data = att.data.data;
      }
      if (data) {
        attachments.push({
          name:     part.filename,
          size:     part.body.size || 0,
          mimeType: part.mimeType,
          data:     data.replace(/-/g, '+').replace(/_/g, '/'), // base64 standard
        });
      }
    }
    for (const sub of part.parts || []) await walk(sub);
  }

  await walk(payload);
  return attachments;
}

// ── EXTRAIRE LE CORPS TEXTE ───────────────────────────────────
// Parcourt récursivement les parts MIME pour trouver text/plain
function extractBody(payload) {
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }
  if (payload.parts) {
    // Priorité : text/plain d'abord
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    // Sinon : récursion sur les multipart
    for (const part of payload.parts) {
      const found = extractBody(part);
      if (found) return found;
    }
  }
  return '';
}

// Nettoyer le corps (citations, espaces multiples)
function cleanBody(text) {
  return text
    .replace(/^>.*$/gm, '')         // supprimer lignes citées
    .replace(/\n{3,}/g, '\n\n')     // max 2 sauts de ligne
    .trim()
    .substring(0, 2000);            // limite à 2000 chars pour les prompts
}

// ── APPLIQUER UN LABEL ────────────────────────────────────────
async function applyLabel(messageId, labelName) {
  const labelId = await getOrCreateLabel(labelName);
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds: [labelId] },
  });
}

// ── RÉPONDRE À UN EMAIL ───────────────────────────────────────
async function replyEmail(messageId, to, subject, textBody, htmlBody) {
  // Construire un email multipart avec text + html
  const boundary = 'boundary_cabinet_24';
  const raw = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    textBody,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  // Récupérer le threadId depuis le messageId
  const msg = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'minimal' });

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: {
      raw:      Buffer.from(raw).toString('base64url'),
      threadId: msg.data.threadId,
    },
  });
}

// Cache des labels pour éviter les appels répétés
const labelCache = {};
async function getOrCreateLabel(name) {
  if (labelCache[name]) return labelCache[name];

  const res = await gmail.users.labels.list({ userId: 'me' });
  const existing = res.data.labels.find((l) => l.name === name);
  if (existing) {
    labelCache[name] = existing.id;
    return existing.id;
  }

  const created = await gmail.users.labels.create({
    userId: 'me',
    requestBody: { name },
  });
  labelCache[name] = created.data.id;
  return created.data.id;
}

// ── CRÉER UN BROUILLON ────────────────────────────────────────
async function createDraft(to, subject, body, threadId) {
  const raw = buildRawEmail(to, subject, body);
  await gmail.users.drafts.create({
    userId: 'me',
    requestBody: {
      message: { raw, threadId },
    },
  });
}

function buildRawEmail(to, subject, body) {
  const email = [
    `To: ${to}`,
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(email).toString('base64url');
}

function getOAuth2Client() { return oauth2Client; }

// ── RECHERCHE FACTURES NON LUES ───────────────────────────────
async function getUnreadFactures() {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'label:Factures is:unread',
    maxResults: 30,
  });

  const messages = res.data.messages || [];
  const details  = [];

  for (const m of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: m.id,
      format: 'metadata',
      metadataHeaders: ['From', 'Subject', 'Date'],
    });
    const h = msg.data.payload.headers;
    const get = (name) => h.find(x => x.name === name)?.value || '';
    details.push({
      from:    get('From').replace(/<.*>/, '').trim(),
      subject: get('Subject'),
      date:    new Date(parseInt(msg.data.internalDate)).toLocaleDateString('fr-FR'),
    });
  }

  return details;
}

// ── ENVOI EMAIL D'ALERTE ──────────────────────────────────────
async function sendAlertEmail(subject, body) {
  const to  = process.env.GMAIL_ADDRESS;
  const raw = buildRawEmail(to, subject, body);
  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw },
  });
}

module.exports = {
  getAuthUrl,
  handleCallback,
  renewWatch,
  decodeWebhook,
  getNewMessages,
  getEmailContent,
  applyLabel,
  createDraft,
  getOAuth2Client,
  getUnreadFactures,
  sendAlertEmail,
  replyEmail,
};
