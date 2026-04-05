const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const twilio = require('twilio');
const nlpEngine = require('./nlp');
const complaintHandler = require('./complaints');

const app = express();
const server = http.createServer(app);

const FRONTEND_URL         = process.env.FRONTEND_URL         || '*';
const JWT_SECRET           = process.env.JWT_SECRET           || 'bsic-ai-secret-change-in-production';
const PORT                 = process.env.PORT                 || 3000;
const TWILIO_ACCOUNT_SID   = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN    = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_WHATSAPP_FROM = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886'; // sandbox par défaut

// Client Twilio pour envoyer les réponses WhatsApp
const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(cors({ origin: FRONTEND_URL, credentials: true }));
app.use(express.json());
// ⚠️ Twilio envoie ses webhooks en application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// Serve static frontend si index.html est présent à la racine
app.use(express.static('.'));

// ─── Socket.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
    cors: {
        origin: FRONTEND_URL,
        methods: ['GET', 'POST'],
        credentials: true
    }
});

// JWT middleware for Socket.IO
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        socket.data.user = decoded;
        next();
    } catch {
        next(new Error('Invalid token'));
    }
});

// ─── Sessions en mémoire (utiliser Redis en prod pour le scaling) ─────────────
// Clé web  : sessionId (UUID)
// Clé WA   : numéro WhatsApp ex. "whatsapp:+22507000000"
// Structure : { language, history: [{role, text, intent, ts}], createdAt }
const sessions = new Map();

// ─── Utilitaire : détecter la langue d'un message ─────────────────────────────
function detectLang(text) {
    const enWords = /\b(hello|hi|hey|card|account|loan|hours|branch|complaint|thank|open)\b/i;
    return enWords.test(text) ? 'en' : 'fr'; // défaut FR
}

// ─── REST API ─────────────────────────────────────────────────────────────────

/**
 * POST /api/users/session
 * Crée une session anonyme pour le chatbot web, retourne JWT + sessionId.
 */
app.post('/api/users/session', (req, res) => {
    const { language = 'fr' } = req.body;
    const sessionId = uuidv4();

    sessions.set(sessionId, {
        language,
        history: [],
        createdAt: Date.now()
    });

    const token = jwt.sign(
        { sessionId, role: 'user' },
        JWT_SECRET,
        { expiresIn: '6h' }
    );

    res.json({ token, sessionId });
});

/**
 * GET /api/health
 * Health check utilisé par Render pour vérifier que le service tourne.
 */
app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * GET /api/complaints
 * Liste toutes les réclamations (à protéger en production).
 */
app.get('/api/complaints', (_req, res) => {
    res.json(complaintHandler.getAll());
});

