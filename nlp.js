/**
 * nlp.js — Moteur NLP serveur BSIC AI
 *
 * Corrections appliquées :
 *  1. Langue figée à la création de session (ne re-détecte plus à chaque message)
 *  2. Commandes globales "stop/annuler/aide/menu" interceptées avant tout
 *  3. Validation des champs du formulaire (longueur, format contact)
 *  4. Dictionnaire de normalisation GSM (abréviations, fautes mobiles)
 *  5. Message de reprise propre si session perdue (redémarrage serveur)
 *  6. Seuil NLP adaptatif + bonus sur messages courts
 */

'use strict';

// ══════════════════════════════════════════════════════════════════════════════
// 1. NORMALISATION GSM — corrige les abréviations et fautes de frappe mobiles
// ══════════════════════════════════════════════════════════════════════════════

const GSM_MAP = {
    // Salutations
    'slt':'salut','slttt':'salut','bsr':'bonsoir','bjr':'bonjour','salam':'bonjour',
    'cc':'bonjour','coucou':'bonjour','yo':'bonjour',
    // Mots courants
    'kont':'compte','kont':'compte','conpte':'compte','cpte':'compte',
    'kart':'carte','krd':'crédit','cred':'crédit','predt':'crédit',
    'pb':'problème','prob':'problème','prb':'problème','pblm':'problème',
    'msg':'message','tel':'téléphone','num':'numéro','nr':'numéro',
    'virt':'virement','virmnt':'virement','viremnt':'virement',
    'ag':'agence','agnc':'agence','info':'information','infos':'information',
    'hr':'heure','hrs':'heures','h':'heure','ouv':'ouverture',
    'recl':'réclamation','reclam':'réclamation','reclamation':'réclamation',
    'plainte':'réclamation','plaint':'réclamation',
    'merci':'merci','mrc':'merci','mci':'merci','thx':'merci','tnx':'merci',
    'oui':'oui','ui':'oui','wi':'oui','oui':'oui','yes':'yes',
    'non':'non','nop':'non','nope':'non','nan':'non',
    'ok':'ok','okay':'ok','dac':'ok','daccord':'ok',
    'bcp':'beaucoup','bq':'beaucoup','bkp':'beaucoup',
    'koi':'quoi','kwa':'quoi','kc':'quoi',
    'ss':'sans','av':'avec','pr':'pour','dc':'donc','ac':'avec',
    'taf':'travail','boulo':'travail','boulot':'travail',
    'epargn':'épargne','epar':'épargne','eparge':'épargne',
    'frais':'frais','cout':'coût','prix':'prix','tarif':'tarif','trf':'tarif',
    'pret':'prêt','emprnt':'emprunt','emprt':'emprunt',
    'immob':'immobilier','immo':'immobilier','maison':'maison',
    'perso':'personnel','personel':'personnel',
    'busines':'business','bizness':'business','entrep':'entreprise',
};

/**
 * Normalise un texte : retire accents, corrige abréviations GSM,
 * nettoie ponctuation. Appliqué AVANT tokenisation ET scoring.
 */
function normalizeGSM(text) {
    let t = text.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // retire accents
        .replace(/[^\w\s]/g, ' ')   // ponctuation → espace
        .replace(/\s+/g, ' ')
        .trim();

    // Applique le dictionnaire GSM mot par mot
    t = t.split(' ').map(w => GSM_MAP[w] || w).join(' ');
    return t;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. DÉTECTION DE LANGUE — faite UNE SEULE FOIS à la création de session
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Détecte la langue sur le PREMIER message uniquement.
 * Retourne 'en' ou 'fr'.
 */
function detectLang(text) {
    const t = normalizeGSM(text);
    const enScore = (t.match(/\b(hello|hi|hey|card|cards|account|loan|branch|hours|complaint|thank|open|please|help|what|how|need|want|is|are|the|my)\b/g) || []).length;
    const frScore = (t.match(/\b(bonjour|bonsoir|salut|carte|compte|credit|pret|agence|horaire|reclamation|merci|aide|besoin|veux|comment|puis|faire|notre|mon|ma)\b/g) || []).length;
    return enScore > frScore ? 'en' : 'fr';
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. UTILITAIRES NLP
// ══════════════════════════════════════════════════════════════════════════════

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i-1] === b[j-1]
                ? dp[i-1][j-1]
                : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
        }
    }
    return dp[m][n];
}

