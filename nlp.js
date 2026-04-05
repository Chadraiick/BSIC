/**
 * nlp.js — Moteur NLP serveur BSIC AI
 *
 * Reprend la même logique que le frontend (Levenshtein + stemming + scoring)
 * et centralise tout le contenu métier.  Le frontend n'est plus qu'un
 * affichage : toute l'intelligence vient d'ici.
 */

'use strict';

// ─── Utilitaires NLP ──────────────────────────────────────────────────────────

function levenshtein(a, b) {
    const m = a.length, n = b.length;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) {
        for (let j = 1; j <= n; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[m][n];
}

function similarity(a, b) {
    if (!a || !b) return 0;
    const dist = levenshtein(a.toLowerCase(), b.toLowerCase());
    return 1 - dist / Math.max(a.length, b.length);
}

function stem(word) {
    const w = word.toLowerCase();
    const suffixes = [
        'ement', 'ements', 'tion', 'tions', 'ation', 'ations',
        'eur', 'eurs', 'euse', 'euses', 'eux', 'elle', 'elles',
        'ment', 'ments', 'ure', 'ures', 'age', 'ages',
        'er', 'ir', 're', 'oir', 'oire',
        'ais', 'ait', 'aient', 'ions', 'iez',
        'ant', 'ants', 'ante', 'antes',
        'ing', 'tion', 'ed', 'es', 's'
    ];
    for (const suf of suffixes) {
        if (w.endsWith(suf) && w.length > suf.length + 3) {
            return w.slice(0, -suf.length);
        }
    }
    return w;
}

const STOP_WORDS = new Set([
    'le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'ou', 'en', 'à', 'au', 'aux',
    'je', 'tu', 'il', 'elle', 'nous', 'vous', 'ils', 'elles', 'mon', 'ton', 'son', 'ma',
    'ta', 'sa', 'mes', 'tes', 'ses', 'ce', 'cet', 'cette', 'ces', 'que', 'qui', 'quoi',
    'est', 'sont', 'suis', 'etes', 'avoir', 'etre', 'pour', 'par', 'sur', 'sous',
    'avec', 'sans', 'dans', 'the', 'a', 'an', 'of', 'to', 'in', 'is', 'are', 'i', 'you',
    'he', 'she', 'we', 'they', 'it', 'my', 'your', 'his', 'her', 'our', 'their', 'and',
    'or', 'but', 'for', 'not', 'with', 'this', 'that', 'what', 'how', 'can', 'could',
    'would', 'will', 'do', 'does', 'did', 'have', 'has', 'had'
]);

function tokenize(text) {
    return text
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function nlpScore(text, keywords) {
    const tokens = tokenize(text);
    if (tokens.length === 0) return 0;

    let totalScore = 0;
    let matches = 0;

    for (const token of tokens) {
        const stemToken = stem(token);
        let bestMatch = 0;

        for (const kw of keywords) {
            const kwNorm = kw.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
            const stemKw = stem(kwNorm);

            if (token === kwNorm) { bestMatch = 1.0; break; }
            if (stemToken === stemKw && stemToken.length > 3) { bestMatch = Math.max(bestMatch, 0.92); continue; }
            if (token.includes(kwNorm) || kwNorm.includes(token)) { bestMatch = Math.max(bestMatch, 0.85); continue; }

            const sim = similarity(token, kwNorm);
            if (sim > 0.75) bestMatch = Math.max(bestMatch, sim * 0.9);
        }

        if (bestMatch > 0.5) {
            totalScore += bestMatch;
            matches++;
        }
    }

    if (matches === 0) return 0;
    const coverageBonus = Math.min(matches / tokens.length, 1) * 0.15;
    return Math.min(totalScore / Math.max(tokens.length, 1) + coverageBonus, 1);
}

// ─── Contenu métier ───────────────────────────────────────────────────────────

const CONTENT = {
    fr: {
        pretPerso:      "Prêt Personnel BSIC Bank :\n\nConditions :\n• Minimum 21 ans\n• Revenus stables (50 000 FCFA+/mois)\n• Bon historique de crédit\n• CNI + justificatifs de revenus\n\nTaux : 8% – 12% selon profil\nDurée : 6 mois à 5 ans\nMontant : 100 000 – 5 000 000 FCFA\n\nRéponse sous 48h.",
        pretImmo:       "Crédit Immobilier BSIC Bank :\n\nProcédure :\n1. Pré-qualification (48h)\n2. Dépôt du dossier complet\n3. Étude du dossier (5–7 jours)\n4. Accord et déblocage des fonds\n\nGaranties requises :\n• Apport personnel 20–30%\n• Hypothèque sur le bien\n• Assurance emprunteur obligatoire\n\nTaux : 6% – 9% fixe\nDurée : 5 à 25 ans",
        pretConso:      "Crédit Consommation BSIC Bank :\n\n• Montant : 50 000 – 2 000 000 FCFA\n• Sans justificatif d'utilisation\n• Durée : 3 mois à 4 ans\n• Mensualités fixes\n• Remboursement anticipé possible\n\nTaux : 9% – 15%\nRéponse sous 24h",
        pretBusiness:   "Crédit Business BSIC Bank :\n\n• Solutions sur mesure pour PME\n• Financement équipements, fonds de roulement\n• Montant selon dossier\n• Taux préférentiels avec domiciliation\n\nContactez notre service entreprises :\n📞 20-25-30-40 poste 2",
        horaires:       "Horaires d'ouverture BSIC Bank :\n\n• Lundi – Vendredi : 8h00 – 16h30\n• Samedi : 8h00 – 12h00\n• Dimanche et jours fériés : Fermé",
        agences:        "Nos agences BSIC Bank :\n\n📍 Siège : Plateau, Avenue Botreau Roussel\n📍 Cocody : Marché de Cocody, rue des Jardins\n📍 Yopougon : Carrefour SIDECI\n📍 Abobo : Gare routière principale\n📍 Marcory : Zone 4, boulevard Valéry Giscard",
        contact:        "Contact BSIC Bank :\n\n📞 Standard : 20-25-30-40\n📧 Email : contact@bsicbank.ci\n🆘 Urgence 24h/7j : 80-80-80-80\n💬 WhatsApp : +225 07 00 00 00",
        compteCourant:  "Compte Courant BSIC :\n\n• Frais de tenue : 0 FCFA/an\n• Carte Visa incluse\n• Virement & paiements illimités\n• Accès banque en ligne 24h/7j\n\nDocuments requis :\n• CNI valide\n• Justificatif de domicile\n• Photo d'identité récente",
        compteEpargne:  "Compte Épargne BSIC :\n\n• Taux d'intérêt : 3.5% annuel\n• Dépôt minimum : 10 000 FCFA\n• Intérêts versés chaque semestre\n• Retraits limités à 4 par mois\n• Capital garanti à 100%",
        compteBusiness: "Compte Business BSIC :\n\n• Dédié aux entrepreneurs & PME\n• Virements multiples simplifiés\n• Gestion de trésorerie avancée\n• Conseiller dédié\n• Conditions sur devis\n\n📞 Service entreprises : 20-25-30-40 poste 2",
        ouvertureCompte:"Pour ouvrir un compte, rendez-vous en agence avec :\n• CNI valide (Carte Nationale d'Identité)\n• Justificatif de domicile (– de 3 mois)\n• Photo d'identité récente (format passeport)\n• Dépôt initial selon le type de compte\n\nOuverture en moins de 30 minutes ! 🎉",
        carteIntro:     "Nos cartes bancaires BSIC :\n\n💳 Visa Classique — 5 000 FCFA/an\n   Paiements et retraits mondiaux\n⭐ Visa Gold — 10 000 FCFA/an\n   Limites élevées + assurance voyage\n👑 Visa Platinum — 25 000 FCFA/an\n   Services premium + conciergerie\n🌐 Carte Virtuelle — Gratuite\n   Achats en ligne sécurisés",
        error:          "Je n'ai pas bien compris votre demande. Pourriez-vous reformuler ?\n\nJe peux vous aider sur : cartes, crédits, comptes, horaires, agences, contact ou réclamations.",
        botHello:       "Bonjour 👋 Bienvenue chez BSIC Bank ! Je suis votre assistant intelligent.\n\nJe comprends le langage naturel — posez-moi n'importe quelle question sur nos services.",
        merci:          "Avec plaisir ! N'hésitez pas si vous avez d'autres questions. 😊",
        creditsMenu:    "Quel type de crédit vous intéresse ?",
        comptesMenu:    "Quel type de compte vous intéresse ?",
        complaintStart: "Je vais enregistrer votre réclamation. Veuillez continuer via le formulaire dans l'interface.",
    },
    en: {
        pretPerso:      "BSIC Bank Personal Loan:\n\nRequirements:\n• Minimum 21 years old\n• Stable income (50,000 FCFA+/month)\n• Good credit history\n• ID + proof of income\n\nRate: 8% – 12% depending on profile\nDuration: 6 months to 5 years\nAmount: 100,000 – 5,000,000 FCFA\n\nResponse within 48h.",
        pretImmo:       "BSIC Bank Mortgage Loan:\n\nProcedure:\n1. Pre-qualification (48h)\n2. Complete file submission\n3. File review (5–7 days)\n4. Approval and fund release\n\nRequired guarantees:\n• Personal contribution 20–30%\n• Property mortgage\n• Mandatory borrower insurance\n\nRate: 6% – 9% fixed\nDuration: 5 to 25 years",
        pretConso:      "BSIC Bank Consumer Loan:\n\n• Amount: 50,000 – 2,000,000 FCFA\n• No proof of use required\n• Duration: 3 months to 4 years\n• Fixed monthly payments\n• Early repayment available\n\nRate: 9% – 15%\nResponse within 24h",
        pretBusiness:   "BSIC Bank Business Loan:\n\n• Tailored solutions for SMEs\n• Equipment & working capital financing\n• Amount based on your file\n• Preferential rates with account domiciliation\n\nContact our business team:\n📞 20-25-30-40 ext. 2",
        horaires:       "BSIC Bank Opening Hours:\n\n• Monday – Friday: 8:00am – 4:30pm\n• Saturday: 8:00am – 12:00pm\n• Sunday and public holidays: Closed",
        agences:        "Our BSIC Bank Branches:\n\n📍 HQ: Plateau, Avenue Botreau Roussel\n📍 Cocody: Cocody Market, Rue des Jardins\n📍 Yopougon: SIDECI Crossroads\n📍 Abobo: Main Bus Terminal\n📍 Marcory: Zone 4, Bd Valéry Giscard",
        contact:        "BSIC Bank Contact:\n\n📞 Phone: 20-25-30-40\n📧 Email: contact@bsicbank.ci\n🆘 Emergency 24/7: 80-80-80-80\n💬 WhatsApp: +225 07 00 00 00",
        compteCourant:  "BSIC Current Account:\n\n• Maintenance fees: 0 FCFA/year\n• Visa card included\n• Unlimited transfers & payments\n• Online banking 24/7\n\nRequired documents:\n• Valid ID\n• Proof of address\n• Recent ID photo",
        compteEpargne:  "BSIC Savings Account:\n\n• Interest rate: 3.5% annual\n• Minimum deposit: 10,000 FCFA\n• Interest paid every 6 months\n• Maximum 4 withdrawals/month\n• 100% guaranteed capital",
        compteBusiness: "BSIC Business Account:\n\n• For entrepreneurs & SMEs\n• Simplified bulk transfers\n• Advanced cash management\n• Dedicated advisor\n• Custom conditions\n\n📞 Business team: 20-25-30-40 ext. 2",
        ouvertureCompte:"To open an account, visit a branch with:\n• Valid ID card\n• Proof of address (less than 3 months old)\n• Recent passport-size photo\n• Initial deposit depending on account type\n\nOpening in less than 30 minutes! 🎉",
        carteIntro:     "Our BSIC bank cards:\n\n💳 Visa Classic — 5,000 FCFA/year\n   Global payments and withdrawals\n⭐ Visa Gold — 10,000 FCFA/year\n   Higher limits + travel insurance\n👑 Visa Platinum — 25,000 FCFA/year\n   Premium services + concierge\n🌐 Virtual Card — Free\n   Secure online purchases",
        error:          "I didn't quite understand your request. Could you rephrase?\n\nI can help with: cards, loans, accounts, hours, branches, contact or complaints.",
        botHello:       "Hello 👋 Welcome to BSIC Bank! I'm your intelligent assistant.\n\nI understand natural language — ask me anything about our services.",
        merci:          "You're welcome! Feel free to ask if you have other questions. 😊",
        creditsMenu:    "Which type of loan interests you?",
        comptesMenu:    "Which type of account interests you?",
        complaintStart: "I will register your complaint. Please continue via the form in the interface.",
    }
};

// ─── Définition des intentions ────────────────────────────────────────────────

const INTENT_DEFS = [
    {
        id: 'cartes',
        keywords: ['carte', 'cartes', 'card', 'cards', 'visa', 'mastercard', 'bancaire', 'paiement', 'retrait', 'debit', 'credit card'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].carteIntro, type: 'cartes' })
    },
    {
        id: 'credits',
        keywords: ['credit', 'crédit', 'pret', 'prêt', 'emprunt', 'emprunter', 'loan', 'financement', 'finance', 'remboursement', 'mensualite', 'mensualité', 'taux', 'interet', 'intérêt', 'borrow'],
        resolve: (text, lang) => {
            if (/personnel|personel|personal/i.test(text)) return { message: CONTENT[lang].pretPerso, type: 'text' };
            if (/immobil|maison|logement|mortgage|house|appartement|terrain/i.test(text)) return { message: CONTENT[lang].pretImmo, type: 'text' };
            if (/consommation|consumer|auto|voiture|car|moto|appareil|télé/i.test(text)) return { message: CONTENT[lang].pretConso, type: 'text' };
            if (/business|entreprise|societe|société|pme|commerce/i.test(text)) return { message: CONTENT[lang].pretBusiness, type: 'text' };
            return {
                message: CONTENT[lang].creditsMenu,
                type: 'tree',
                treeData: {
                    types: lang === 'fr'
                        ? [
                            { icon: '👤', key: 'pretPerso', label: 'Prêt Personnel', sub: '100K – 5M FCFA' },
                            { icon: '🏠', key: 'pretImmo', label: 'Crédit Immobilier', sub: '5 – 25 ans' },
                            { icon: '🛒', key: 'pretConso', label: 'Crédit Conso', sub: '50K – 2M FCFA' },
                            { icon: '🏢', key: 'pretBusiness', label: 'Crédit Business', sub: 'Sur mesure' }
                        ]
                        : [
                            { icon: '👤', key: 'pretPerso', label: 'Personal Loan', sub: '100K – 5M FCFA' },
                            { icon: '🏠', key: 'pretImmo', label: 'Mortgage Loan', sub: '5 – 25 years' },
                            { icon: '🛒', key: 'pretConso', label: 'Consumer Loan', sub: '50K – 2M FCFA' },
                            { icon: '🏢', key: 'pretBusiness', label: 'Business Loan', sub: 'Custom' }
                        ]
                }
            };
        }
    },
    {
        id: 'comptes',
        keywords: ['compte', 'comptes', 'account', 'accounts', 'ouvrir', 'ouverture', 'creer', 'créer', 'creation', 'création', 'epargne', 'épargne', 'courant', 'current', 'savings', 'deposer', 'dépôt'],
        resolve: (text, lang) => {
            if (/courant|current|quotidien/i.test(text)) return { message: CONTENT[lang].compteCourant, type: 'text' };
            if (/epargn|savings|interet|intérêt/i.test(text)) return { message: CONTENT[lang].compteEpargne, type: 'text' };
            if (/business|entreprise|societe|société|pme/i.test(text)) return { message: CONTENT[lang].compteBusiness, type: 'text' };
            if (/ouvrir|ouverture|creer|créer|new|nouveau|open/i.test(text)) return { message: CONTENT[lang].ouvertureCompte, type: 'text' };
            return {
                message: CONTENT[lang].comptesMenu,
                type: 'tree',
                treeData: {
                    types: lang === 'fr'
                        ? [
                            { icon: '💼', key: 'compteCourant', label: 'Compte Courant', sub: 'Gratuit' },
                            { icon: '🏦', key: 'compteEpargne', label: 'Compte Épargne', sub: "3.5% d'intérêts" },
                            { icon: '🏢', key: 'compteBusiness', label: 'Compte Business', sub: 'Sur mesure' }
                        ]
                        : [
                            { icon: '💼', key: 'compteCourant', label: 'Current Account', sub: 'Free' },
                            { icon: '🏦', key: 'compteEpargne', label: 'Savings Account', sub: '3.5% interest' },
                            { icon: '🏢', key: 'compteBusiness', label: 'Business Account', sub: 'Custom' }
                        ]
                }
            };
        }
    },
    {
        id: 'horaires',
        keywords: ['horaire', 'horaires', 'heure', 'heures', 'hour', 'hours', 'ouverture', 'ouvert', 'ferme', 'fermé', 'fermeture', 'schedule', 'quand', 'when', 'open'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].horaires, type: 'text' })
    },
    {
        id: 'agences',
        keywords: ['agence', 'agences', 'branch', 'branches', 'bureau', 'adresse', 'address', 'localisation', 'location', 'trouver', 'nearest', 'proche'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].agences, type: 'text' })
    },
    {
        id: 'contact',
        keywords: ['contact', 'telephone', 'téléphone', 'phone', 'email', 'mail', 'appeler', 'call', 'joindre', 'reach', 'numéro', 'numero', 'whatsapp', 'urgence'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].contact, type: 'text' })
    },
    {
        id: 'reclamation',
        keywords: ['reclamation', 'réclamation', 'complaint', 'plainte', 'probleme', 'problème', 'litige', 'erreur', 'error', 'virement', 'fraude', 'opposition', 'vol', 'perdu', 'bloqué', 'bloque'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].complaintStart, type: 'complaint_start' })
    },
    {
        id: 'salutation',
        keywords: ['bonjour', 'bonsoir', 'salut', 'hello', 'hi', 'hey', 'salam', 'bjr', 'bsr', 'good morning', 'good evening'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].botHello, type: 'text' })
    },
    {
        id: 'remerciement',
        keywords: ['merci', 'thanks', 'thank', 'appreciate', 'parfait', 'super', 'excellent', 'genial', 'génial', 'bravo', 'nickel'],
        resolve: (_text, lang) => ({ message: CONTENT[lang].merci, type: 'text' })
    }
];