/* ============================================================================
   WEBHOOK TWILIO WHATSAPP
   POST /whatsapp

   Twilio appelle cette URL à chaque message reçu sur votre numéro WhatsApp.
   Corps de la requête (application/x-www-form-urlencoded) :
     Body        → texte du message utilisateur
     From        → numéro expéditeur  ex. "whatsapp:+22507000000"
     To          → votre numéro Twilio ex. "whatsapp:+14155238886"
     ProfileName → nom WhatsApp de l'expéditeur

   Configuration Twilio Console :
     Messaging → WhatsApp → Sandbox (ou numéro approuvé)
     "When a message comes in" → https://VOTRE-BACKEND.onrender.com/whatsapp
     HTTP Method : POST
============================================================================ */
app.post('/whatsapp', async (req, res) => {

    // 1. Valider la signature Twilio (sécurité en production)
    if (TWILIO_AUTH_TOKEN && process.env.NODE_ENV !== 'development') {
        const signature = req.headers['x-twilio-signature'] || '';
        const url       = `${req.protocol}://${req.get('host')}/whatsapp`;
        const isValid   = twilio.validateRequest(TWILIO_AUTH_TOKEN, signature, url, req.body);

        if (!isValid) {
            console.warn('[WhatsApp] Signature Twilio invalide — requête rejetée');
            return res.status(403).send('Forbidden');
        }
    }

    // 2. Extraire les champs du webhook Twilio
    const userMessage = (req.body.Body        || '').trim();
    const fromNumber  =  req.body.From        || '';   // "whatsapp:+22507000000"
    const profileName =  req.body.ProfileName || 'Client';

    console.log(`[WhatsApp ↓] ${fromNumber} (${profileName}): "${userMessage}"`);

    // Message vide → répondre 200 pour éviter les retry Twilio
    if (!userMessage || !fromNumber) {
        return res.set('Content-Type', 'text/xml').send('<Response></Response>');
    }

    // 3. Récupérer ou créer la session associée au numéro WhatsApp
    if (!sessions.has(fromNumber)) {
        sessions.set(fromNumber, {
            language:  detectLang(userMessage),
            history:   [],
            createdAt: Date.now()
        });
    }

    const session = sessions.get(fromNumber);
    // Raffraîchir la détection de langue à chaque message
    session.language = detectLang(userMessage) || session.language;

    // 4. Stocker le message utilisateur
    session.history.push({ role: 'user', text: userMessage, ts: Date.now() });

    // 5. Résolution NLP
    let botMessage;
    try {
        const result = nlpEngine.resolve(userMessage, session.language, session.history);

        session.history.push({
            role:   'bot',
            text:   result.message,
            intent: result.intent,
            ts:     Date.now()
        });

        // Limiter l'historique à 40 échanges
        if (session.history.length > 40) {
            session.history = session.history.slice(-40);
        }

        // Persister une éventuelle réclamation
        if (result.complaint) {
            complaintHandler.save(result.complaint);
        }

        botMessage = result.message;

        // Arbre de décision → formater en liste numérotée pour WhatsApp
        if (result.type === 'tree' && result.treeData?.types) {
            const options = result.treeData.types
                .map((t, i) => `${i + 1}. ${t.icon} *${t.label}* (${t.sub})`)
                .join('\n');
            botMessage = `${result.message}\n\n${options}`;
        }

    } catch (err) {
        console.error('[WhatsApp NLP Error]', err);
        botMessage = session.language === 'fr'
            ? "Une erreur s'est produite. Veuillez réessayer."
            : "An error occurred. Please try again.";
    }

    console.log(`[WhatsApp ↑] → ${fromNumber}: "${botMessage.slice(0, 80)}…"`);

    // 6a. Envoyer via l'API Twilio (recommandé — supporte médias, templates…)
    if (twilioClient) {
        try {
            await twilioClient.messages.create({
                from: TWILIO_WHATSAPP_FROM,
                to:   fromNumber,
                body: botMessage
            });
            // Répondre 200 vide : Twilio a déjà la réponse via l'API
            return res.set('Content-Type', 'text/xml').send('<Response></Response>');
        } catch (twilioErr) {
            console.error('[WhatsApp Send Error]', twilioErr.message);
            // On tombe sur le fallback TwiML ci-dessous
        }
    }

    // 6b. Fallback TwiML inline (fonctionne sans clés Twilio configurées — utile pour tester)
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(botMessage);
    res.set('Content-Type', 'text/xml').send(twiml.toString());
});

// ─── WebSocket Events (chatbot web) ───────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`[WS] Client connected: ${socket.id}`);

    socket.on('user:join', ({ sessionId }) => {
        if (!sessions.has(sessionId)) {
            socket.emit('chat:error', { message: 'Session not found. Please refresh.' });
            return;
        }
        socket.join(sessionId);
        socket.data.sessionId = sessionId;
        console.log(`[WS] Session joined: ${sessionId}`);
    });

    socket.on('chat:message', async (payload) => {
        const { message, language = 'fr' } = payload;
        const sessionId = socket.data.sessionId;

        if (!sessionId || !sessions.has(sessionId)) {
            socket.emit('chat:error', { message: 'Invalid session.' });
            return;
        }

        const session = sessions.get(sessionId);
        session.language = language;
        session.history.push({ role: 'user', text: message, ts: Date.now() });

        try {
            const result = nlpEngine.resolve(message, language, session.history);

            session.history.push({
                role: 'bot', text: result.message, intent: result.intent, ts: Date.now()
            });

            if (session.history.length > 40) session.history = session.history.slice(-40);
            if (result.complaint) complaintHandler.save(result.complaint);

            socket.emit('chat:response', result);
        } catch (err) {
            console.error('[NLP Error]', err);
            socket.emit('chat:error', {
                message: language === 'fr'
                    ? "Une erreur s'est produite. Veuillez réessayer."
                    : "An error occurred. Please try again."
            });
        }
    });

    socket.on('disconnect', () => {
        console.log(`[WS] Client disconnected: ${socket.id}`);
    });
});

// ─── Nettoyage périodique des sessions (toutes les 30 min) ───────────────────
setInterval(() => {
    const now = Date.now();
    const TTL = 6 * 60 * 60 * 1000; // 6 heures
    for (const [id, session] of sessions.entries()) {
        if (now - session.createdAt > TTL) sessions.delete(id);
    }
}, 30 * 60 * 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log(`✅ BSIC AI Backend running on port ${PORT}`);
    console.log(`📱 WhatsApp webhook : POST /whatsapp`);
    if (!twilioClient) {
        console.warn('⚠️  Variables Twilio manquantes — mode TwiML inline (tests uniquement)');
    }
});
