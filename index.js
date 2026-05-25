// ============================================================
// index.js — Serveur Express principal
// Cabinet 24 Silvestri — Gmail Agent v3.1
// Nouveauté : Claude Sonnet classification + Haiku brouillons
//             + index patients Doctolib (Google Sheets)
// ============================================================

require('dotenv').config();
const express = require('express');
const {
  getAuthUrl,
  handleCallback,
  renewWatch,
  decodeWebhook,
  getNewMessages,
  applyLabel,
  createDraft,
  getOAuth2Client,
  getEmailContent,
  getUnreadFactures,
  sendAlertEmail,
  replyEmail,
  replyInThread,
} = require('./gmail');
const { preFilter }                  = require('./prefilter');
const { classifyEmail, genererBrouillon } = require('./claude');
const { findPatient, getPatientMap } = require('./sheets');
const { traiterRepondeur }           = require('./transcription');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── STATE ─────────────────────────────────────────────────────
let lastHistoryId = null;
const processedMessageIds = new Set();
const stats = {
  total: 0, prefiltre: 0, claude: 0,
  brouillons: 0, urgences: 0, errors: 0
};

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    service:   'gmail-agent-cabinet-v3.2',
    version:   '3.2.0',
    lastHistoryId,
    uptime:    Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString(),
    stats,
  });
});

// ── AUTH GMAIL ────────────────────────────────────────────────
app.get('/auth/gmail', (_req, res) => res.redirect(getAuthUrl()));

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`Erreur Google : ${error}`);
  if (!code)  return res.status(400).send('Code OAuth2 manquant');
  try {
    const tokens = await handleCallback(code);
    res.send(`
      <h2>Auth Gmail réussie</h2>
      <pre style="background:#f5f5f5;padding:16px;border-radius:8px;word-break:break-all">
GMAIL_REFRESH_TOKEN=${tokens.refresh_token || '(déjà configuré)'}
      </pre>
      <p><a href="/watch/start">Démarrer le watch</a></p>
    `);
  } catch (err) {
    res.status(500).send(`Erreur auth : ${err.message}`);
  }
});

