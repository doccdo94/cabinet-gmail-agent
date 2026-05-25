// ============================================================
// prefilter.js — Pré-filtre règles (0 token AI)
// Cabinet 24 Silvestri — Gmail Agent v3.1
// Retourne une décision si l'expéditeur est connu,
// null si inconnu → sera traité par Claude
// Gère aussi le label "À traiter" et "Répondeur à traiter"
// ============================================================

// ── LISTES D'ADRESSES ─────────────────────────────────────────

const CORRESPONDANTS = [
  "drhannakruk@gmail.com",
  "secretariat@endosaintmaur.fr",
  "bonjour@smile2.fr",
  "dr.simkova.simona@gmail.com",
  "bealimplanto94@gmail.com",
  "chir.espacedentairefoch@gmail.com",
  "paro.espacedentairefoch@gmail.com",
  "dr.cecile.renaut@gmail.com",
  "dr.arnaudservant@gmail.com",
  "doclefebvre@yahoo.fr",
  "cabendodontiedrattal@gmail.com",
  "cabinetchousterman@gmail.com",
  "sophie.abecassis-faibis@orange.fr",
  "practitioners@email.oraldata.ai"
];

const LABOS = [
  "morphodent@hotmail.com",
  "info@laboratoireconnexion.fr",
  "laboellipse@hotmail.com",
  "barret.laboratoiredentaire@gmail.com",
  "barret.laboratoiredentaire@orange.fr",
  "prothesis"   // AL DENTE via Prothesis Cloud (fragment suffisant)
];

const INTERNE = [
  "24silvestri@gmail.com",
  "contact@dr-comy-stephane.chirurgiens-dentistes.fr",
  "cdo94.conseiller.sc@gmail.com",
  "comystep@gmail.com",
  "docteur.giraudeau@gmail.com"
];

// ── MOTS-CLÉS TRI LABO ────────────────────────────────────────

const SUJETS_FACTURE = [
  "facture", "invoice", "avoir", "reglement", "paiement",
  "devis labo", "bon de commande"
];

const SUJETS_CLINIQUE = [
  "bon de travail", "travaux", "essayage", "insertion", "teinte",
  "maquette", "armature", "ceramique", "zircone", "provisoire", "empreinte"
];

// ── RÈGLES FOURNISSEURS ───────────────────────────────────────

const FOURNISSEURS = [
  { label: "Livraisons", patterns: ["ups.com", "cetip"] },
  { label: "Factures",   patterns: ["3dcelo", "henryschein", "henry schein", "zimvie"] },
  { label: "Doctolib",   patterns: ["doctolib"] },
];

// ── UTILITAIRE ────────────────────────────────────────────────

function fromContains(from, fragment) {
  return from.toLowerCase().includes(fragment.toLowerCase());
}

function extractEmail(from) {
  const match = from.match(/<(.+?)>/);
  return (match ? match[1] : from).toLowerCase().trim();
}

// ── FILTRE PRINCIPAL ──────────────────────────────────────────
// Retourne : { labels: [], skipAI: bool, categorie: string, raison: string }
// ou null si inconnu