function similarity(a, b) {
    if (!a || !b) return 0;
    return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

function stem(word) {
    const w = word.toLowerCase();
    for (const suf of ['ement','ements','tion','tions','ation','ations','eur','eurs',
        'euse','euses','ment','ments','ure','ures','age','ages','er','ir','re',
        'ais','ait','aient','ant','ants','ante','antes','ing','ed','es','s']) {
        if (w.endsWith(suf) && w.length > suf.length + 3) return w.slice(0, -suf.length);
    }
    return w;
}

const STOP_WORDS = new Set([
    'le','la','les','un','une','des','de','du','et','ou','en','au','aux',
    'je','tu','il','elle','nous','vous','ils','elles','mon','ton','son','ma',
    'ta','sa','mes','tes','ses','ce','cet','cette','ces','que','qui','quoi',
    'est','sont','suis','avoir','etre','pour','par','sur','sous','avec','sans','dans',
    'the','a','an','of','to','in','is','are','i','you','he','she','we','they','it',
    'my','your','his','her','our','their','and','or','but','for','not','with',
    'this','that','what','how','can','could','would','will','do','does','did','have','has','had',
    'ok','okay','oui','non','yes','no'
]);

function tokenize(text) {
    return normalizeGSM(text)
        .split(/\s+/)
        .filter(w => w.length > 1 && !STOP_WORDS.has(w));
}

function nlpScore(text, keywords) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;

    let totalScore = 0, matches = 0;
    for (const token of tokens) {
        const stemToken = stem(token);
        let bestMatch = 0;
        for (const kw of keywords) {
            const kwNorm = normalizeGSM(kw);
            const stemKw = stem(kwNorm);
            if (token === kwNorm)                                    { bestMatch = 1.0; break; }
            if (stemToken === stemKw && stemToken.length > 3)        { bestMatch = Math.max(bestMatch, 0.92); continue; }
            if (token.includes(kwNorm) || kwNorm.includes(token))   { bestMatch = Math.max(bestMatch, 0.85); continue; }
            const sim = similarity(token, kwNorm);
            if (sim > 0.75) bestMatch = Math.max(bestMatch, sim * 0.9);
        }
        if (bestMatch > 0.5) { totalScore += bestMatch; matches++; }
    }
    if (matches === 0) return 0;

    // Bonus couverture
    const coverageBonus = Math.min(matches / tokens.length, 1) * 0.15;
    // Bonus messages courts (1-2 tokens) : on fait plus confiance au meilleur match
    const shortBonus = tokens.length <= 2 ? 0.1 : 0;
    return Math.min(totalScore / Math.max(tokens.length, 1) + coverageBonus + shortBonus, 1);
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. COMMANDES GLOBALES — interceptées AVANT toute logique (formulaire ou NLP)
// ══════════════════════════════════════════════════════════════════════════════

const CANCEL_REGEX = /^(annuler?|stop|quitter?|cancel|quit|exit|sortir?|fin|end|0|menu|aide|help|recommencer?|restart)\s*$/i;

const MENU_MSG = {
    fr: `🏦 *Menu BSIC AI* — Que puis-je faire pour vous ?\n\n💳 *cartes* — Nos cartes bancaires\n💰 *crédits* — Prêts et financements\n🏦 *compte* — Ouvrir / gérer un compte\n🕐 *horaires* — Heures d'ouverture\n📍 *agences* — Nos agences\n📞 *contact* — Nous contacter\n📋 *réclamation* — Déposer une réclamation\n\nTapez simplement votre question !`,
    en: `🏦 *BSIC AI Menu* — How can I help you?\n\n💳 *cards* — Our bank cards\n💰 *loans* — Loans and financing\n🏦 *account* — Open / manage an account\n🕐 *hours* — Opening hours\n📍 *branches* — Our branches\n📞 *contact* — Contact us\n📋 *complaint* — File a complaint\n\nJust type your question!`
};

// ══════════════════════════════════════════════════════════════════════════════
// 5. CONTENU MÉTIER
// ══════════════════════════════════════════════════════════════════════════════

const CONTENT = {
    fr: {
        pretPerso:      "💼 *Prêt Personnel BSIC Bank*\n\nConditions :\n• Minimum 21 ans\n• Revenus stables (50 000 FCFA+/mois)\n• Bon historique de crédit\n• CNI + justificatifs de revenus\n\nTaux : 8% – 12% selon profil\nDurée : 6 mois à 5 ans\nMontant : 100 000 – 5 000 000 FCFA\n\nRéponse sous 48h.",
        pretImmo:       "🏠 *Crédit Immobilier BSIC Bank*\n\nProcédure :\n1. Pré-qualification (48h)\n2. Dépôt du dossier complet\n3. Étude (5–7 jours)\n4. Accord et déblocage\n\nGaranties :\n• Apport 20–30%\n• Hypothèque sur le bien\n• Assurance emprunteur\n\nTaux : 6% – 9% fixe\nDurée : 5 à 25 ans",
        pretConso:      "🛒 *Crédit Consommation BSIC Bank*\n\n• Montant : 50 000 – 2 000 000 FCFA\n• Sans justificatif d'utilisation\n• Durée : 3 mois à 4 ans\n• Mensualités fixes\n• Remboursement anticipé possible\n\nTaux : 9% – 15%\nRéponse sous 24h",
        pretBusiness:   "🏢 *Crédit Business BSIC Bank*\n\n• Solutions sur mesure pour PME\n• Financement équipements & fonds de roulement\n• Taux préférentiels avec domiciliation\n\nContact service entreprises :\n📞 20-25-30-40 poste 2",
        horaires:       "🕐 *Horaires BSIC Bank*\n\n• Lundi – Vendredi : 8h00 – 16h30\n• Samedi : 8h00 – 12h00\n• Dimanche & jours fériés : Fermé",
        agences:        "📍 *Agences BSIC Bank*\n\n• Siège : Plateau, Avenue Botreau Roussel\n• Cocody : Marché de Cocody, rue des Jardins\n• Yopougon : Carrefour SIDECI\n• Abobo : Gare routière principale\n• Marcory : Zone 4, boulevard Valéry Giscard",
        contact:        "📞 *Contact BSIC Bank*\n\n• Standard : 20-25-30-40\n• Email : contact@bsicbank.ci\n• Urgence 24h/7j : 80-80-80-80\n• WhatsApp : +225 07 00 00 00",
        compteCourant:  "💼 *Compte Courant BSIC*\n\n• Frais de tenue : 0 FCFA/an\n• Carte Visa incluse\n• Virements & paiements illimités\n• Banque en ligne 24h/7j\n\nDocuments :\n• CNI valide\n• Justificatif de domicile\n• Photo d'identité",
        compteEpargne:  "🏦 *Compte Épargne BSIC*\n\n• Taux : 3.5% annuel\n• Dépôt minimum : 10 000 FCFA\n• Intérêts versés chaque semestre\n• Retraits limités à 4/mois\n• Capital garanti à 100%",
        compteBusiness: "🏢 *Compte Business BSIC*\n\n• Pour entrepreneurs & PME\n• Virements multiples simplifiés\n• Gestion de trésorerie avancée\n• Conseiller dédié\n\n📞 20-25-30-40 poste 2",
        ouvertureCompte:"🎉 *Ouvrir un compte BSIC*\n\nRendez-vous en agence avec :\n• CNI valide\n• Justificatif de domicile (– de 3 mois)\n• Photo d'identité (format passeport)\n• Dépôt initial selon le type de compte\n\nOuverture en moins de 30 minutes !",
        carteIntro:     "💳 *Cartes bancaires BSIC*\n\n💳 Visa Classique — 5 000 FCFA/an\n   Paiements et retraits mondiaux\n⭐ Visa Gold — 10 000 FCFA/an\n   Limites élevées + assurance voyage\n👑 Visa Platinum — 25 000 FCFA/an\n   Services premium + conciergerie\n🌐 Carte Virtuelle — Gratuite\n   Achats en ligne sécurisés",
        error:          "🤔 Je n'ai pas bien compris. Reformulez ou tapez *menu* pour voir les options.\n\nExemples :\n• \"infos sur les cartes\"\n• \"comment ouvrir un compte\"\n• \"horaires agence\"",
        botHello:       "👋 *Bonjour et bienvenue chez BSIC Bank !*\n\nJe suis votre assistant intelligent. Posez-moi n'importe quelle question sur nos services.\n\nTapez *menu* pour voir toutes les options.",
        merci:          "😊 Avec plaisir ! N'hésitez pas si vous avez d'autres questions.\n\nTapez *menu* pour revoir les options.",
        creditsMenu:    "💰 *Quel type de crédit vous intéresse ?*\n\n1. 👤 Prêt Personnel (100K – 5M FCFA)\n2. 🏠 Crédit Immobilier (5 – 25 ans)\n3. 🛒 Crédit Conso (50K – 2M FCFA)\n4. 🏢 Crédit Business (Sur mesure)\n\nRépondez avec le numéro ou le nom.",
        comptesMenu:    "🏦 *Quel type de compte vous intéresse ?*\n\n1. 💼 Compte Courant (Gratuit)\n2. 🏦 Compte Épargne (3.5% d'intérêts)\n3. 🏢 Compte Business (Sur mesure)\n\nRépondez avec le numéro ou le nom.",
        sessionExpired: "⚠️ Notre session a expiré. Pas de souci, je suis de nouveau disponible !\n\nComment puis-je vous aider ? (tapez *menu* pour les options)",
    },
    en: {
        pretPerso:      "💼 *BSIC Bank Personal Loan*\n\nRequirements:\n• Minimum 21 years old\n• Stable income (50,000 FCFA+/month)\n• Good credit history\n• ID + proof of income\n\nRate: 8% – 12%\nDuration: 6 months to 5 years\nAmount: 100,000 – 5,000,000 FCFA\n\nResponse within 48h.",
        pretImmo:       "🏠 *BSIC Bank Mortgage Loan*\n\nProcedure:\n1. Pre-qualification (48h)\n2. File submission\n3. Review (5–7 days)\n4. Approval & funds release\n\nRequirements:\n• 20–30% down payment\n• Property mortgage\n• Borrower insurance\n\nRate: 6% – 9% fixed\nDuration: 5 to 25 years",
        pretConso:      "🛒 *BSIC Bank Consumer Loan*\n\n• Amount: 50,000 – 2,000,000 FCFA\n• No proof of use required\n• Duration: 3 months to 4 years\n• Fixed monthly payments\n• Early repayment available\n\nRate: 9% – 15%\nResponse within 24h",
        pretBusiness:   "🏢 *BSIC Bank Business Loan*\n\n• Tailored solutions for SMEs\n• Equipment & working capital financing\n• Preferential rates with domiciliation\n\n📞 Business team: 20-25-30-40 ext. 2",
        horaires:       "🕐 *BSIC Bank Opening Hours*\n\n• Monday – Friday: 8:00am – 4:30pm\n• Saturday: 8:00am – 12:00pm\n• Sunday & public holidays: Closed",
        agences:        "📍 *BSIC Bank Branches*\n\n• HQ: Plateau, Avenue Botreau Roussel\n• Cocody: Cocody Market, Rue des Jardins\n• Yopougon: SIDECI Crossroads\n• Abobo: Main Bus Terminal\n• Marcory: Zone 4, Bd Valéry Giscard",
        contact:        "📞 *BSIC Bank Contact*\n\n• Phone: 20-25-30-40\n• Email: contact@bsicbank.ci\n• Emergency 24/7: 80-80-80-80\n• WhatsApp: +225 07 00 00 00",
        compteCourant:  "💼 *BSIC Current Account*\n\n• No maintenance fees\n• Visa card included\n• Unlimited transfers & payments\n• Online banking 24/7\n\nDocuments:\n• Valid ID\n• Proof of address\n• Recent photo",
        compteEpargne:  "🏦 *BSIC Savings Account*\n\n• Rate: 3.5% annual\n• Minimum deposit: 10,000 FCFA\n• Interest paid every 6 months\n• Max 4 withdrawals/month\n• 100% guaranteed capital",
        compteBusiness: "🏢 *BSIC Business Account*\n\n• For entrepreneurs & SMEs\n• Simplified bulk transfers\n• Advanced cash management\n• Dedicated advisor\n\n📞 20-25-30-40 ext. 2",
        ouvertureCompte:"🎉 *Open a BSIC Account*\n\nVisit a branch with:\n• Valid ID\n• Proof of address (under 3 months)\n• Passport-size photo\n• Initial deposit\n\nDone in less than 30 minutes!",
        carteIntro:     "💳 *BSIC Bank Cards*\n\n💳 Visa Classic — 5,000 FCFA/year\n   Global payments & withdrawals\n⭐ Visa Gold — 10,000 FCFA/year\n   Higher limits + travel insurance\n👑 Visa Platinum — 25,000 FCFA/year\n   Premium services + concierge\n🌐 Virtual Card — Free\n   Secure online purchases",
        error:          "🤔 I didn't quite understand. Please rephrase or type *menu* to see options.\n\nExamples:\n• \"info about cards\"\n• \"how to open an account\"\n• \"branch hours\"",
        botHello:       "👋 *Hello and welcome to BSIC Bank!*\n\nI'm your intelligent assistant. Ask me anything about our services.\n\nType *menu* to see all options.",
        merci:          "😊 You're welcome! Feel free to ask if you have other questions.\n\nType *menu* to see options.",
        creditsMenu:    "💰 *Which type of loan interests you?*\n\n1. 👤 Personal Loan (100K – 5M FCFA)\n2. 🏠 Mortgage Loan (5 – 25 years)\n3. 🛒 Consumer Loan (50K – 2M FCFA)\n4. 🏢 Business Loan (Custom)\n\nReply with the number or name.",
        comptesMenu:    "🏦 *Which type of account interests you?*\n\n1. 💼 Current Account (Free)\n2. 🏦 Savings Account (3.5% interest)\n3. 🏢 Business Account (Custom)\n\nReply with the number or name.",
        sessionExpired: "⚠️ Our session expired. No worries, I'm back online!\n\nHow can I help you? (type *menu* for options)",
    }
};

// ══════════════════════════════════════════════════════════════════════════════
// 6. FORMULAIRE RÉCLAMATION CONVERSATIONNEL — 6 étapes avec validation
// ══════════════════════════════════════════════════════════════════════════════

const COMPLAINT_STEPS = {
    fr: {
        TYPE:    "📋 *Formulaire de réclamation BSIC*\n\nQuelle est la nature de votre demande ?\n\n1. Plainte\n2. Réclamation\n3. Erreur de virement\n4. Autre demande\n\nRépondez avec le numéro ou le texte.\n_(Tapez *stop* à tout moment pour annuler)_",
        DESC:    "✏️ *Décrivez brièvement la situation :*\n_(minimum 10 caractères)_",
        NAME:    "👤 *Votre nom et prénom ?*",
        RIB:     "🔢 *Numéro de compte ou ID client ?*",
        CONTACT: "📞 *Votre email ou numéro de téléphone ?*",
        CONFIRM: (d) =>
`📋 *Récapitulatif de votre réclamation :*

• Type : ${d.type}
• Nom : ${d.name}
• Compte : ${d.rib}
• Contact : ${d.contact}
• Description : ${d.desc}

Tapez *OUI* pour confirmer et envoyer, ou *NON* pour annuler.`,
        DONE: (id) =>
`✅ *Réclamation enregistrée avec succès !*

Numéro de ticket : *${id}*

Vous serez contacté(e) sous 48h. Merci de votre confiance. 🙏`,
        CANCEL:        "❌ Réclamation annulée. Comment puis-je vous aider ?\n\nTapez *menu* pour les options.",
        ERR_DESC_SHORT:"⚠️ Description trop courte. Merci de décrire la situation en quelques mots (min. 10 caractères) :",
        ERR_CONTACT:   "⚠️ Format non reconnu. Merci de saisir un email (ex: nom@mail.com) ou un numéro de téléphone :",
        ERR_NAME:      "⚠️ Merci d'indiquer votre nom complet (prénom et nom) :",
        TYPE_MAP:      { '1':'Plainte', '2':'Réclamation', '3':'Erreur de virement', '4':'Autre demande' }
    },
    en: {
        TYPE:    "📋 *BSIC Complaint Form*\n\nWhat is the nature of your request?\n\n1. Complaint\n2. Claim\n3. Transfer Error\n4. Other request\n\nReply with the number or text.\n_(Type *stop* at any time to cancel)_",
        DESC:    "✏️ *Briefly describe the situation:*\n_(minimum 10 characters)_",
        NAME:    "👤 *Your full name?*",
        RIB:     "🔢 *Account number or client ID?*",
        CONTACT: "📞 *Your email or phone number?*",
        CONFIRM: (d) =>
`📋 *Complaint Summary:*

• Type: ${d.type}
• Name: ${d.name}
• Account: ${d.rib}
• Contact: ${d.contact}
• Description: ${d.desc}

Type *YES* to confirm and send, or *NO* to cancel.`,
        DONE: (id) =>
`✅ *Complaint successfully registered!*

Ticket number: *${id}*

You will be contacted within 48h. Thank you! 🙏`,
        CANCEL:        "❌ Complaint cancelled. How can I help you?\n\nType *menu* for options.",
        ERR_DESC_SHORT:"⚠️ Description too short. Please describe the situation (min. 10 characters):",
        ERR_CONTACT:   "⚠️ Format not recognized. Please enter an email (e.g. name@mail.com) or phone number:",
        ERR_NAME:      "⚠️ Please provide your full name (first and last name):",
        TYPE_MAP:      { '1':'Complaint', '2':'Claim', '3':'Transfer Error', '4':'Other request' }
    }
};

/** Valide un email ou numéro de téléphone */
function isValidContact(val) {
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const phoneRe = /^[+\d][\d\s\-().]{5,}$/;
    return emailRe.test(val) || phoneRe.test(val);
}

/** Valide un nom (au moins 2 mots ou 5 caractères) */
function isValidName(val) {
    return val.trim().length >= 3;
}

/**
 * Avance d'une étape dans le formulaire réclamation.
 * Modifie session.complaint en place.
 */
function processComplaintStep(userText, session) {
    const lang = session.language || 'fr';
    const S    = COMPLAINT_STEPS[lang];
    const c    = session.complaint;
    const val  = userText.trim();

    switch (c.step) {

        case 'TYPE': {
            const mapped = S.TYPE_MAP[val] || val;
            c.data.type = mapped;
            c.step = 'DESC';
            return { message: S.DESC };
        }

        case 'DESC': {
            // Validation : minimum 10 caractères
            if (val.length < 10) return { message: S.ERR_DESC_SHORT };
            c.data.desc = val;
            c.step = 'NAME';
            return { message: S.NAME };
        }

        case 'NAME': {
            if (!isValidName(val)) return { message: S.ERR_NAME };
            c.data.name = val;
            c.step = 'RIB';
            return { message: S.RIB };
        }

        case 'RIB': {
            // Accepte tout (numéro de compte libre)
            c.data.rib = val;
            c.step = 'CONTACT';
            return { message: S.CONTACT };
        }

        case 'CONTACT': {
            if (!isValidContact(val)) return { message: S.ERR_CONTACT };
            c.data.contact = val;
            c.step = 'CONFIRM';
            return { message: S.CONFIRM(c.data) };
        }

        case 'CONFIRM': {
            const yes = /^(oui|yes|o\b|y\b|1|ok|confirm|envoyer?|send)/i.test(val);
            const no  = /^(non|no|n\b|0|annul|cancel|stop)/i.test(val);
            if (yes) {
                const ticketId    = 'TCK-' + Math.floor(10000 + Math.random() * 90000);
                const complaintData = { ...c.data, ticketId, lang, ts: Date.now() };
                session.complaint = null;
                return { message: S.DONE(ticketId), done: true, complaintData };
            }
            if (no) {
                session.complaint = null;
                return { message: S.CANCEL, cancelled: true };
            }
            // Réponse ambiguë → relancer
            return { message: S.CONFIRM(c.data) };
        }

        default:
            session.complaint = null;
            return { message: CONTENT[lang].error };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// 7. RÉSOLUTION DES MENUS NUMÉRIQUES (crédits / comptes)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Quand le dernier message du bot était un menu numéroté (crédits/comptes),
 * l'utilisateur peut répondre "1", "2", "3" → on résout directement.
 */
function resolveNumericMenu(val, lastIntent, lang) {
    const n = val.trim();
    if (lastIntent === 'credits') {
        const map = { '1':'pretPerso', '2':'pretImmo', '3':'pretConso', '4':'pretBusiness' };
        if (map[n]) return { message: CONTENT[lang][map[n]], type: 'text', intent: 'credits', confidence: 1, suggestions: [] };
    }
    if (lastIntent === 'comptes') {
        const map = { '1':'compteCourant', '2':'compteEpargne', '3':'compteBusiness' };
        if (map[n]) return { message: CONTENT[lang][map[n]], type: 'text', intent: 'comptes', confidence: 1, suggestions: [] };
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 8. INTENTIONS
// ══════════════════════════════════════════════════════════════════════════════

const INTENT_DEFS = [
    {
        id: 'cartes',
        keywords: ['carte','cartes','card','cards','visa','mastercard','bancaire','paiement','retrait','debit','credit card','kart'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].carteIntro, type: 'cartes' })
    },
    {
        id: 'credits',
        keywords: ['credit','crédit','pret','prêt','emprunt','emprunter','loan','financement','remboursement','mensualite','taux','interet','borrow','emprt'],
        resolve: (text, lang) => {
            const t = normalizeGSM(text);
            if (/personnel|personal|perso/.test(t))              return { message: CONTENT[lang].pretPerso, type: 'text' };
            if (/immob|maison|logement|mortgage|terrain/.test(t)) return { message: CONTENT[lang].pretImmo, type: 'text' };
            if (/consomm|consumer|auto|voiture|car|moto/.test(t)) return { message: CONTENT[lang].pretConso, type: 'text' };
            if (/business|entreprise|societe|pme|commerce/.test(t)) return { message: CONTENT[lang].pretBusiness, type: 'text' };
            return { message: CONTENT[lang].creditsMenu, type: 'tree',
                treeData: { types: lang === 'fr'
                    ? [{ icon:'👤', key:'pretPerso', label:'Prêt Personnel', sub:'100K – 5M FCFA' },
                       { icon:'🏠', key:'pretImmo', label:'Crédit Immobilier', sub:'5 – 25 ans' },
                       { icon:'🛒', key:'pretConso', label:'Crédit Conso', sub:'50K – 2M FCFA' },
                       { icon:'🏢', key:'pretBusiness', label:'Crédit Business', sub:'Sur mesure' }]
                    : [{ icon:'👤', key:'pretPerso', label:'Personal Loan', sub:'100K – 5M FCFA' },
                       { icon:'🏠', key:'pretImmo', label:'Mortgage Loan', sub:'5 – 25 years' },
                       { icon:'🛒', key:'pretConso', label:'Consumer Loan', sub:'50K – 2M FCFA' },
                       { icon:'🏢', key:'pretBusiness', label:'Business Loan', sub:'Custom' }]
                }
            };
        }
    },
    {
        id: 'comptes',
        keywords: ['compte','comptes','account','ouvrir','ouverture','creer','epargne','courant','savings','depot','kont','cpte'],
        resolve: (text, lang) => {
            const t = normalizeGSM(text);
            if (/courant|current|quotidien/.test(t))       return { message: CONTENT[lang].compteCourant, type: 'text' };
            if (/epargn|savings/.test(t))                  return { message: CONTENT[lang].compteEpargne, type: 'text' };
            if (/business|entreprise|societe|pme/.test(t)) return { message: CONTENT[lang].compteBusiness, type: 'text' };
            if (/ouvrir|ouverture|creer|new|nouveau|open/.test(t)) return { message: CONTENT[lang].ouvertureCompte, type: 'text' };
            return { message: CONTENT[lang].comptesMenu, type: 'tree',
                treeData: { types: lang === 'fr'
                    ? [{ icon:'💼', key:'compteCourant', label:'Compte Courant', sub:'Gratuit' },
                       { icon:'🏦', key:'compteEpargne', label:'Compte Épargne', sub:"3.5% d'intérêts" },
                       { icon:'🏢', key:'compteBusiness', label:'Compte Business', sub:'Sur mesure' }]
                    : [{ icon:'💼', key:'compteCourant', label:'Current Account', sub:'Free' },
                       { icon:'🏦', key:'compteEpargne', label:'Savings Account', sub:'3.5% interest' },
                       { icon:'🏢', key:'compteBusiness', label:'Business Account', sub:'Custom' }]
                }
            };
        }
    },
    {
        id: 'horaires',
        keywords: ['horaire','heure','hour','ouverture','ouvert','ferme','fermeture','schedule','quand','when','open','hr'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].horaires, type: 'text' })
    },
    {
        id: 'agences',
        keywords: ['agence','branch','bureau','adresse','address','localisation','location','trouver','nearest','proche','ag'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].agences, type: 'text' })
    },
    {
        id: 'contact',
        keywords: ['contact','telephone','phone','email','mail','appeler','call','joindre','numero','whatsapp','urgence','tel','num'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].contact, type: 'text' })
    },
    {
        id: 'reclamation',
        keywords: ['reclamation','complaint','plainte','probleme','litige','erreur','error','virement','fraude','opposition','vol','perdu','bloque','reclam','plaint','pb','prob'],
        resolve: null // géré spécialement dans resolve()
    },
    {
        id: 'salutation',
        keywords: ['bonjour','bonsoir','salut','hello','hi','hey','salam','bjr','bsr','good morning','good evening','slt','cc'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].botHello, type: 'text' })
    },
    {
        id: 'remerciement',
        keywords: ['merci','thanks','thank','appreciate','parfait','super','excellent','genial','bravo','nickel','mrc','mci','thx'],
        resolve: (_t, lang) => ({ message: CONTENT[lang].merci, type: 'text' })
    },
    {
        id: 'menu',
        keywords: ['menu','aide','help','options','liste','services','quoi','proposer','faire'],
        resolve: (_t, lang) => ({ message: MENU_MSG[lang], type: 'text' })
    }
];