// ── WATCH ─────────────────────────────────────────────────────
app.get('/watch/start', async (_req, res) => {
  try {
    const result     = await renewWatch();
    const expiration = new Date(parseInt(result.expiration)).toLocaleString('fr-FR');
    lastHistoryId    = result.historyId;
    console.log(`[watch] Démarré — expire le ${expiration}`);
    res.json({ ok: true, expiration, historyId: result.historyId });
  } catch (err) {
    console.error('[watch] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK GMAIL (Pub/Sub push) ──────────────────────────────
app.post('/webhook/gmail', async (req, res) => {
  res.sendStatus(200);

  try {
    const notification = decodeWebhook(req.body);
    if (!notification) return;

    const { historyId, emailAddress } = notification;
    console.log(`[webhook] historyId: ${historyId} — ${emailAddress}`);

    if (!lastHistoryId) {
      lastHistoryId = historyId;
      console.log(`[webhook] Init historyId: ${historyId}`);
      return;
    }

    let messages = [];
    try {
      messages = await getNewMessages(lastHistoryId);
    } catch (histErr) {
      console.warn(`[webhook] historyId périmé (${lastHistoryId}), réinitialisation...`);
      lastHistoryId = historyId;
      await renewWatch();
      return;
    }
    lastHistoryId  = historyId;

    if (messages.length === 0) {
      console.log('[webhook] Aucun nouveau message INBOX');
      return;
    }

    console.log(`[webhook] ${messages.length} message(s) à traiter`);
    for (const msg of messages) {
      if (processedMessageIds.has(msg.id)) continue;
      processedMessageIds.add(msg.id);
      if (processedMessageIds.size > 1000) {
        processedMessageIds.delete(processedMessageIds.values().next().value);
      }
      await processEmail(msg);
    }
  } catch (err) {
    console.error('[webhook] Erreur:', err.message);
  }
});

// ── TRAITEMENT D'UN EMAIL ─────────────────────────────────────
async function processEmail(msg) {
  stats.total++;
  console.log('─'.repeat(60));
  console.log(`[email] De    : ${msg.from}`);
  console.log(`[email] Sujet : ${msg.subject}`);
  monitoring.lastEmail = { from: msg.from, subject: msg.subject, categorie: '...', time: new Date().toLocaleString('fr-FR') };

  try {

    // ── COUCHE 1 : pré-filtre règles (0 token AI) ─────────────
    const decision = preFilter(msg);

    if (decision) {
      stats.prefiltre++;
      console.log(`[prefiltre] ${decision.categorie} — ${decision.raison}`);
      await Promise.all(decision.labels.map(l => applyLabel(msg.id, l)));
      console.log(`[prefiltre] Labels appliqués : ${decision.labels.join(', ')}`);

      // ── RÉPONDEUR : transcription Speech-to-Text ───────────
      if (decision.categorie === 'repondeur') {
        try {
          const authR       = getOAuth2Client();
          let patientsMap   = null;
          try { patientsMap = await getPatientMap(authR); } 
          catch (sheetsErr) { console.warn(`[repondeur] Sheets indispo : ${sheetsErr.message}`); }
          const result      = await traiterRepondeur(msg, patientsMap, {
            replyInThread: (threadId, sujet, text, html) => replyInThread(threadId, sujet, text, html),
            applyLabelFn: (id, label) => applyLabel(id, label),
          });
          if (result) {
            console.log(`[repondeur] Transcrit : ${result.identite || 'patient inconnu'}`);
          }
        } catch (err) {
          console.error(`[repondeur] Erreur transcription : ${err.message}`);
        }
      }

      return;
    }

    // ── COUCHE 2 : Claude Sonnet — classification ─────────────
    stats.claude++;
    console.log(`[claude] Classification en cours...`);
    const classif = await classifyEmail(msg);
    console.log(`[claude] Catégorie : ${classif.categorie} — ${classif.raison}`);

    // Appliquer le label si précisé
    if (classif.label_gmail) {
      await applyLabel(msg.id, classif.label_gmail);
      console.log(`[claude] Label appliqué : ${classif.label_gmail}`);
    }

    // ── COUCHE 3 : Brouillon patient (Haiku) ──────────────────
    if (classif.generer_brouillon) {

      // Chercher le patient dans l'index Doctolib
      const emailAddr = extractEmail(msg.from);
      const auth      = getOAuth2Client();
      const patient   = await findPatient(emailAddr, auth, msg.from);

      if (patient) {
        console.log(`[sheets] Patient trouvé : ${patient.first_name} ${patient.last_name}`);
      } else {
        console.log(`[sheets] Patient inconnu : ${emailAddr}`);
      }

      const brouillon = await genererBrouillon(msg, patient);
      await createDraft(msg.from, `Re: ${msg.subject}`, brouillon, msg.threadId);
      await applyLabel(msg.id, 'Brouillon IA');
      await applyLabel(msg.id, 'À traiter');
      stats.brouillons++;
      console.log(`[claude] Brouillon créé — ${patient ? 'personnalisé' : 'générique'}`);
    }

    // ── Urgence : log marqué (SMS mis de côté pour l'instant) ─
    if (classif.urgence) {
      stats.urgences++;
      console.warn(`[URGENT] ${msg.from} — ${msg.subject}`);
      // S4 optionnel : await envoyerSMS(...)
    }

  } catch (err) {
    stats.errors++;
    console.error(`[email] Erreur : ${err.message}`);
    logError('email', err.message);
    if (err.message?.includes('invalid_grant') || err.code === 401) {
      await alerteTokenExpire();
    }
  }

  console.log('─'.repeat(60));
}

// ── UTILITAIRE ────────────────────────────────────────────────
function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

// ── RENOUVELLEMENT AUTOMATIQUE DU WATCH ──────────────────────
setInterval(async () => {
  try {
    const result  = await renewWatch();
    lastHistoryId = result.historyId;
    console.log('[watch] Renouvelé automatiquement');
  } catch (err) {
    console.error('[watch] Échec renouvellement:', err.message);
  }
}, 6 * 24 * 60 * 60 * 1000);

// ── ENDPOINT TEST RÉPONDEUR ──────────────────────────────────
// GET /test/repondeur?numero=0782481900
// ou GET /test/repondeur?sujet=Message+vocal+du
app.get('/test/repondeur', async (req, res) => {
  const { numero, sujet } = req.query;
  if (!numero && !sujet) {
    return res.status(400).json({ error: 'Paramètre numero ou sujet manquant. Ex: ?numero=0782481900' });
  }

  try {
    const { google } = require('googleapis');
    const testAuth  = getOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth: testAuth });

    // Chercher le message par sujet dans Gmail
    const query = numero
      ? `subject:"Message vocal du ${numero}" in:anywhere`
      : `subject:"${sujet}" in:anywhere`;

    console.log(`[test] Recherche : ${query}`);
    const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 1 });
    const messages = listRes.data.messages || [];

    if (messages.length === 0) {
      return res.status(404).json({ error: `Aucun message trouvé pour : ${query}` });
    }

    const msgId = messages[0].id;
    console.log(`[test] Message trouvé : ${msgId}`);

    // Lire directement via Gmail API sans passer par getEmailContent
    const { google: googleLib } = require('googleapis');
    const directAuth = getOAuth2Client();
    const gmailDirect = googleLib.gmail({ version: 'v1', auth: directAuth });
    const rawMsg = await gmailDirect.users.messages.get({
      userId: 'me',
      id: msgId,
      format: 'full',
    });

    const headers = rawMsg.data.payload.headers;
    const getH = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

    // Extraire les pièces jointes audio
    const attachments = [];
    async function walkParts(part) {
      if (part.filename && /\.(mp3|wav|ogg|m4a|flac)$/i.test(part.filename)) {
        let data = part.body?.data;
        if (!data && part.body?.attachmentId) {
          const att = await gmailDirect.users.messages.attachments.get({
            userId: 'me', messageId: msgId, id: part.body.attachmentId,
          });
          data = att.data.data;
        }
        if (data) attachments.push({
          name: part.filename,
          size: part.body.size || 0,
          data: data.replace(/-/g, '+').replace(/_/g, '/'),
        });
      }
      for (const sub of part.parts || []) await walkParts(sub);
    }
    await walkParts(rawMsg.data.payload);
    console.log(`[test] PJ audio trouvées : ${attachments.length}`);

    const msg = {
      id:          msgId,
      threadId:    rawMsg.data.threadId,
      from:        getH('From'),
      subject:     getH('Subject'),
      date:        getH('Date'),
      body:        '',
      attachments,
    };
    const auth2 = getOAuth2Client();
    const patientsMap = await getPatientMap(auth2);

    const result = await traiterRepondeur(msg, patientsMap, {
      replyEmail,
      applyLabelFn: (msgId, label) => applyLabel(msgId, label),
    });

    if (result) {
      res.json({
        ok:           true,
        identite:     result.identite || 'Patient inconnu',
        numero:       result.numero,
        transcription: result.transcription,
      });
    } else {
      res.json({ ok: false, message: 'Aucune PJ audio trouvée dans ce message' });
    }
  } catch (err) {
    console.error(`[test] Erreur : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── ALERTE FACTURES ──────────────────────────────────────────
// Appelé par cron-job.org chaque lundi à 8h
// URL à configurer : GET /alertes/factures
app.get('/alertes/factures', async (_req, res) => {
  try {
    const factures = await getUnreadFactures();

    if (factures.length === 0) {
      console.log('[factures] Aucune facture non lue');
      return res.json({ ok: true, count: 0 });
    }

    let corps = `${factures.length} facture(s) fournisseur non lue(s) :\n\n`;
    for (const f of factures) {
      corps += `- [${f.date}] ${f.from} — ${f.subject}\n`;
    }
    corps += '\n→ Consultez le label Factures dans Gmail.';

    const sujet = `${factures.length} facture(s) à traiter — ${new Date().toLocaleDateString('fr-FR')}`;
    await sendAlertEmail(sujet, corps);

    console.log(`[factures] Alerte envoyée — ${factures.length} facture(s)`);
    res.json({ ok: true, count: factures.length });
  } catch (err) {
    console.error('[factures] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── MONITORING STATE ─────────────────────────────────────────
const monitoring = {
  startTime:    Date.now(),
  lastEmail:    null,
  lastError:    null,
  tokenStatus:  'ok',   // 'ok' | 'expired'
  errors:       [],     // dernières erreurs (max 20)
};

function logError(context, message) {
  const entry = { time: new Date().toISOString(), context, message };
  monitoring.errors.unshift(entry);
  if (monitoring.errors.length > 20) monitoring.errors.pop();
  monitoring.lastError = entry;
  if (message.includes('invalid_grant')) monitoring.tokenStatus = 'expired';
}

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/monitoring', (_req, res) => {
  const uptime  = Math.floor((Date.now() - monitoring.startTime) / 1000);
  const uptimeH = `${Math.floor(uptime/3600)}h ${Math.floor((uptime%3600)/60)}m`;
  const tokenOk = monitoring.tokenStatus === 'ok';

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Gmail Agent — Cabinet 24 Silvestri</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#f1f5f9;color:#1e293b;padding:20px}
h1{font-size:18px;font-weight:700;margin-bottom:4px}
.sub{font-size:13px;color:#64748b;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:24px}
.card{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px #0001}
.card-label{font-size:11px;color:#94a3b8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.card-value{font-size:22px;font-weight:700}
.card-sub{font-size:11px;color:#94a3b8;margin-top:4px}
.ok{color:#059669}.warn{color:#d97706}.err{color:#dc2626}
.badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:600}
.badge-ok{background:#d1fae5;color:#059669}
.badge-err{background:#fee2e2;color:#dc2626}
.section{background:#fff;border-radius:12px;padding:16px;box-shadow:0 1px 3px #0001;margin-bottom:12px}
.section h2{font-size:13px;font-weight:600;margin-bottom:12px;color:#475569}
.error-row{padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:12px}
.error-row:last-child{border-bottom:none}
.error-time{color:#94a3b8;margin-right:8px}
.error-ctx{font-weight:600;margin-right:6px}
.action{background:#2563eb;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:13px;font-weight:500;display:inline-block}
.refresh{font-size:11px;color:#94a3b8;text-align:right;margin-top:12px}
</style>
</head>
<body>
<h1>Gmail Agent — Cabinet 24 Silvestri</h1>
<div class="sub">Actualisation automatique toutes les 30 secondes</div>

<div class="grid">
  <div class="card">
    <div class="card-label">Token OAuth2</div>
    <div class="card-value">
      <span class="badge ${tokenOk ? 'badge-ok' : 'badge-err'}">${tokenOk ? 'Valide' : 'EXPIRÉ'}</span>
    </div>
    <div class="card-sub">${tokenOk ? 'Acces Gmail OK' : 'Action requise'}</div>
  </div>
  <div class="card">
    <div class="card-label">Uptime</div>
    <div class="card-value ok">${uptimeH}</div>
    <div class="card-sub">depuis le dernier restart</div>
  </div>
  <div class="card">
    <div class="card-label">Emails traites</div>
    <div class="card-value">${stats.total}</div>
    <div class="card-sub">prefiltres: ${stats.prefiltre} | claude: ${stats.claude}</div>
  </div>
  <div class="card">
    <div class="card-label">Brouillons crees</div>
    <div class="card-value ok">${stats.brouillons}</div>
    <div class="card-sub">urgences: ${stats.urgences}</div>
  </div>
  <div class="card">
    <div class="card-label">Erreurs</div>
    <div class="card-value ${stats.errors > 0 ? 'err' : 'ok'}">${stats.errors}</div>
    <div class="card-sub">depuis le dernier restart</div>
  </div>
  <div class="card">
    <div class="card-label">historyId</div>
    <div class="card-value" style="font-size:14px">${lastHistoryId || 'non init'}</div>
    <div class="card-sub">Gmail watch</div>
  </div>
</div>

${!tokenOk ? `
<div class="section" style="border:2px solid #dc2626">
  <h2 style="color:#dc2626">⚠️ TOKEN EXPIRÉ — ACTION REQUISE</h2>
  <p style="font-size:13px;margin-bottom:12px;color:#64748b">Le token OAuth2 Gmail est invalide. Aucun email n'est traite.</p>
  <a class="action" href="/auth/gmail">Renouveler le token</a>
</div>` : ''}

<div class="section">
  <h2>Dernieres erreurs</h2>
  ${monitoring.errors.length === 0
    ? '<div style="font-size:13px;color:#94a3b8">Aucune erreur recente ✓</div>'
    : monitoring.errors.map(e => `
      <div class="error-row">
        <span class="error-time">${e.time.substring(11,19)}</span>
        <span class="error-ctx">[${e.context}]</span>
        <span>${e.message.substring(0,100)}</span>
      </div>`).join('')
  }
</div>

<div class="section">
  <h2>Dernier email traite</h2>
  ${monitoring.lastEmail
    ? `<div style="font-size:13px">
        <div><strong>De :</strong> ${monitoring.lastEmail.from}</div>
        <div><strong>Sujet :</strong> ${monitoring.lastEmail.subject}</div>
        <div><strong>Categorie :</strong> ${monitoring.lastEmail.categorie}</div>
        <div style="color:#94a3b8;margin-top:4px">${monitoring.lastEmail.time}</div>
       </div>`
    : '<div style="font-size:13px;color:#94a3b8">Aucun email traite depuis le dernier restart</div>'
  }
</div>

<div class="refresh">Derniere actualisation : ${new Date().toLocaleTimeString('fr-FR')}</div>
</body>
</html>`;

  res.send(html);
});

// ── ALERTE TOKEN EXPIRÉ ──────────────────────────────────────
let _alerteEnvoyee = false; // évite le spam d'alertes
async function alerteTokenExpire() {
  if (_alerteEnvoyee) return;
  _alerteEnvoyee = true;
  console.error('[AUTH] Token OAuth2 invalide — alerte envoyée');
  try {
    // Tenter d'envoyer un email d'alerte via une nouvelle instance OAuth
    const { google } = require('googleapis');
    const auth = new google.auth.OAuth2(
      process.env.GMAIL_CLIENT_ID,
      process.env.GMAIL_CLIENT_SECRET,
    );
    auth.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
    // Si le token est vraiment mort, cet appel échouera aussi — on log seulement
    console.error('[AUTH] ACTION REQUISE : aller sur /auth/gmail pour renouveler le token');
    console.error('[AUTH] URL : ' + process.env.RENDER_URL + '/auth/gmail');
  } catch (e) {
    console.error("[AUTH] Token expire - impossible d envoyer alerte :", e.message);
  }
  // Reset après 1h pour re-alerter si nécessaire
  setTimeout(() => { _alerteEnvoyee = false; }, 60 * 60 * 1000);
}

// ── DÉMARRAGE ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('═'.repeat(60));
  console.log(`  Gmail Agent — Cabinet 24 Silvestri`);
  console.log(`  v3.2 — Transcription répondeur OVH intégrée`);
  console.log(`  Port : ${PORT}`);
  console.log('═'.repeat(60));

  // Démarrage automatique du watch Gmail à chaque lancement
  try {
    const result  = await renewWatch();
    lastHistoryId = result.historyId;
    const expiration = new Date(parseInt(result.expiration)).toLocaleString('fr-FR');
    console.log(`[watch] Démarré automatiquement — expire le ${expiration}`);
  } catch (err) {
    console.error('[watch] Échec démarrage automatique:', err.message);
    console.error('[watch] Appelle manuellement /watch/start si nécessaire');
  }
});
