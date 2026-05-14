# Agent Gmail — Cahier des charges
## Cabinet 24 Silvestri — Phase 2

---

## Contexte

La phase 1 (Apps Script + Claude Haiku) fonctionne mais a deux limites :
- Délai de 10 minutes entre la réception et le traitement
- Classification basée sur l'expéditeur (règles), pas sur le contenu

La phase 2 est un **agent Claude** déployé sur Render, qui reçoit les emails en temps réel via l'API Gmail (push webhook) et prend des décisions intelligentes basées sur le contenu complet de l'email.

---

## Architecture cible

```
Gmail
  │
  └── Push Notification (webhook temps réel)
            │
            ▼
      Agent Render (Node.js/Express)
            │
            ├── Lit le contenu complet de l'email
            │
            ├── Appel Claude Sonnet (classification)
            │       │
            │       ├── patient urgent
            │       ├── patient classique
            │       ├── correspondant clinique
            │       ├── labo (facture ou clinique)
            │       ├── fournisseur
            │       └── newsletter / pub → archiver
            │
            ├── Applique le label Gmail
            │
            ├── Si patient → génère brouillon de réponse
            │
            └── Si urgent → SMS via Brevo
```

---

## Stack technique

| Composant | Technologie | Justification |
|---|---|---|
| Serveur | Node.js / Express | Cohérent avec garde-cdo94 et Cabinet |
| Hébergement | Render (web service) | Déjà utilisé, gratuit ou 7$/mois |
| Auth Gmail | OAuth2 + Google API | API officielle, webhooks push |
| Classification | Claude Sonnet | Plus précis que Haiku pour le contenu |
| Brouillons | Claude Haiku | Suffisant, moins cher |
| SMS urgence | Brevo | Déjà configuré |
| Logs | Supabase | Déjà utilisé (jfagpzlwlnoahhovzfkd) |
| Config | `.env` sur Render | Standard |

---

## Variables d'environnement (.env)

```
ANTHROPIC_API_KEY=sk-ant-...
GMAIL_CLIENT_ID=...
GMAIL_CLIENT_SECRET=...
GMAIL_REFRESH_TOKEN=...
GMAIL_ADDRESS=24silvestri@gmail.com
BREVO_API_KEY=...
BREVO_SMS_SENDER=CabinetComy
BREVO_SMS_RECIPIENT=+336XXXXXXXX
SUPABASE_URL=https://jfagpzlwlnoahhovzfkd.supabase.co
SUPABASE_KEY=...
PORT=3000
```

---

## Prompt de classification (Claude Sonnet)

```
Tu es le système de tri des emails du Cabinet 24 Silvestri
(Dr Comy, chirurgien-dentiste à Vincennes).

Analyse cet email et réponds UNIQUEMENT en JSON :

{
  "categorie": "patient_urgent" | "patient" | "correspondant" | "labo_facture" | "labo_clinique" | "fournisseur" | "interne" | "pub",
  "urgence": true | false,
  "raison": "explication en 1 ligne",
  "label_gmail": "Correspondants" | "Labo" | "Factures" | "Livraisons" | "Doctolib" | "Interne" | "Newsletters" | null,
  "generer_brouillon": true | false,
  "envoyer_sms": true | false
}

Critères d'urgence (envoyer_sms: true) :
- Douleur intense, gonflement, saignement anormal
- Accident dentaire (dent cassée, déchaussée)
- Complication post-opératoire

Correspondants cliniques connus :
- drhannakruk@gmail.com (Dr Kruk)
- secretariat@endosaintmaur.fr (Dr Boussignac, endodontie)
- bonjour@smile2.fr (Cabinet Smile2)
- dr.simkova.simona@gmail.com
- bealimplanto94@gmail.com (Dr Beal, implanto)
- chir.espacedentairefoch@gmail.com
- paro.espacedentairefoch@gmail.com
- dr.cecile.renaut@gmail.com
- dr.arnaudservant@gmail.com
- doclefebvre@yahoo.fr
- cabendodontiedrattal@gmail.com (Dr Attal, endo)
- cabinetchousterman@gmail.com
- sophie.abecassis-faibis@orange.fr
- practitioners@email.oraldata.ai

Labos connus :
- morphodent@hotmail.com
- info@laboratoireconnexion.fr
- laboellipse@hotmail.com
- barret.laboratoiredentaire@gmail.com
- barret.laboratoiredentaire@orange.fr
- prothesis (AL DENTE via Prothesis Cloud)

Adresses internes (ignorer) :
- 24silvestri@gmail.com
- docteur.giraudeau@gmail.com
- comystep@gmail.com
- cdo94.conseiller.sc@gmail.com
- repondeur (transcriptions vocales OVH)

Email à analyser :
De : {{from}}
Objet : {{subject}}
Corps : {{body}}
```

