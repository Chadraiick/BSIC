/**
 * server.js — Backend BSIC AI
 * Express + Socket.IO + Twilio WhatsApp + Claude API fallback
 */

'use strict';

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const jwt        = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const twilio     = require('twilio');

const { resolve: nlpResolve, detectLang, MENU_MSG, SCORE_HIGH, SCORE_LOW } = require('./nlp');
const { askClaude } = require('./claude-fallback');
const complaintHandler = require('./complaints');

const app    = express();
const server = http.createServer(app);

const FRONTEND_URL         = process.env.FRONTEND_URL         || '*';
const JWT_SECRET           = process.env.JWT_SECRET           || 'bsic-ai-secret-change-in-production';
const PORT                 = process.env.PORT                 || 3000;
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

// FIX — on utilise le TwiML inline par défaut (plus simple et fiable pour le sandbox)
// Le client Twilio API est utilisé seulement si TWILIO_USE_API=true est explicitement défini
const USE_TWILIO_API = process.env.TWILIO_USE_API === 'true';

const twilioClient = USE_TWILIO_API && TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false })); // Twilio envoie en form-urlencoded
app.use(express.static('.'));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
    cors: { origin: FRONTEND_URL, methods: ['GET', 'POST'], credentials: true }
});

io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
        socket.data.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch {
        next(new Error('Invalid token'));
    }
});

// ─── Sessions ─────────────────────────────────────────────────────────────────
const sessions = new Map();

function getOrCreateSession(key) {
    if (!sessions.has(key)) {
        sessions.set(key, {
            language:     'fr',
            history:      [],
            complaint:    null,
            createdAt:    Date.now(),
            firstMessage: true
        });
    }
    return sessions.get(key);
}

/**
 * FIX #2 — Langue figée UNE SEULE FOIS au premier message.
 * Sur les sessions existantes (après redémarrage), firstMessage est true
 * donc la langue est re-détectée proprement sur le prochain message.
 */
