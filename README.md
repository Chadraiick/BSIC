# BSIC AI — Backend

Backend Node.js pour le chatbot bancaire BSIC AI.  
Stack : **Express** · **Socket.IO** · **JWT** · déployable sur **Render** en quelques clics.

---

## Structure des fichiers (tout à la racine)

```
├── server.js        ← Point d'entrée principal (Express + Socket.IO)
├── nlp.js           ← Moteur NLP serveur (Levenshtein + stemming + intents)
├── complaints.js    ← Gestion des réclamations (stockage mémoire)
├── package.json     ← Dépendances npm
├── .env.example     ← Variables d'environnement à copier
├── .gitignore
└── index.html       ← (optionnel) votre frontend servi en statique
```

---

## Déploiement sur Render

### 1. Préparer le dépôt Git

```bash
git init
git add .
git commit -m "initial commit"
```

Puis poussez sur GitHub / GitLab.

### 2. Créer le service sur Render

1. Connectez-vous sur [render.com](https://render.com)
2. **New** → **Web Service**
3. Connectez votre dépôt
4. Configurez :
   | Champ | Valeur |
   |-------|--------|
   | **Runtime** | Node |
   | **Build Command** | `npm install` |
   | **Start Command** | `npm start` |

### 3. Ajouter les variables d'environnement

Dans **Environment** → **Add Variable** :

| Clé | Valeur |
|-----|--------|
| `JWT_SECRET` | Une longue chaîne aléatoire secrète |
| `FRONTEND_URL` | URL de votre frontend (ex: `https://mon-front.onrender.com`) |

> `PORT` est défini automatiquement par Render — ne l'ajoutez pas.

### 4. Mettre à jour le frontend

Une fois le service déployé, Render vous donne une URL comme :
`https://bsic-ai-backend.onrender.com`

Dans votre `index.html`, remplacez :
```js
const BACKEND_URL = 'https://votre-backend.runway.com';
const WS_URL = 'wss://votre-backend.runway.com';
```
par :
```js
const BACKEND_URL = 'https://bsic-ai-backend.onrender.com';
const WS_URL = 'wss://bsic-ai-backend.onrender.com';
```

Et dans la balise `<meta http-equiv="Content-Security-Policy">`, remplacez `votre-backend.runway.com` par votre vraie URL Render.

---

## Développement local

```bash
npm install
cp .env.example .env   # puis éditez .env
npm run dev            # nodemon avec rechargement auto
```

Le serveur écoute sur `http://localhost:3000`.

---

## API REST

| Méthode | Endpoint | Description |
|---------|----------|-------------|
| `POST` | `/api/users/session` | Crée une session anonyme, retourne `{ token, sessionId }` |
| `GET` | `/api/health` | Health check (utilisé par Render) |
| `GET` | `/api/complaints` | Liste les réclamations enregistrées |

---

## Événements WebSocket (Socket.IO)

### Client → Serveur

| Événement | Payload | Description |
|-----------|---------|-------------|
| `user:join` | `{ sessionId }` | Rejoint la salle de session |
| `chat:message` | `{ message, language }` | Envoie un message au NLP |

### Serveur → Client

| Événement | Payload | Description |
|-----------|---------|-------------|
| `chat:response` | `{ message, intent, confidence, type, suggestions }` | Réponse du NLP |
| `chat:error` | `{ message }` | Message d'erreur |

---

## Évolutions possibles

- Remplacer le stockage mémoire par **PostgreSQL** (addon Render) ou **MongoDB Atlas**
- Ajouter une vraie couche d'authentification si vous exposez `/api/complaints`
- Brancher un LLM (OpenAI, Claude API) pour les questions hors-base
