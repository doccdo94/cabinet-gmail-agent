// ============================================================
// index.js — Serveur Express principal
// Cabinet 24 Silvestri — Gmail Agent v2.0 (Session 2)
// Nouveauté : pré-filtre règles + application labels Gmail
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
} = require('./gmail');
const { preFilter } = require('./prefilter');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ── STATE ─────────────────────────────────────────────────────
let lastHistoryId = null;
const processedMessageIds = new Set();

// Compteurs session (remis à zéro au redémarrage)
const stats = { total: 0, connus: 0, inconnus: 0, errors: 0 };

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:        'ok',
    service:       'gmail-agent-cabinet-s2',
    version:       '2.0.0',
    lastHistoryId,
    uptime:        Math.floor(process.uptime()) + 's',
    timestamp:     new Date().toISOString(),
    stats,
  });
});

// ── AUTH GMAIL ────────────────────────────────────────────────
app.get('/auth/gmail', (_req, res) => {
  res.redirect(getAuthUrl());
});

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
    console.log(`[watch] Démarré — expire le ${expiration} — historyId: ${lastHistoryId}`);
    res.json({ ok: true, expiration, historyId: result.historyId });
  } catch (err) {
    console.error('[watch] Erreur:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── WEBHOOK GMAIL (Pub/Sub push) ──────────────────────────────
app.post('/webhook/gmail', async (req, res) => {
  res.sendStatus(200); // répondre immédiatement

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

    const messages = await getNewMessages(lastHistoryId);
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

  try {
    // ── COUCHE 1 : pré-filtre règles (0 token AI) ─────────────
    const decision = preFilter(msg);

    if (decision) {
      stats.connus++;
      console.log(`[filtre] ${decision.categorie} — ${decision.raison}`);
      console.log(`[filtre] Labels : ${decision.labels.join(', ')}`);

      // Appliquer tous les labels en parallèle
      await Promise.all(decision.labels.map(l => applyLabel(msg.id, l)));
      console.log(`[filtre] Labels appliqués`);

    } else {
      // ── COUCHE 2 : inconnu → Claude Sonnet (S3) ───────────
      stats.inconnus++;
      console.log(`[filtre] Inconnu → en attente Claude S3`);
      console.log(`[filtre] Corps : ${msg.body.substring(0, 100)}...`);
      // S3 : await classifyWithClaude(msg);
    }

  } catch (err) {
    stats.errors++;
    console.error(`[email] Erreur traitement : ${err.message}`);
  }

  console.log('─'.repeat(60));
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

// ── DÉMARRAGE ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('═'.repeat(60));
  console.log(`  Gmail Agent — Cabinet 24 Silvestri`);
  console.log(`  Session 2 — Pré-filtre règles + Labels Gmail`);
  console.log(`  Port : ${PORT}`);
  console.log('═'.repeat(60));
});
