/**
 * claude-fallback.js — Cerveau Claude API pour les messages hors-portée du NLP local
 *
 * Appelé quand le score NLP est entre 0.15 et 0.40 (ambigu)
 * ou inférieur à 0.15 (incompris).
 *
 * Claude reçoit :
 *  - Un system prompt strict avec toute la connaissance BSIC
 *  - L'historique de la conversation (3 derniers échanges max)
 *  - Le message de l'utilisateur
 *
 * Claude retourne UNIQUEMENT une réponse BSIC, jamais de sujets hors-banque.
 */

'use strict';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL             = 'claude-haiku-4-5-20251001'; // rapide + économique
const MAX_TOKENS        = 400;
const TIMEOUT_MS        = 8000; // 8 secondes max

// ─── System prompt BSIC complet ───────────────────────────────────────────────

const SYSTEM_PROMPT_FR = `Tu es l'assistant virtuel officiel de BSIC Bank (Banque Sahélo-Saharienne pour l'Investissement et le Commerce).
Tu réponds UNIQUEMENT aux questions liées aux services de BSIC Bank.
Si la question n'a aucun rapport avec la banque, réponds poliment que tu ne peux aider que sur les services bancaires BSIC.
Sois concis (max 5 lignes), clair, et utilise des emojis avec modération.
Réponds toujours en français sauf si l'utilisateur écrit en anglais.
N'invente jamais de chiffres ou de conditions qui ne sont pas dans ta base de connaissance.

=== CONNAISSANCE BSIC BANK ===

CARTES BANCAIRES :
- Visa Classique : 5 000 FCFA/an — paiements et retraits mondiaux
- Visa Gold : 10 000 FCFA/an — limites élevées + assurance voyage
- Visa Platinum : 25 000 FCFA/an — services premium + conciergerie
- Carte Virtuelle : Gratuite — achats en ligne sécurisés

CRÉDITS :
- Prêt Personnel : 100 000 – 5 000 000 FCFA, taux 8-12%, durée 6 mois à 5 ans, réponse 48h, conditions : 21 ans min, revenus stables 50 000 FCFA+/mois, CNI + justificatifs
- Crédit Immobilier : taux 6-9% fixe, durée 5-25 ans, apport 20-30%, hypothèque + assurance emprunteur obligatoire
- Crédit Consommation : 50 000 – 2 000 000 FCFA, taux 9-15%, durée 3 mois à 4 ans, sans justificatif d'utilisation
- Crédit Business : solutions sur mesure PME, taux préférentiels avec domiciliation, contact : 20-25-30-40 poste 2

COMPTES :
- Compte Courant : gratuit, carte Visa incluse, virements illimités, banque en ligne 24h/7j. Documents : CNI, justificatif domicile, photo
- Compte Épargne : taux 3.5%/an, dépôt minimum 10 000 FCFA, intérêts versés chaque semestre, max 4 retraits/mois, capital garanti
- Compte Business : pour PME/entrepreneurs, conseiller dédié, gestion de trésorerie avancée
- Ouverture de compte : en agence, moins de 30 minutes, CNI + justificatif domicile (moins de 3 mois) + photo passeport + dépôt initial

HORAIRES : Lundi-Vendredi 8h00-16h30, Samedi 8h00-12h00, Dimanche et jours fériés : Fermé

AGENCES :
- Siège : Plateau, Avenue Botreau Roussel
- Cocody : Marché de Cocody, rue des Jardins
- Yopougon : Carrefour SIDECI
- Abobo : Gare routière principale
- Marcory : Zone 4, boulevard Valéry Giscard

CONTACT :
- Standard : 20-25-30-40
- Email : contact@bsicbank.ci
- Urgence 24h/7j : 80-80-80-80
- WhatsApp : +225 07 00 00 00

RÉCLAMATIONS : Le client peut déposer une réclamation en tapant "réclamation" pour lancer le formulaire guidé.`;