function maybeLockLanguage(session, text) {
    if (session.firstMessage) {
        session.language     = detectLang(text);
        session.firstMessage = false;
        console.log(`[Lang] Détectée : ${session.language} sur "${text.slice(0, 30)}"`);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// CŒUR — Résolution intelligente à 3 niveaux
// ══════════════════════════════════════════════════════════════════════════════

async function smartResolve(userMessage, session) {
    const lang    = session.language || 'fr';
    const history = session.history  || [];

    // Étape 1 : NLP local (toujours lancé en premier, synchrone)
    const nlpResult = nlpResolve(userMessage, lang, history, session);

    // Priorités absolues — jamais remplacées par Claude
    const isAbsolute = (
        nlpResult.type === 'complaint_step' ||
        nlpResult.type === 'complaint_done' ||
        nlpResult.confidence === 1
    );

    if (isAbsolute) {
        return { ...nlpResult, source: 'nlp' };
    }

    // Score élevé → réponse NLP directe
    if (nlpResult.confidence >= SCORE_HIGH && nlpResult.intent !== null) {
        console.log(`[NLP] intent=${nlpResult.intent} score=${nlpResult.confidence.toFixed(2)} → direct`);
        return { ...nlpResult, source: 'nlp' };
    }

    // Score faible ou ambigu → Claude API
    console.log(`[NLP] score=${nlpResult.confidence.toFixed(2)} → Claude API`);
    const claudeText = await askClaude(userMessage, lang, history);

    if (claudeText) {
        return {
            message:     claudeText,
            intent:      nlpResult.intent || 'claude',
            confidence:  nlpResult.confidence,
            type:        'text',
            suggestions: [],
            source:      'claude'
        };
    }

    // Claude indisponible → NLP quand même
    console.warn('[Fallback] Claude indisponible — NLP local utilisé');
    return { ...nlpResult, source: 'fallback' };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTreeForWhatsApp(result) {
    if (result.type === 'tree' && result.treeData?.types) {
        const lines = result.treeData.types
            .map((t, i) => `${i + 1}. ${t.icon} *${t.label}* — ${t.sub}`)
            .join('\n');
        return `${result.message}\n\n${lines}`;
    }
    return result.message;
}

function saveHistoryEntry(session, role, result) {
    session.history.push({
        role,
        text:   typeof result === 'string' ? result : (result.message || ''),
        intent: result.intent || null,
        ts:     Date.now()
    });
    if (session.history.length > 40) session.history = session.history.slice(-40);
}

// ─── REST API ──────────────────────────────────────────────────────────────────

app.post('/api/users/session', (req, res) => {
    const { language } = req.body;
    const sessionId    = uuidv4();
    sessions.set(sessionId, {
        language:     language || 'fr',
        history:      [],
        complaint:    null,
        createdAt:    Date.now(),
        firstMessage: !language
    });
    const token = jwt.sign({ sessionId, role: 'user' }, JWT_SECRET, { expiresIn: '6h' });
    res.json({ token, sessionId });
});

app.get('/api/health', (_req, res) => {
    res.json({
        status:        'ok',
        uptime:        Math.round(process.uptime()),
        sessions:      sessions.size,
        claude:        !!process.env.ANTHROPIC_API_KEY,
        twilioMode:    USE_TWILIO_API ? 'api' : 'twiml'
    });
});

app.get('/api/complaints', (_req, res) => {
    res.json(complaintHandler.getAll());
});

/* ══════════════════════════════════════════════════════════════════════════════
   WEBHOOK TWILIO WHATSAPP — POST /whatsapp

   Twilio appelle cette URL à chaque message entrant.
   Corps (application/x-www-form-urlencoded) :
     Body        → texte du message
     From        → "whatsapp:+22507000000"
     ProfileName → nom WhatsApp de l'expéditeur

   Configuration Twilio Console :
     Messaging → WhatsApp → Sandbox
     "When a message comes in" → https://VOTRE-BACKEND.onrender.com/whatsapp  [POST]
══════════════════════════════════════════════════════════════════════════════ */
app.post('/whatsapp', async (req, res) => {

    // ── FIX #1 — Validation signature DÉSACTIVÉE par défaut ───────────────────
    // La validation de signature échouait silencieusement sur Render car
    // l'URL reconstruite (req.protocol + host) ne correspondait pas exactement
    // à l'URL enregistrée chez Twilio.
    // Pour l'activer en production : mettre TWILIO_VALIDATE_SIGNATURE=true
    if (process.env.TWILIO_VALIDATE_SIGNATURE === 'true' && TWILIO_AUTH_TOKEN) {
        const signature = req.headers['x-twilio-signature'] || '';
        // Render est derrière un proxy — utiliser X-Forwarded-Proto
        const proto     = req.headers['x-forwarded-proto'] || req.protocol;
        const host      = req.headers['x-forwarded-host']  || req.get('host');
        const url       = `${proto}://${host}/whatsapp`;

        if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body)) {
            console.warn(`[WhatsApp] Signature invalide — URL testée : ${url}`);
            return res.status(403).send('Forbidden');
        }
    }

    const userMessage = (req.body.Body        || '').trim();
    const fromNumber  =  req.body.From        || '';
    const profileName =  req.body.ProfileName || 'Client';

    console.log(`[WA ↓] ${fromNumber} (${profileName}): "${userMessage}"`);

    // Message vide → répondre 200 vide pour éviter les retry Twilio
    if (!userMessage || !fromNumber) {
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    // ── Session ──────────────────────────────────────────────────────────────
    const session = getOrCreateSession(fromNumber);
    maybeLockLanguage(session, userMessage);

    // Reset formulaire si incohérence post-redémarrage
    if (session.complaint && session.history.length === 0) {
        session.complaint = null;
    }

    saveHistoryEntry(session, 'user', { message: userMessage });

    // ── NLP + Claude ──────────────────────────────────────────────────────────
    let botMessage;
    try {
        const result = await smartResolve(userMessage, session);

        saveHistoryEntry(session, 'bot', result);
        if (result.complaintData) complaintHandler.save(result.complaintData);

        botMessage = formatTreeForWhatsApp(result);

        console.log(`[WA ↑] [${result.source}] → ${fromNumber}: "${botMessage.slice(0, 100)}"`);

    } catch (err) {
        console.error('[WA Error]', err);
        botMessage = session.language === 'fr'
            ? "Une erreur s'est produite. Tapez *menu* pour recommencer."
            : "An error occurred. Type *menu* to start over.";
    }

    // ── FIX #1 — Envoi via TwiML inline (par défaut, le plus fiable) ─────────
    // Twilio lit le TwiML dans la réponse HTTP — pas besoin de faire un appel API séparé.
    // C'est la méthode recommandée pour le sandbox.
    // Pour passer en mode API (numéro de prod approuvé), mettre TWILIO_USE_API=true.
    if (twilioClient) {
        // Mode API explicitement activé
        try {
            await twilioClient.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to:   fromNumber,
                body: botMessage
            });
            console.log(`[WA] Envoyé via API Twilio`);
            return res.status(200).send('');
        } catch (err) {
            console.error('[WA API Send Error]', err.message);
            // Ne pas tomber sur TwiML ici — res serait déjà envoyé
            return res.status(500).send('');
        }
    }

    // Mode TwiML inline (défaut sandbox)
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(botMessage);
    console.log(`[WA] Envoyé via TwiML`);
    return res.set('Content-Type', 'text/xml').send(twiml.toString());
});

