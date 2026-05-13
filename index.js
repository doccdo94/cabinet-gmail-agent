// ============================================================
// index.js — Serveur Express principal
// Cabinet 24 Silvestri — Gmail Agent v1.0 (Session 1)
// ============================================================

require('dotenv').config();
const express = require('express');
const {
  getAuthUrl,
  handleCallback,
  renewWatch,
  decodeWebhook,
  getNewMessages,
} = require('./gmail');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── STATE ─────────────────────────────────────────────────────
// historyId du dernier traitement (remplacé par Supabase en S4)
let lastHistoryId = null;
const processedMessageIds = new Set(); // évite les doublons si Gmail renvoie plusieurs fois

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'gmail-agent-cabinet-s1',
    version: '1.0.0',
    lastHistoryId,
    uptime: Math.floor(process.uptime()) + 's',
    timestamp: new Date().toISOString(),
  });
});

// ── AUTH GMAIL — Étape 1 : redirection vers Google ───────────
app.get('/auth/gmail', (_req, res) => {
  res.redirect(getAuthUrl());
});

// ── AUTH GMAIL — Étape 2 : callback Google ───────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;

  if (error) return res.status(400).send(`Erreur Google : ${error}`);
  if (!code) return res.status(400).send('Code OAuth2 manquant');

  try {
    const tokens = await handleCallback(code);
    // Afficher le refresh_token une seule fois → à copier dans les variables Render
    res.send(`
      <h2>✅ Auth Gmail réussie</h2>
      <p>Copie le <strong>refresh_token</strong> dans tes variables d'environnement Render :</p>
      <pre style="background:#f5f5f5;padding:16px;border-radius:8px;word-break:break-all">
GMAIL_REFRESH_TOKEN=${tokens.refresh_token || '(déjà configuré — token non renvoyé)'}
      </pre>
      <p>Ensuite, démarre le watch : <a href="/watch/start">GET /watch/start</a></p>
    `);
  } catch (err) {
    console.error('[auth] Erreur callback:', err.message);
    res.status(500).send(`Erreur auth : ${err.message}`);
  }
});

// ── DÉMARRAGE DU WATCH GMAIL ──────────────────────────────────
// À appeler manuellement une fois après le déploiement,
// puis automatiquement toutes les 6 jours (voir setInterval ci-dessous)
app.get('/watch/start', async (_req, res) => {
  try {
    const result = await renewWatch();
    const expiration = new Date(parseInt(result.expiration)).toLocaleString('fr-FR');
    console.log(`[watch] Démarré — expire le ${expiration}`);
    res.json({ ok: true, expiration, historyId: result.historyId });
  } catch (err) {
    console.error('[watch] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK GMAIL (Pub/Sub push) ──────────────────────────────
app.post('/webhook/gmail', async (req, res) => {
  // ⚠️ Répondre 200 immédiatement — Pub/Sub retente si pas de réponse rapide
  res.sendStatus(200);

  try {
    const notification = decodeWebhook(req.body);
    if (!notification) {
      console.warn('[webhook] Notification invalide ou vide');
      return;
    }

    const { historyId, emailAddress } = notification;
    console.log(`[webhook] Notification reçue — historyId: ${historyId} — compte: ${emailAddress}`);

    // Premier run : initialiser sans traiter (évite de rejouer l'historique entier)
    if (!lastHistoryId) {
      lastHistoryId = historyId;
      console.log(`[webhook] Init — historyId initialisé à ${historyId}`);
      return;
    }

    // Récupérer les nouveaux messages depuis le dernier historyId connu
    const messages = await getNewMessages(lastHistoryId);
    lastHistoryId = historyId; // mettre à jour avant traitement (même si erreur sur un message)

    if (messages.length === 0) {
      console.log('[webhook] Aucun nouveau message INBOX');
      return;
    }

    console.log(`[webhook] ${messages.length} message(s) à traiter`);
    for (const msg of messages) {
      if (processedMessageIds.has(msg.id)) {
        console.log(`[webhook] Message ${msg.id} déjà traité, ignoré`);
        continue;
      }
      processedMessageIds.add(msg.id);
      // Nettoyage du Set après 1000 entrées pour éviter la fuite mémoire
      if (processedMessageIds.size > 1000) {
        const first = processedMessageIds.values().next().value;
        processedMessageIds.delete(first);
      }

      await processEmail(msg);
    }
  } catch (err) {
    console.error('[webhook] Erreur non gérée:', err.message);
  }
});

// ── TRAITEMENT D'UN EMAIL ─────────────────────────────────────
// SESSION 1 : log uniquement — sera complété en S2 (pré-filtre) et S3 (Claude)
async function processEmail(msg) {
  console.log('─'.repeat(60));
  console.log(`[email] ID      : ${msg.id}`);
  console.log(`[email] De      : ${msg.from}`);
  console.log(`[email] Sujet   : ${msg.subject}`);
  console.log(`[email] Date    : ${msg.date}`);
  console.log(`[email] Corps   : ${msg.body.substring(0, 120)}...`);
  console.log('─'.repeat(60));

  // ── À REMPLIR EN SESSION 2 ────────────────────────────────
  // const decision = preFilter(msg);          // règles sans AI
  // if (decision) return await applyDecision(msg, decision);

  // ── À REMPLIR EN SESSION 3 ────────────────────────────────
  // const decision = await classifyWithClaude(msg);
  // await applyDecision(msg, decision);
}

// ── RENOUVELLEMENT AUTOMATIQUE DU WATCH (toutes les 6 jours) ─
const SIX_DAYS_MS = 6 * 24 * 60 * 60 * 1000;
setInterval(async () => {
  try {
    await renewWatch();
    console.log('[watch] Renouvelé automatiquement');
  } catch (err) {
    console.error('[watch] Échec du renouvellement automatique:', err.message);
  }
}, SIX_DAYS_MS);

// ── DÉMARRAGE ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('═'.repeat(60));
  console.log(`  Gmail Agent — Cabinet 24 Silvestri`);
  console.log(`  Session 1 — Auth + Webhook + Lecture emails`);
  console.log(`  Port : ${PORT}`);
  console.log('═'.repeat(60));
});