// ─── Contexte: follow-up detection ───────────────────────────────────────────

const FOLLOW_UP_WORDS = [
    'et', 'aussi', 'plus', 'encore', 'autre', 'quel', 'quels', 'quelle', 'quelles',
    'combien', 'comment', 'and', 'also', 'more', 'other', 'what', 'how', 'much', 'many'
];

function isFollowUp(text) {
    const tokens = tokenize(text);
    return tokens.some(t => FOLLOW_UP_WORDS.includes(t)) || tokens.length <= 2;
}

// ─── Résolution principale ────────────────────────────────────────────────────

const THRESHOLD = 0.18;

/**
 * Résout l'intention depuis un message utilisateur.
 *
 * @param {string} message   - Le message brut de l'utilisateur
 * @param {string} lang      - 'fr' | 'en'
 * @param {Array}  history   - Historique de la session [{role, text, intent}]
 * @returns {object}         - { message, intent, confidence, suggestions, type }
 */
function resolve(message, lang = 'fr', history = []) {
    const text = (message || '').trim();
    if (!text) {
        return {
            message: CONTENT[lang].error,
            intent: null,
            confidence: 0,
            suggestions: [],
            type: 'text'
        };
    }

    const scores = INTENT_DEFS.map(def => ({
        def,
        score: nlpScore(text, def.keywords)
    })).sort((a, b) => b.score - a.score);

    const best = scores[0];
    const secondBest = scores[1];

    // Résolution contextuelle si score faible
    if (best.score < THRESHOLD) {
        const lastIntent = [...history].reverse().find(h => h.role === 'bot' && h.intent);
        if (lastIntent && isFollowUp(text)) {
            const ctxDef = INTENT_DEFS.find(d => d.id === lastIntent.intent);
            if (ctxDef) {
                const resolved = ctxDef.resolve(text, lang);
                return {
                    ...resolved,
                    intent: ctxDef.id,
                    confidence: 0.6,
                    suggestions: [],
                    isContextual: true
                };
            }
        }

        const suggestions = scores
            .filter(s => s.score > 0.08 && s.score < THRESHOLD)
            .slice(0, 3)
            .map(s => s.def.id);

        return {
            message: CONTENT[lang].error,
            intent: null,
            confidence: best.score,
            suggestions,
            type: 'text'
        };
    }

    const resolved = best.def.resolve(text, lang);
    const suggestions = [];

    if (secondBest && (best.score - secondBest.score) < 0.12 && secondBest.score > THRESHOLD * 0.7) {
        suggestions.push(secondBest.def.id);
    }

    return {
        ...resolved,
        intent: best.def.id,
        confidence: best.score,
        suggestions
    };
}

module.exports = { resolve };
