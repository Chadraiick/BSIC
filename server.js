/**
 * server.js — Backend BSIC AI
 * Express + Socket.IO + Twilio WhatsApp + Claude API fallback
 *
 * Logique de routage NLP :
 *   score >= 0.40  → NLP local direct        (rapide, gratuit)
 *   score  0.15-0.40 → Claude API            (ambigu, phrases longues)
 *   score <  0.15  → Claude API              (incompris)
 *   formulaire / stop / menu → priorité absolue, jamais envoyé à Claude
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

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
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

function maybeLockLanguage(session, text) {
    if (session.firstMessage) {
        session.language     = detectLang(text);
        session.firstMessage = false;
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// CŒUR — Résolution intelligente à 3 niveaux
//
//  Niveau 1 : NLP local (score >= SCORE_HIGH)
//  Niveau 2 : Claude API (score < SCORE_HIGH  OU  score < SCORE_LOW)
//  Garde-fous : formulaire, stop/menu, réponse numérique → jamais envoyés à Claude
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Résout un message utilisateur.
 * Retourne toujours { message, intent, confidence, type, suggestions, source }
 * source : 'nlp' | 'claude' | 'fallback'
 */
async function smartResolve(userMessage, session) {
    const lang    = session.language || 'fr';
    const history = session.history  || [];

    // ── Étape 1 : NLP local (synchrone, toujours lancé en premier) ────────────
    const nlpResult = nlpResolve(userMessage, lang, history, session);

    // Cas où le NLP a une priorité absolue et ne doit JAMAIS être remplacé par Claude :
    //  • Formulaire réclamation en cours (complaint_step / complaint_done)
    //  • Commande globale (stop/menu) → confidence = 1
    //  • Réponse numérique à un menu  → confidence = 1
    const isAbsolute = (
        nlpResult.type === 'complaint_step'  ||
        nlpResult.type === 'complaint_done'  ||
        nlpResult.confidence === 1
    );

    if (isAbsolute) {
        return { ...nlpResult, source: 'nlp' };
    }

    // ── Étape 2 : Score NLP suffisamment élevé → réponse directe ──────────────
    if (nlpResult.confidence >= SCORE_HIGH && nlpResult.intent !== null) {
        console.log(`[NLP] intent=${nlpResult.intent} score=${nlpResult.confidence.toFixed(2)} → direct`);
        return { ...nlpResult, source: 'nlp' };
    }

    // ── Étape 3 : Score ambigu ou nul → Claude API ────────────────────────────
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

    // ── Étape 4 : Claude a échoué (timeout, clé absente…) → NLP quand même ────
    console.warn('[Fallback] Claude indisponible — réponse NLP locale utilisée');
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
        text:   result.message || result,
        intent: result.intent  || null,
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
        status:   'ok',
        uptime:   process.uptime(),
        sessions: sessions.size,
        claude:   !!process.env.ANTHROPIC_API_KEY
    });
});

app.get('/api/complaints', (_req, res) => {
    res.json(complaintHandler.getAll());
});

/* ══════════════════════════════════════════════════════════════════════════════
   WEBHOOK TWILIO WHATSAPP — POST /whatsapp
══════════════════════════════════════════════════════════════════════════════ */
app.post('/whatsapp', async (req, res) => {

    // Validation signature Twilio
    if (TWILIO_AUTH_TOKEN && process.env.NODE_ENV !== 'development') {
        const signature = req.headers['x-twilio-signature'] || '';
        const url       = `${req.protocol}://${req.get('host')}/whatsapp`;
        if (!twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body)) {
            console.warn('[WhatsApp] Signature invalide — requête rejetée');
            return res.status(403).send('Forbidden');
        }
    }

    const userMessage = (req.body.Body        || '').trim();
    const fromNumber  =  req.body.From        || '';
    const profileName =  req.body.ProfileName || 'Client';

    console.log(`[WA ↓] ${fromNumber} (${profileName}): "${userMessage}"`);

    if (!userMessage || !fromNumber) {
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    const session = getOrCreateSession(fromNumber);
    maybeLockLanguage(session, userMessage);

    // Reset formulaire si incohérence post-redémarrage
    if (session.complaint && session.history.length === 0) {
        session.complaint = null;
    }

    saveHistoryEntry(session, 'user', { message: userMessage });

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

    // Envoi via API Twilio
    if (twilioClient) {
        try {
            await twilioClient.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to:   fromNumber,
                body: botMessage
            });
            return res.set('Content-Type', 'text/xml').send('<Response></Response>');
        } catch (err) {
            console.error('[WA Send Error]', err.message);
        }
    }

    // Fallback TwiML inline
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(botMessage);
    res.set('Content-Type', 'text/xml').send(twiml.toString());
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

        // Langue : fixée au 1er message, ou mise à jour si l'utilisateur change via bouton FR/EN
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
    console.log(`✅ BSIC AI Backend — port ${PORT}`);
    console.log(`📱 WhatsApp webhook : POST /whatsapp`);
    console.log(`🧠 Claude fallback  : ${process.env.ANTHROPIC_API_KEY ? 'ACTIVÉ' : '⚠️ DÉSACTIVÉ (ANTHROPIC_API_KEY manquante)'}`);
    console.log(`   Seuils NLP : direct >= ${SCORE_HIGH} | Claude < ${SCORE_HIGH} | Claude obligatoire < ${SCORE_LOW}`);
});
