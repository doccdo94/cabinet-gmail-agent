// ============================================================
// index.js — Serveur Express principal
// Cabinet 24 Silvestri — Gmail Agent v3.3
// Nouveauté v3.3 : rattrapage répondeur au démarrage
// Fix v3.3.1 : replyInThread corrigé dans /test/repondeur
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
    service:   'gmail-agent-cabinet-v3.3',
    version:   '3.3.1',
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
    lastHistoryId = historyId;

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
          const authR     = getOAuth2Client();
          let patientsMap = null;
          try { patientsMap = await getPatientMap(authR); }
          catch (sheetsErr) { console.warn(`[repondeur] Sheets indispo : ${sheetsErr.message}`); }
          const result    = await traiterRepondeur(msg, patientsMap, {
            replyInThread: (threadId, sujet, text, html) => replyInThread(threadId, sujet, text, html),
            applyLabelFn:  (id, label) => applyLabel(id, label),
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

    if (classif.label_gmail) {
      await applyLabel(msg.id, classif.label_gmail);
      console.log(`[claude] Label appliqué : ${classif.label_gmail}`);
    }

    // ── COUCHE 3 : Brouillon patient (Haiku) ──────────────────
    if (classif.generer_brouillon) {
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

    if (classif.urgence) {
      stats.urgences++;
      console.warn(`[URGENT] ${msg.from} — ${msg.subject}`);
    }

  } catch (err) {
    stats.errors++;
    console.error(`[email] Erreur : ${err.message}`);
  }

  console.log('─'.repeat(60));
}

// ── UTILITAIRE ────────────────────────────────────────────────
function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

// ── RATTRAPAGE RÉPONDEUR AU DÉMARRAGE ────────────────────────
async function rattrapageRepondeur() {
  try {
    const { google } = require('googleapis');
    const auth  = getOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });

    const apres = Math.floor((Date.now() - 3 * 60 * 60 * 1000) / 1000);
    const res = await gmail.users.messages.list({
      userId:     'me',
      q:          `subject:vocal after:${apres}`,
      maxResults: 10,
    });

    const messages = res.data.messages || [];
    if (messages.length === 0) {
      console.log('[rattrapage] Aucun message répondeur récent');
      return;
    }

    console.log(`[rattrapage] ${messages.length} message(s) répondeur à vérifier`);

    for (const m of messages) {
      const thread = await gmail.users.threads.get({ userId: 'me', id: m.threadId });
      const msgs   = thread.data.messages || [];

      const dejaTraite = msgs.some(tm => {
        const from = tm.payload.headers.find(h => h.name === 'From')?.value || '';
        return from.includes('24silvestri@gmail.com');
      });

      if (dejaTraite) {
        console.log(`[rattrapage] Déjà traité : thread ${m.threadId}`);
        continue;
      }

      console.log(`[rattrapage] Non traité, transcription en cours : ${m.id}`);
      const msg         = await getEmailContent(m.id);
      const patientsMap = await getPatientMap(auth).catch(() => null);

      await traiterRepondeur(msg, patientsMap, {
        replyInThread: (threadId, sujet, text, html) => replyInThread(threadId, sujet, text, html),
        applyLabelFn:  (id, label) => applyLabel(id, label),
      });

      processedMessageIds.add(m.id);
      console.log(`[rattrapage] Transcription envoyée : ${m.id}`);
    }
  } catch (err) {
    console.error('[rattrapage] Erreur:', err.message);
  }
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
app.get('/test/repondeur', async (req, res) => {
  const { numero, sujet } = req.query;
  if (!numero && !sujet) {
    return res.status(400).json({ error: 'Paramètre numero ou sujet manquant. Ex: ?numero=0782481900' });
  }

  try {
    const { google } = require('googleapis');
    const auth  = getOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });

    const query = numero
      ? `subject:"Message vocal du ${numero}" in:anywhere`
      : `subject:"${sujet}" in:anywhere`;

    console.log(`[test] Recherche : ${query}`);
    const listRes  = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 1 });
    const messages = listRes.data.messages || [];

    if (messages.length === 0) {
      return res.status(404).json({ error: `Aucun message trouvé pour : ${query}` });
    }

    const msgId  = messages[0].id;
    console.log(`[test] Message trouvé : ${msgId}`);

    const rawMsg = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
    const headers = rawMsg.data.payload.headers;
    const getH   = (n) => headers.find(h => h.name.toLowerCase() === n.toLowerCase())?.value || '';

    const attachments = [];
    async function walkParts(part) {
      if (part.filename && /\.(mp3|wav|ogg|m4a|flac)$/i.test(part.filename)) {
        let data = part.body?.data;
        if (!data && part.body?.attachmentId) {
          const att = await gmail.users.messages.attachments.get({
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

    const patientsMap = await getPatientMap(auth).catch(() => null);

    // ── CORRECTION : replyInThread (et non replyEmail) ────────
    const result = await traiterRepondeur(msg, patientsMap, {
      replyInThread: (threadId, sujet, text, html) => replyInThread(threadId, sujet, text, html),
      applyLabelFn:  (id, label) => applyLabel(id, label),
    });

    if (result) {
      res.json({
        ok:            true,
        identite:      result.identite || 'Patient inconnu',
        numero:        result.numero,
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

// ── DASHBOARD ─────────────────────────────────────────────────
app.get('/dashboard', (_req, res) => {
  res.sendFile(__dirname + '/dashboard.html');
});

// ── DÉMARRAGE ─────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log('═'.repeat(60));
  console.log(`  Gmail Agent — Cabinet 24 Silvestri`);
  console.log(`  v3.3 — Rattrapage répondeur au démarrage`);
  console.log(`  Port : ${PORT}`);
  console.log('═'.repeat(60));

  try {
    const result     = await renewWatch();
    lastHistoryId    = result.historyId;
    const expiration = new Date(parseInt(result.expiration)).toLocaleString('fr-FR');
    console.log(`[watch] Démarré automatiquement — expire le ${expiration}`);
  } catch (err) {
    console.error('[watch] Échec démarrage automatique:', err.message);
    console.error('[watch] Appelle manuellement /watch/start si nécessaire');
  }

  await rattrapageRepondeur();
});

// ── SCAN RÉPONDEUR (appelé par le dashboard) ─────────────────
// GET /api/scan-repondeur?heures=24
app.get('/api/scan-repondeur', async (req, res) => {
  const heures = Math.min(parseInt(req.query.heures) || 24, 48);
  try {
    const { google } = require('googleapis');
    const auth  = getOAuth2Client();
    const gmail = google.gmail({ version: 'v1', auth });

    const apres = Math.floor((Date.now() - heures * 60 * 60 * 1000) / 1000);
    const liste = await gmail.users.messages.list({
      userId:     'me',
      q:          `subject:vocal after:${apres}`,
      maxResults: 20,
    });

    const messages  = liste.data.messages || [];
    const resultats = [];
    let transcrits  = 0;

    for (const m of messages) {
      const thread = await gmail.users.threads.get({ userId: 'me', id: m.threadId });
      const msgs   = thread.data.messages || [];

      // Extraire le sujet pour affichage
      const sujet = msgs[0]?.payload?.headers?.find(h => h.name === 'Subject')?.value || m.id;
      const numeroMatch = sujet.match(/Message vocal du\s+(.+)/i);
      const numero = numeroMatch ? numeroMatch[1] : null;

      // Déjà transcrit ?
      const dejaTraite = msgs.some(tm => {
        const from = tm.payload.headers.find(h => h.name === 'From')?.value || '';
        return from.includes('24silvestri@gmail.com');
      });

      if (dejaTraite) {
        resultats.push({ sujet, numero, statut: 'deja_traite' });
        continue;
      }

      // Transcrire
      try {
        const msg         = await getEmailContent(m.id);
        const patientsMap = await getPatientMap(auth).catch(() => null);
        const result      = await traiterRepondeur(msg, patientsMap, {
          replyInThread: (threadId, suj, text, html) => replyInThread(threadId, suj, text, html),
          applyLabelFn:  (id, label) => applyLabel(id, label),
        });
        processedMessageIds.add(m.id);
        transcrits++;
        resultats.push({
          sujet,
          numero,
          statut:        'transcrit',
          transcription: result?.transcription?.substring(0, 100) || '',
        });
      } catch (err) {
        resultats.push({ sujet, numero, statut: 'erreur', transcription: err.message });
      }
    }

    res.json({ ok: true, transcrits, resultats });
  } catch (err) {
    console.error('[scan-repondeur] Erreur:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});