function preFilter(msg) {
  const from  = msg.from || '';
  const email = extractEmail(from);
  const sujet = (msg.subject || '').toLowerCase();

  // 1. Adresse interne → ignorer complètement
  // On vérifie l'email extrait (pas le nom d'affichage) pour éviter les faux positifs
  const estInterne = INTERNE.some(a => email.includes(a.toLowerCase()));
  if (estInterne) {
    return {
      labels:    ["Interne"],
      skipAI:    true,
      categorie: "interne",
      raison:    "Adresse interne cabinet"
    };
  }

  // 2. Répondeur OVH (transcriptions vocales)
  // Détecte : "repondeur" dans le nom d'affichage OU adresse ovhcloud
  const estRepondeur = fromContains(from, "repondeur") || fromContains(from, "ovhcloud");
  if (estRepondeur) {
    return {
      labels:    ["Répondeur à traiter", "À traiter"],
      skipAI:    true,
      categorie: "repondeur",
      raison:    "Message vocal OVH — pas de brouillon"
    };
  }

  // 3. Panoramique — détecté par sujet avant la classification correspondant
  const sujetLower = (msg.subject || '').toLowerCase();
  const estPanora = sujetLower.includes('panoramique') || sujetLower.includes('pano ');
  if (estPanora) {
    return {
      labels:    ["Panoramiques", "Correspondants", "À traiter"],
      skipAI:    true,
      categorie: "panoramique",
      raison:    "Panoramique dentaire"
    };
  }

  // 4. Correspondant clinique connu
  if (CORRESPONDANTS.some(a => fromContains(email, a))) {
    return {
      labels:    ["Correspondants", "À traiter"],
      skipAI:    true,
      categorie: "correspondant",
      raison:    `Correspondant clinique : ${email}`
    };
  }

  // 5. Labo → tri intelligent par sujet
  if (LABOS.some(a => fromContains(email, a))) {
    const estFacture  = SUJETS_FACTURE.some(k => sujet.includes(k));
    const estClinique = SUJETS_CLINIQUE.some(k => sujet.includes(k));
    const labels = [];

    if (estFacture)  labels.push("Factures");
    if (estClinique) labels.push("Labo");
    if (!estFacture && !estClinique) {
      labels.push("Factures", "Labo"); // ambigu → les deux
    }

    return {
      labels,
      skipAI:    true,
      categorie: estFacture && !estClinique ? "labo_facture" : "labo_clinique",
      raison:    `Labo ${email} — sujet: ${estFacture ? "facture" : ""}${estClinique ? " clinique" : ""}${!estFacture && !estClinique ? "ambigu" : ""}`
    };
  }

  // 6. Fournisseurs connus (Doctolib, UPS, Henry Schein, etc.)
  for (const f of FOURNISSEURS) {
    if (f.patterns.some(p => fromContains(from, p))) {
      return {
        labels:    [f.label],
        skipAI:    true,
        categorie: "fournisseur",
        raison:    `Fournisseur : ${f.label} — ${email}`
      };
    }
  }

  // 6. Inconnu → null → Claude Sonnet en S3
  return null;
}

// ── CONFIG MUTABLE (modifiable via API) ──────────────────────
// Copies mutables des listes pour l'API de gestion
let _correspondants = [...CORRESPONDANTS];
let _labos          = [...LABOS];
let _interne        = [...INTERNE];
let _fournisseurs   = FOURNISSEURS.map(f => ({ ...f, patterns: [...f.patterns] }));

// Expose les listes pour l'API
const CORRESPONDANTS_LIST = _correspondants;
const LABOS_LIST          = _labos;
const INTERNE_LIST        = _interne;
const FOURNISSEURS_LIST   = _fournisseurs;

function getConfig() {
  return {
    correspondants: _correspondants,
    labos:          _labos,
    interne:        _interne,
    fournisseurs:   _fournisseurs,
  };
}

function updateConfig({ list, action, value, index, label, patterns }) {
  if (list === 'correspondants') {
    if (action === 'add' && value)    _correspondants.push(value.toLowerCase().trim());
    if (action === 'remove' && index !== undefined) _correspondants.splice(index, 1);
  } else if (list === 'labos') {
    if (action === 'add' && value)    _labos.push(value.toLowerCase().trim());
    if (action === 'remove' && index !== undefined) _labos.splice(index, 1);
  } else if (list === 'interne') {
    if (action === 'add' && value)    _interne.push(value.toLowerCase().trim());
    if (action === 'remove' && index !== undefined) _interne.splice(index, 1);
  } else if (list === 'fournisseurs') {
    if (action === 'add' && label && patterns) _fournisseurs.push({ label, patterns });
    if (action === 'remove' && index !== undefined) _fournisseurs.splice(index, 1);
    if (action === 'add-pattern' && index !== undefined && value)
      _fournisseurs[index].patterns.push(value.toLowerCase().trim());
    if (action === 'remove-pattern' && index !== undefined && patterns !== undefined)
      _fournisseurs[index].patterns.splice(patterns, 1);
  } else {
    throw new Error('Liste inconnue : ' + list);
  }
  return getConfig();
}

function exportConfig() {
  const arr = a => a.map(s => `  "${s}"`).join(',\n');
  const fournStr = _fournisseurs.map(f =>
    `  { label: "${f.label}", patterns: [${f.patterns.map(p => `"${p}"`).join(', ')}] }`
  ).join(',\n');

  return `// prefilter.js — généré le ${new Date().toLocaleDateString('fr-FR')}
// Cabinet 24 Silvestri — Gmail Agent

const CORRESPONDANTS = [
${arr(_correspondants)}
];

const LABOS = [
${arr(_labos)}
];

const INTERNE = [
${arr(_interne)}
];

const FOURNISSEURS = [
${fournStr}
];
// ... (reste du fichier inchangé)
`;
}

module.exports = { preFilter, getConfig, updateConfig, exportConfig,
  CORRESPONDANTS_LIST, LABOS_LIST, INTERNE_LIST, FOURNISSEURS_LIST };
