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
  if (INTERNE.some(a => fromContains(email, a))) {
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

  // 3. Correspondant clinique connu
  if (CORRESPONDANTS.some(a => fromContains(email, a))) {
    return {
      labels:    ["Correspondants", "À traiter"],
      skipAI:    true,
      categorie: "correspondant",
      raison:    `Correspondant clinique : ${email}`
    };
  }

  // 4. Labo → tri intelligent par sujet
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

  // 5. Fournisseurs connus (Doctolib, UPS, Henry Schein, etc.)
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

module.exports = { preFilter };
