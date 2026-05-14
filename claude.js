// ============================================================
// claude.js — Classification Sonnet + Brouillon Haiku
// Cabinet 24 Silvestri — Gmail Agent v3.0 (Session 3)
// ============================================================

const CABINET  = 'Cabinet 24 Silvestri';
const DOCTEUR  = 'Dr Comy';
const TEL      = '01 43 28 29 23';

const MODEL_SONNET = 'claude-sonnet-4-20250514'; // classification
const MODEL_HAIKU  = 'claude-haiku-4-5-20251001'; // brouillons

// ── APPEL API ANTHROPIC ───────────────────────────────────────
async function callAnthropic(model, prompt, maxTokens = 600) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  const json = await res.json();
  if (json.error) throw new Error(`Claude API : ${json.error.message}`);
  return json.content[0].text.trim();
}

// ── CLASSIFICATION (Sonnet) ───────────────────────────────────
// Retourne un objet JSON avec la décision de traitement
async function classifyEmail(msg) {
  const prompt = `Tu es le système de tri des emails du ${CABINET} (${DOCTEUR}, chirurgien-dentiste à Vincennes).

Analyse cet email et réponds UNIQUEMENT en JSON valide, sans balises markdown :

{
  "categorie": "patient_urgent" | "patient" | "correspondant" | "labo_facture" | "labo_clinique" | "fournisseur" | "interne" | "pub",
  "urgence": true | false,
  "raison": "explication en 1 ligne",
  "label_gmail": "Correspondants" | "Labo" | "Factures" | "Livraisons" | "Doctolib" | "Interne" | "Newsletters" | null,
  "generer_brouillon": true | false
}

Règles de classification :
- patient_urgent : douleur intense, gonflement, saignement, accident dentaire, complication post-op → urgence:true
- patient : toute demande patient classique (RDV, question, info)
- correspondant : confrère dentiste ou spécialiste (même si adresse inconnue)
- labo_facture : facture ou document comptable d'un labo dentaire
- labo_clinique : bon de travail, essayage, info clinique d'un labo
- fournisseur : livraison, commande, facture fournisseur non-labo
- interne : email entre praticiens du cabinet
- pub : newsletter, publicité, promotion → label_gmail:"Newsletters", generer_brouillon:false

Règle brouillon : generer_brouillon:true uniquement pour patient et patient_urgent.
Règle label : null si pas de label spécifique à appliquer (ex: patient → null, le label "Brouillon IA" sera ajouté séparément).

Email à analyser :
De : ${msg.from}
Objet : ${msg.subject}
Corps : ${msg.body.substring(0, 1500)}`;

  const raw = await callAnthropic(MODEL_SONNET, prompt, 300);

  try {
    return JSON.parse(raw);
  } catch {
    // Tentative de récupération si Claude a ajouté du texte autour
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Classification JSON invalide : ${raw.substring(0, 100)}`);
  }
}

// ── BROUILLON PATIENT (Haiku) ─────────────────────────────────
// patient : objet avec { gender, first_name, last_name, crucial_info } ou null
async function genererBrouillon(msg, patient = null) {
  // Formule d'appel personnalisée si patient trouvé dans l'index
  let formule = 'Madame, Monsieur,';
  if (patient?.first_name && patient?.last_name) {
    const civilite = patient.gender === 'Mme' ? 'Madame' :
                     patient.gender === 'M.'  ? 'Monsieur' :
                     patient.first_name; // prénom seul si genre inconnu
    formule = `${civilite} ${patient.last_name},`;
  }

  // Contexte patient si crucial_info renseigné
  const contexte = patient?.crucial_info
    ? `\nContexte patient : ${patient.crucial_info}`
    : '';

  const prompt = `Tu es l'assistant du ${CABINET} (${DOCTEUR}, chirurgien-dentiste à Vincennes).
Rédige un brouillon de réponse email professionnel, chaleureux et concis.

Règles :
- Commence par : ${formule}
- Réponds précisément à la question posée${contexte}
- Si avis médical nécessaire : invite à prendre RDV sur Doctolib ou appeler le cabinet
- Signature : Cordialement,\n${DOCTEUR}\n${CABINET}\nTél : ${TEL}
- 3 à 6 lignes maximum, pas de mise en forme, pas de balises

De : ${msg.from}
Objet : ${msg.subject}
Message :
${msg.body.substring(0, 1200)}

Brouillon :`;

  return await callAnthropic(MODEL_HAIKU, prompt, 400);
}

module.exports = { classifyEmail, genererBrouillon };