---

## Structure du projet Render

```
gmail-agent/
├── index.js          (serveur Express + webhook)
├── gmail.js          (auth OAuth2 + lecture emails)
├── claude.js         (classification + brouillon)
├── labels.js         (application labels Gmail)
├── brevo.js          (envoi SMS urgence)
├── supabase.js       (logs)
├── .env
└── package.json
```

---

## Endpoints

| Route | Méthode | Description |
|---|---|---|
| `/webhook/gmail` | POST | Reçoit les push notifications Gmail |
| `/auth/gmail` | GET | Flow OAuth2 initial |
| `/auth/callback` | GET | Callback OAuth2 |
| `/health` | GET | Healthcheck Render |
| `/logs` | GET | Derniers emails traités |

---

## Table Supabase : `gmail_logs`

```sql
CREATE TABLE gmail_logs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at  timestamptz DEFAULT now(),
  from_addr   text,
  subject     text,
  categorie   text,
  label       text,
  urgence     boolean DEFAULT false,
  brouillon   boolean DEFAULT false,
  sms_envoye  boolean DEFAULT false,
  raison      text
);
```

---

## Flux de traitement détaillé

```javascript
// 1. Gmail envoie un push au webhook
app.post('/webhook/gmail', async (req, res) => {

  // 2. Décoder la notification
  const message = decodeGmailPush(req.body);

  // 3. Récupérer l'email complet via API Gmail
  const email = await getEmailContent(message.emailId);

  // 4. Claude classifie
  const decision = await classifier(email.from, email.subject, email.body);

  // 5. Appliquer le label Gmail
  if (decision.label_gmail) {
    await applyLabel(message.emailId, decision.label_gmail);
  }

  // 6. Générer brouillon si patient
  if (decision.generer_brouillon) {
    const brouillon = await genererBrouillon(email);
    await createDraft(email, brouillon);
  }

  // 7. SMS si urgence
  if (decision.envoyer_sms) {
    await envoyerSMS(`URGENT Cabinet: ${email.from} — ${email.subject}`);
  }

  // 8. Logger dans Supabase
  await logEmail(email, decision);

  res.sendStatus(200);
});
```

---

## Comparaison Phase 1 vs Phase 2

| Critère | Phase 1 (Apps Script) | Phase 2 (Agent Render) |
|---|---|---|
| Délai traitement | ~10 min | Temps réel (<5 sec) |
| Classification | Règles (expéditeur) | IA (contenu complet) |
| Détection urgence | Non | Oui + SMS |
| Maintenance | Listes à tenir à jour | Zéro liste |
| Coût | ~0,50 €/mois | ~1-2 €/mois |
| Complexité mise en place | Faible | Moyenne |

---

## Prérequis avant de démarrer

- [ ] Gmail API activée sur Google Cloud Console
- [ ] OAuth2 configuré (client ID + secret)
- [ ] Refresh token généré via flow OAuth initial
- [ ] Compte Render avec le service existant comme référence
- [ ] Table `gmail_logs` créée dans Supabase
- [ ] Numéro SMS Brevo vérifié

---

## Estimation de développement

| Étape | Durée estimée |
|---|---|
| Auth Gmail OAuth2 + webhook | 1 session |
| Classification Claude + labels | 1 session |
| Brouillons + SMS urgence | 1 session |
| Logs Supabase + healthcheck | 30 min |
| Tests + déploiement Render | 1 session |

---

## Notes importantes

- Le webhook Gmail nécessite un **domaine HTTPS vérifié** → Render le fournit automatiquement
- Les push notifications Gmail expirent après **7 jours** → renouvellement automatique via cron
- Le refresh token OAuth2 ne expire pas → à stocker dans les variables Render
- Gmail push envoie uniquement l'ID du message, pas le contenu → appel API séparé nécessaire