const SYSTEM_PROMPT_EN = `You are the official virtual assistant of BSIC Bank (Banque Sahélo-Saharienne pour l'Investissement et le Commerce).
You ONLY answer questions related to BSIC Bank services.
If the question has nothing to do with banking, politely say you can only help with BSIC banking services.
Be concise (max 5 lines), clear, and use emojis sparingly.
Always reply in English if the user writes in English.
Never invent figures or conditions not in your knowledge base.

=== BSIC BANK KNOWLEDGE ===

BANK CARDS:
- Visa Classic: 5,000 FCFA/year — global payments and withdrawals
- Visa Gold: 10,000 FCFA/year — higher limits + travel insurance
- Visa Platinum: 25,000 FCFA/year — premium services + concierge
- Virtual Card: Free — secure online purchases

LOANS:
- Personal Loan: 100,000 – 5,000,000 FCFA, rate 8-12%, duration 6 months to 5 years, response 48h, requirements: 21+ years, stable income 50,000 FCFA+/month, ID + proof of income
- Mortgage Loan: rate 6-9% fixed, duration 5-25 years, 20-30% down payment, mortgage + mandatory borrower insurance
- Consumer Loan: 50,000 – 2,000,000 FCFA, rate 9-15%, duration 3 months to 4 years, no proof of use required
- Business Loan: tailored for SMEs, preferential rates with domiciliation, contact: 20-25-30-40 ext. 2

ACCOUNTS:
- Current Account: free, Visa card included, unlimited transfers, online banking 24/7. Documents: ID, proof of address, photo
- Savings Account: 3.5% annual rate, minimum deposit 10,000 FCFA, interest paid every 6 months, max 4 withdrawals/month, capital guaranteed
- Business Account: for SMEs/entrepreneurs, dedicated advisor, advanced cash management
- Account opening: at any branch, under 30 minutes, ID + proof of address (under 3 months) + passport photo + initial deposit

HOURS: Monday-Friday 8:00am-4:30pm, Saturday 8:00am-12:00pm, Sunday & public holidays: Closed

BRANCHES:
- HQ: Plateau, Avenue Botreau Roussel
- Cocody: Cocody Market, Rue des Jardins
- Yopougon: SIDECI Crossroads
- Abobo: Main Bus Terminal
- Marcory: Zone 4, Bd Valéry Giscard

CONTACT:
- Phone: 20-25-30-40
- Email: contact@bsicbank.ci
- Emergency 24/7: 80-80-80-80
- WhatsApp: +225 07 00 00 00

COMPLAINTS: The customer can file a complaint by typing "complaint" to start the guided form.`;

// ─── Fonction principale ───────────────────────────────────────────────────────

/**
 * Appelle Claude API pour répondre à un message qui a échappé au NLP local.
 *
 * @param {string} userMessage   Message de l'utilisateur
 * @param {string} lang          'fr' | 'en'
 * @param {Array}  history       Historique session [{role, text}] — 3 derniers max
 * @returns {Promise<string>}    Réponse texte de Claude, ou null si erreur/timeout
 */
async function askClaude(userMessage, lang = 'fr', history = []) {
    if (!ANTHROPIC_API_KEY) {
        console.warn('[Claude] ANTHROPIC_API_KEY non définie — fallback Claude désactivé');
        return null;
    }

    // Construire les messages (3 derniers échanges pour le contexte)
    const contextMessages = [];
    const recentHistory = history.slice(-6); // 3 paires user/bot max

    for (const entry of recentHistory) {
        if (entry.role === 'user') {
            contextMessages.push({ role: 'user', content: entry.text });
        } else if (entry.role === 'bot' && entry.text) {
            contextMessages.push({ role: 'assistant', content: entry.text });
        }
    }

    // Ajouter le message actuel
    contextMessages.push({ role: 'user', content: userMessage });

    // S'assurer que le premier message est 'user' (contrainte API Anthropic)
    while (contextMessages.length > 0 && contextMessages[0].role !== 'user') {
        contextMessages.shift();
    }

    const systemPrompt = lang === 'en' ? SYSTEM_PROMPT_EN : SYSTEM_PROMPT_FR;

    try {
        const controller = new AbortController();
        const timeout    = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method:  'POST',
            signal:  controller.signal,
            headers: {
                'Content-Type':      'application/json',
                'x-api-key':         ANTHROPIC_API_KEY,
                'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify({
                model:      MODEL,
                max_tokens: MAX_TOKENS,
                system:     systemPrompt,
                messages:   contextMessages
            })
        });

        clearTimeout(timeout);

        if (!response.ok) {
            const err = await response.text();
            console.error(`[Claude] API error ${response.status}:`, err);
            return null;
        }

        const data = await response.json();
        const text = data?.content?.[0]?.text?.trim();

        if (!text) {
            console.error('[Claude] Réponse vide');
            return null;
        }

        console.log(`[Claude] Réponse OK (${data.usage?.output_tokens || '?'} tokens)`);
        return text;

    } catch (err) {
        if (err.name === 'AbortError') {
            console.warn('[Claude] Timeout dépassé (8s)');
        } else {
            console.error('[Claude] Erreur fetch:', err.message);
        }
        return null;
    }
}

module.exports = { askClaude };
