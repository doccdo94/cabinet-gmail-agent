# Déploiement Session 1 — Gmail Agent Cabinet 24 Silvestri
## Auth OAuth2 + Webhook + Lecture emails

---

## Vue d'ensemble de la session

Ce que tu auras à la fin :
- Un service Render qui reçoit les emails Gmail en temps réel (< 5 secondes)
- Les emails logués dans la console Render (from, sujet, corps)
- La base solide pour S2 (pré-filtre) et S3 (Claude)

---

## Étape 1 — Google Cloud Console

**Créer un projet**
1. https://console.cloud.google.com → Nouveau projet
2. Nom : `cabinet-gmail-agent`

**Activer les APIs**
1. APIs et services → Bibliothèque
2. Activer **Gmail API**
3. Activer **Google Sheets API** (pour l'index patients S4)
4. Activer **Cloud Pub/Sub API**

**Créer les identifiants OAuth2**
1. APIs et services → Identifiants → Créer → ID client OAuth 2.0
2. Type : Application Web
3. URI de redirection autorisés : `https://gmail-agent-cabinet.onrender.com/auth/callback`
4. Télécharger le JSON → noter `client_id` et `client_secret`

**Créer le topic Pub/Sub**
1. Pub/Sub → Topics → Créer un topic
2. Nom : `gmail-push`
3. Noter le nom complet : `projects/cabinet-gmail-agent/topics/gmail-push`

**Autoriser Gmail à publier sur le topic**
```bash
# Dans Cloud Shell ou gcloud CLI
gcloud pubsub topics add-iam-policy-binding gmail-push \
  --member="serviceAccount:gmail-api-push@system.gserviceaccount.com" \
  --role="roles/pubsub.publisher" \
  --project=cabinet-gmail-agent
```

**Créer la souscription push**
1. Pub/Sub → Souscriptions → Créer
2. Topic : `projects/cabinet-gmail-agent/topics/gmail-push`
3. Type de livraison : **Push**
4. URL du endpoint : `https://gmail-agent-cabinet.onrender.com/webhook/gmail`
5. Activer l'authentification : **Non** (Render gère le HTTPS)

---

## Étape 2 — Déployer sur Render

**Créer le repo GitHub**
```bash
mkdir gmail-agent-cabinet && cd gmail-agent-cabinet
# Copier les fichiers : index.js, gmail.js, package.json, .env.example
git init && git add . && git commit -m "S1 - init"
git remote add origin https://github.com/TON_COMPTE/gmail-agent-cabinet.git
git push -u origin main
```

**Créer le service Render**
1. https://render.com → New → Web Service
2. Connecter le repo GitHub `gmail-agent-cabinet`
3. Configuration :
   - Name : `gmail-agent-cabinet`
   - Runtime : Node
   - Build Command : `npm install`
   - Start Command : `npm start`
   - Region : Frankfurt (le plus proche)
4. Plan : Free (ou Starter à 7$/mois pour éviter les cold starts)

**Ajouter les variables d'environnement**
Dans Render → Environment → Add from .env :
```
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=    ← vide pour l'instant
GMAIL_ADDRESS=24silvestri@gmail.com
PUBSUB_TOPIC=projects/cabinet-gmail-agent/topics/gmail-push
RENDER_URL=https://gmail-agent-cabinet.onrender.com
ANTHROPIC_API_KEY=sk-ant-...
```

**Déployer** → attendre que le build soit vert ✅

---

## Étape 3 — Obtenir le refresh_token

1. Ouvrir dans un navigateur : `https://gmail-agent-cabinet.onrender.com/auth/gmail`
2. Connexion avec le compte `24silvestri@gmail.com`
3. Accepter les permissions (Gmail modify + Sheets readonly)
4. Copier le `refresh_token` affiché
5. Dans Render → Environment → `GMAIL_REFRESH_TOKEN` = coller la valeur
6. Redéployer (ou Render redémarre automatiquement)

---

## Étape 4 — Démarrer le watch Gmail

```
GET https://gmail-agent-cabinet.onrender.com/watch/start
```

Réponse attendue :
```json
{
  "ok": true,
  "expiration": "20/05/2026 à 15:30:00",
  "historyId": "123456"
}
```

---

## Étape 5 — Vérifier

**Health check :**
```
GET https://gmail-agent-cabinet.onrender.com/health
```

**Test en vrai :**
Envoyer un email de test à `24silvestri@gmail.com` depuis une adresse externe.
Dans Render → Logs, tu dois voir apparaître dans les 5 secondes :
```
[webhook] Notification reçue — historyId: 123457
[email] De      : test@exemple.com
[email] Sujet   : Test webhook
[email] Corps   : Bonjour, ceci est un test...
```

---

## Dépannage fréquent

| Problème | Cause probable | Solution |
|---|---|---|
| Pas de notification reçue | Watch non démarré | Appeler /watch/start |
| 404 sur /webhook/gmail | URL souscription incorrecte | Vérifier l'URL dans Pub/Sub |
| Erreur 403 Gmail API | Scopes insuffisants | Refaire /auth/gmail |
| historyId 404 | historyId trop ancien | Redémarrer le service |
| Cold start Render (30s) | Plan Free | Passer en Starter ou utiliser UptimeRobot |

---

## Ce qui arrive en Session 2

- `prefilter.js` : tri par règles (correspondants, labos, fournisseurs, interne) → labels Gmail directs, 0 token AI
- `sheets.js` : stub pour l'index patients Doctolib (activé en S4)
- `processEmail()` dans `index.js` : logique de décision complète