// ─── WebSocket (chatbot web) ───────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] Connected: ${socket.id}`);

    socket.on('user:join', ({ sessionId }) => {
        if (!sessions.has(sessionId)) {
            socket.emit('chat:error', { message: 'Session not found. Please refresh.' });
            return;
        }
        socket.join(sessionId);
        socket.data.sessionId = sessionId;
    });

    socket.on('chat:message', async (payload) => {
        const { message, language = 'fr' } = payload;
        const sessionId = socket.data.sessionId;

        if (!sessionId || !sessions.has(sessionId)) {
            socket.emit('chat:error', { message: 'Invalid session.' });
            return;
        }

        const session = sessions.get(sessionId);
        maybeLockLanguage(session, message);
        if (!session.firstMessage && language) session.language = language;

        saveHistoryEntry(session, 'user', { message });

        try {
            const result = await smartResolve(message, session);

            saveHistoryEntry(session, 'bot', result);
            if (result.complaintData) complaintHandler.save(result.complaintData);

            console.log(`[WS] [${result.source}] score=${result.confidence?.toFixed(2)} intent=${result.intent}`);
            socket.emit('chat:response', result);

        } catch (err) {
            console.error('[WS Error]', err);
            socket.emit('chat:error', {
                message: session.language === 'fr'
                    ? "Une erreur s'est produite. Veuillez réessayer."
                    : "An error occurred. Please try again."
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Disconnected: ${socket.id}`);
    });
});

// ─── Nettoyage sessions (toutes les 30 min) ───────────────────────────────────
setInterval(() => {
    const now = Date.now();
    const TTL = 6 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const [id, s] of sessions.entries()) {
        if (now - s.createdAt > TTL) { sessions.delete(id); cleaned++; }
    }
    if (cleaned > 0) console.log(`[GC] ${cleaned} session(s) supprimée(s)`);
}, 30 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`\n✅  BSIC AI Backend — port ${PORT}`);
    console.log(`📱  WhatsApp webhook  : POST /whatsapp`);
    console.log(`🔁  Mode envoi Twilio : ${USE_TWILIO_API ? 'API (TWILIO_USE_API=true)' : 'TwiML inline (défaut)'}`);
    console.log(`🔐  Signature Twilio  : ${process.env.TWILIO_VALIDATE_SIGNATURE === 'true' ? 'ACTIVÉE' : 'désactivée'}`);
    console.log(`🧠  Claude fallback   : ${process.env.ANTHROPIC_API_KEY ? 'ACTIVÉ ✓' : '⚠️  DÉSACTIVÉ (ANTHROPIC_API_KEY manquante)'}`);
    console.log(`   Seuils NLP : direct >= ${SCORE_HIGH} | Claude < ${SCORE_HIGH}\n`);
});
