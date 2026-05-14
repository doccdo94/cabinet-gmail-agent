# Gmail Manager — Cabinet 24 Silvestri

## Vue d'ensemble

Système de tri et d'automatisation de la boîte Gmail `24silvestri@gmail.com`.  
Combinaison de Gmail natif + Google Apps Script + Claude API (Haiku).

---

## Architecture

```
Email entrant
    │
    ├── Gmail natif → Promotions / Social / Updates (pubs, newsletters)
    │
    └── Apps Script (toutes les 10 min)
            │
            ├── Correspondants cliniques  → label Correspondants
            ├── Labos                     → label Labo ou Factures (tri intelligent)
            ├── Fournisseurs              → label Factures / Livraisons / Doctolib
            └── Patients                 → brouillon IA (Claude Haiku)
```

---

## Fichiers du projet

| Fichier | Description |
|---|---|
| `gmail-manager.gs` | Script Apps Script principal |
| `gmail-manager.html` | Interface de gestion des règles |
| `README.md` | Ce fichier |

---

## Configuration Gmail — Boîte de réception multiple

Paramètres → Boîte de réception → Type : **Plusieurs boîtes de réception**

### Section 1 — Patients à traiter
```
is:unread in:inbox -category:promotions -category:social -category:updates -label:Correspondants -label:Interne -label:Labo -label:Factures -label:Doctolib -label:Livraisons -label:Brouillon-IA
```

### Section 2 — Correspondants cliniques
```
label:Correspondants -from:repondeur
```

### Section 3 — Factures fournisseurs
```
label:Factures is:unread
```

### Section 4 — Labo
```
label:Labo
```

### Section 5 — Divers
```
in:inbox -label:Correspondants -label:Factures -label:Labo -category:promotions
```

**Réglages :**
- Position : À droite de la boîte de réception
- Taille : 9 conversations par section

---

## Labels créés automatiquement

| Label | Contenu |
|---|---|
| Correspondants | Confrères, comptes rendus, radios |
| Labo | Bons de travail, infos cliniques labos |
| Factures | Factures fournisseurs (Henry Schein, 3Dcelo, ZimVie…) |
| Livraisons | UPS, CETIP |
| Doctolib | Tout ce qui vient de Doctolib |
| Newsletters | Pubs archivées (complément Gmail natif) |
| Brouillon IA | Emails patients ayant généré un brouillon |
| Interne | Emails entre praticiens du cabinet |
| Assistantes | Documents assistantes |
| Vocal traite | Transcriptions messages vocaux OVH |
| Panoramiques | Radios panoramiques reçues |

---

## Triggers Apps Script

| Fonction | Fréquence |
|---|---|
| `genererBrouillonsPatients` | Toutes les 10 min |
| `labelliserCorrespondants` | Toutes les heures |
| `labelliserLabos` | Toutes les heures |
| `appliquerFiltres` | Toutes les 6 heures |
| `alerteFactures` | Chaque lundi à 8h |

---

## Mise en place initiale

1. Ouvrir [script.google.com](https://script.google.com)
2. Nouveau projet → coller `gmail-manager.gs`
3. Remplacer `sk-ant-NOUVELLE-CLE-ICI` par la clé API Anthropic
4. Exécuter `configurerTriggers()`
5. Configurer les 5 sections Gmail (voir ci-dessus)

---

## Clé API Anthropic

- Générer sur [console.anthropic.com](https://console.anthropic.com) → API Keys
- Modèle utilisé : `claude-haiku-4-5-20251001`
- Coût estimé : < 1 €/mois

---

## Correspondants cliniques

| Praticien | Adresse | Spécialité |
|---|---|---|
| Dr Hanna KRUK | drhannakruk@gmail.com | |
| Dr Claire BOUSSIGNAC | secretariat@endosaintmaur.fr | Endodontie |
| Cabinet SMILE2 | bonjour@smile2.fr | |
| Dr Simona SIMKOVA | dr.simkova.simona@gmail.com | |
| Dr BEAL | bealimplanto94@gmail.com | Implantologie |
| Espace Dentaire Foch (chir) | chir.espacedentairefoch@gmail.com | Chirurgie |
| Espace Dentaire Foch (paro) | paro.espacedentairefoch@gmail.com | Parodontologie |
| Dr Cécile RENAUT | dr.cecile.renaut@gmail.com | |
| Dr Arnaud SERVANT | dr.arnaudservant@gmail.com | |
| Dr Stéphane LEFEBVRE | doclefebvre@yahoo.fr | |
| Dr Sarah ATTAL | cabendodontiedrattal@gmail.com | Endodontie |
| Dr Michel CHOUSTERMAN | cabinetchousterman@gmail.com | |
| Dr Sophie ABECASSIS | sophie.abecassis-faibis@orange.fr | |
| Dr BOUSSIGNAC via OralData | practitioners@email.oraldata.ai | |

---

## Labos

| Labo | Adresse |
|---|---|
| AL DENTE (Prothesis Cloud) | prothesis |
| Morphodent | morphodent@hotmail.com |
| Laboratoire Connexion | info@laboratoireconnexion.fr |
| Labo Ellipse | laboellipse@hotmail.com |
| Barret | barret.laboratoiredentaire@gmail.com |
| Barret (ancienne) | barret.laboratoiredentaire@orange.fr |

---

## Évolutions prévues

- [ ] Agent Claude sur Render (classification temps réel par contenu)
- [ ] Intégration Doctolib (détection prénom patient dans email)
- [ ] Dashboard consommation API
- [ ] Archivage automatique après réponse envoyée