// ══════════════════════════════════════════════════════════════════════════════
// 9. RÉSOLUTION PRINCIPALE
// ══════════════════════════════════════════════════════════════════════════════

const THRESHOLD = 0.15; // légèrement abaissé car normalisation GSM améliore la qualité

const FOLLOW_UP_WORDS = new Set(['et','aussi','plus','encore','autre','quel','quels','quelle','combien',
    'comment','and','also','more','other','what','how','much','many','price','tarif','cout','frais']);

function isFollowUp(text) {
    const tokens = tokenize(text);
    return tokens.length <= 2 || tokens.some(t => FOLLOW_UP_WORDS.has(t));
}

/**
 * Point d'entrée principal.
 *
 * @param {string} message    Message brut de l'utilisateur
 * @param {string} lang       'fr' | 'en'  (ignoré si session fournie — on utilise session.language)
 * @param {Array}  history    [{role, text, intent, ts}]
 * @param {object} session    Objet session complet (lit/écrit session.complaint et session.language)
 * @returns {object}          { message, intent, confidence, type, suggestions, complaintData? }
 */
function resolve(message, lang = 'fr', history = [], session = null) {
    const text     = (message || '').trim();
    const sessLang = session?.language || lang;

    // ── Message vide ────────────────────────────────────────────────────────
    if (!text) {
        return { message: CONTENT[sessLang].error, intent: null, confidence: 0, suggestions: [], type: 'text' };
    }

    // ── PRIORITÉ 0 : commandes globales (stop / menu / aide) ────────────────
    // Interceptées même pendant le formulaire réclamation
    if (CANCEL_REGEX.test(text.trim())) {
        if (session && session.complaint) {
            session.complaint = null;
            const S = COMPLAINT_STEPS[sessLang];
            return { message: S.CANCEL, intent: null, confidence: 1, type: 'text', suggestions: [] };
        }
        return { message: MENU_MSG[sessLang], intent: 'menu', confidence: 1, type: 'text', suggestions: [] };
    }

    // ── PRIORITÉ 1 : formulaire réclamation en cours ─────────────────────────
    if (session && session.complaint) {
        const step = processComplaintStep(text, session);
        return {
            message:       step.message,
            intent:        'reclamation',
            confidence:    1,
            type:          step.done ? 'complaint_done' : 'complaint_step',
            suggestions:   [],
            complaintData: step.complaintData || null
        };
    }

    // ── PRIORITÉ 2 : réponse numérique à un menu précédent ──────────────────
    if (/^[1-4]$/.test(text.trim()) && history.length > 0) {
        const lastBotIntent = [...history].reverse().find(h => h.role === 'bot' && h.intent);
        if (lastBotIntent) {
            const numeric = resolveNumericMenu(text, lastBotIntent.intent, sessLang);
            if (numeric) return numeric;
        }
    }

    // ── PRIORITÉ 3 : NLP normal ───────────────────────────────────────────────
    const scores = INTENT_DEFS.map(def => ({
        def,
        score: nlpScore(text, def.keywords)
    })).sort((a, b) => b.score - a.score);

    const best       = scores[0];
    const secondBest = scores[1];

    // Score trop faible → résolution contextuelle ou erreur
    if (best.score < THRESHOLD) {
        // Essai contextuel : follow-up sur le dernier sujet
        const lastBotIntent = [...history].reverse().find(h => h.role === 'bot' && h.intent);
        if (lastBotIntent && isFollowUp(text)) {
            const ctxDef = INTENT_DEFS.find(d => d.id === lastBotIntent.intent && d.resolve);
            if (ctxDef) {
                const resolved = ctxDef.resolve(text, sessLang);
                return { ...resolved, intent: ctxDef.id, confidence: 0.6, suggestions: [], isContextual: true };
            }
        }
        const suggestions = scores.filter(s => s.score > 0.06 && s.score < THRESHOLD).slice(0, 3).map(s => s.def.id);
        return { message: CONTENT[sessLang].error, intent: null, confidence: best.score, suggestions, type: 'text' };
    }

    // Démarrer le formulaire réclamation
    if (best.def.id === 'reclamation') {
        if (session) session.complaint = { step: 'TYPE', data: {} };
        return {
            message:     COMPLAINT_STEPS[sessLang].TYPE,
            intent:      'reclamation',
            confidence:  best.score,
            type:        'complaint_step',
            suggestions: []
        };
    }

    const resolved   = best.def.resolve(text, sessLang);
    const suggestions = [];
    if (secondBest && (best.score - secondBest.score) < 0.12 && secondBest.score > THRESHOLD * 0.7) {
        suggestions.push(secondBest.def.id);
    }

    return { ...resolved, intent: best.def.id, confidence: best.score, suggestions };
}

module.exports = { resolve, detectLang, MENU_MSG };

// ══════════════════════════════════════════════════════════════════════════════
// EXPORT ADDITIONNEL — seuils exposés pour server.js
// ══════════════════════════════════════════════════════════════════════════════
const SCORE_HIGH   = 0.40; // NLP local direct, pas besoin de Claude
const SCORE_LOW    = 0.15; // En dessous : Claude obligatoire

module.exports.SCORE_HIGH = SCORE_HIGH;
module.exports.SCORE_LOW  = SCORE_LOW;
