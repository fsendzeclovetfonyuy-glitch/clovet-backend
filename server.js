/**
 * CLOVET Backend — one server for everything CLOVET needs from the cloud:
 *
 *   /api/ai/smart-replies   → suggested quick replies (Claude)
 *   /api/ai/summarize       → chat summaries, 1:1 and group (Claude)
 *   /api/ai/translate       → message translation (Claude)
 *   /livekit-token          → signed tokens so the app can join calls
 *   /api/push/call          → push notification that rings a closed phone
 *   /health                 → uptime check
 *
 * This replaces the two separate services (clovet-ai-backend and the
 * LiveKit token server) — one deployment, one URL, one set of env vars.
 *
 * Your Anthropic API key and LiveKit API secret live ONLY here, server
 * side. Never embed either in the Flutter app.
 */

const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const { AccessToken } = require('livekit-server-sdk');
const admin = require('firebase-admin');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ── Config — set these as environment variables on your host ────────────
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || 'CHANGE_ME';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;
// Whole Firebase service-account JSON (Firebase console → Project settings →
// Service accounts → Generate new private key). Paste the file's contents as
// one environment variable. Only needed for call push notifications.
const FIREBASE_SERVICE_ACCOUNT = process.env.FIREBASE_SERVICE_ACCOUNT;

let firebaseReady = false;
if (FIREBASE_SERVICE_ACCOUNT) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(FIREBASE_SERVICE_ACCOUNT)),
    });
    firebaseReady = true;
  } catch (e) {
    console.error('FIREBASE_SERVICE_ACCOUNT is set but invalid:', e.message);
  }
}

const anthropic = ANTHROPIC_API_KEY ? new Anthropic({ apiKey: ANTHROPIC_API_KEY }) : null;

// ── Shared auth — accepts the secret either as a header (used by
// AiAssistService) or in the JSON body (used by the call screen), so both
// parts of the Flutter app work against this one server unmodified. ──────
function checkAuth(req, res, next) {
  const headerSecret = req.get('X-App-Secret');
  const bodySecret = req.body?.secret;
  if (headerSecret !== APP_SHARED_SECRET && bodySecret !== APP_SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/health', (_req, res) => res.json({ ok: true }));

// ═════════════════════════════════════════════════════════════════════════
//  AI FEATURES — smart replies, summaries, translation
// ═════════════════════════════════════════════════════════════════════════
const AI_MODEL = 'claude-sonnet-4-5';

app.post('/api/ai/smart-replies', checkAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'AI not configured' });
    const messages = req.body.messages || [];
    const transcript = messages
      .slice(-15)
      .map((m) => `${m.fromMe ? 'Me' : 'Them'}: ${m.text}`)
      .join('\n');

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 300,
      system:
        'You suggest short quick-reply chips for a chat app, like Gmail/WhatsApp smart replies. ' +
        'Given the recent conversation, suggest 2-4 short replies (under 8 words each) the user ' +
        'might want to send next, from "Me"\'s perspective. Reply with ONLY a JSON array of strings, ' +
        'nothing else. Example: ["Sounds good!", "What time?", "Can\'t make it"]',
      messages: [{ role: 'user', content: transcript || '(no messages yet)' }],
    });

    const text = response.content.find((b) => b.type === 'text')?.text ?? '[]';
    let replies;
    try {
      replies = JSON.parse(text.trim());
    } catch {
      replies = [];
    }
    res.json({ replies: Array.isArray(replies) ? replies.slice(0, 4) : [] });
  } catch (e) {
    console.error('smart-replies error:', e);
    res.status(500).json({ error: 'Failed to generate smart replies' });
  }
});

app.post('/api/ai/summarize', checkAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'AI not configured' });
    const messages = req.body.messages || [];
    const transcript = messages
      .map((m) => `${m.sender || (m.fromMe ? 'Me' : 'Them')}: ${m.text}`)
      .join('\n');

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 400,
      system:
        'You summarize chat conversations so someone can quickly catch up. ' +
        'Write a short summary (3-6 sentences, or bullet points for a busy group chat), ' +
        'covering key points, decisions, and anything actionable. Plain text only, no headers.',
      messages: [{ role: 'user', content: transcript || '(no messages yet)' }],
    });

    const summary = response.content.find((b) => b.type === 'text')?.text ?? null;
    res.json({ summary });
  } catch (e) {
    console.error('summarize error:', e);
    res.status(500).json({ error: 'Failed to summarize' });
  }
});

app.post('/api/ai/translate', checkAuth, async (req, res) => {
  try {
    if (!anthropic) return res.status(500).json({ error: 'AI not configured' });
    const { text, targetLanguage } = req.body;
    if (!text || !targetLanguage) {
      return res.status(400).json({ error: 'text and targetLanguage are required' });
    }

    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 500,
      system:
        `Translate the user's message into ${targetLanguage}. ` +
        'Reply with ONLY the translated text, nothing else — no quotes, no explanation.',
      messages: [{ role: 'user', content: text }],
    });

    const translated = response.content.find((b) => b.type === 'text')?.text?.trim() ?? null;
    res.json({ translated });
  } catch (e) {
    console.error('translate error:', e);
    res.status(500).json({ error: 'Failed to translate' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  CALLS — LiveKit access tokens
// ═════════════════════════════════════════════════════════════════════════
app.post('/livekit-token', checkAuth, async (req, res) => {
  try {
    const { roomName, participantName, identity, displayName } = req.body || {};
    if (!roomName || !participantName) {
      return res.status(400).json({ error: 'roomName and participantName are required' });
    }
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_WS_URL) {
      return res.status(500).json({ error: 'Server is missing LiveKit configuration' });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      // The app sends the user's id as `identity` so each person is unique
      // and the app can map them back to a contact name.
      identity: String(identity || `${participantName}_${Date.now()}`),
      name: String(displayName || participantName),
      ttl: '6h',
    });
    at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });

    const token = await at.toJwt();
    res.json({ token, url: LIVEKIT_WS_URL });
  } catch (e) {
    console.error('livekit-token error:', e);
    res.status(500).json({ error: 'Failed to issue token' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  PUSH — rings a closed phone. The app sends only a callId; everything else
//  (who to ring, who's calling) is read from the real call record in
//  Firestore, so this can't be used to send arbitrary notifications.
// ═════════════════════════════════════════════════════════════════════════
app.post('/api/push/call', checkAuth, async (req, res) => {
  try {
    if (!firebaseReady) {
      return res.status(500).json({ error: 'Push not configured (FIREBASE_SERVICE_ACCOUNT missing or invalid)' });
    }
    const callId = String(req.body?.callId || '');
    if (!callId) return res.status(400).json({ error: 'callId is required' });

    const db = admin.firestore();
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return res.json({ sent: 0, reason: 'no such call' });
    const call = snap.data();
    if (call.status !== 'ringing') return res.json({ sent: 0, reason: 'not ringing' });
    const created = call.createdAt?.toMillis?.() ?? 0;
    if (Date.now() - created > 60 * 1000) return res.json({ sent: 0, reason: 'stale' });

    const calleeIds = (call.calleeIds || []).slice(0, 50);
    const docs = await Promise.all(calleeIds.map((id) => db.collection('fcmTokens').doc(id).get()));
    const entries = docs
      .filter((d) => d.exists && d.data().token)
      .map((d) => ({ id: d.id, token: d.data().token }));
    if (entries.length === 0) return res.json({ sent: 0, reason: 'no tokens' });

    const caller = call.callerName || 'Someone';
    const kind = call.isVideo ? 'video' : 'voice';
    const response = await admin.messaging().sendEachForMulticast({
      tokens: entries.map((e) => e.token),
      notification: {
        title: call.isGroup ? `${call.title || 'Group'} call` : `${caller} is calling`,
        body: `Incoming ${kind} call — tap to answer`,
      },
      data: { type: 'call', callId },
      android: {
        priority: 'high',
        ttl: 45000,
        notification: { sound: 'default', tag: `call_${callId}`, visibility: 'public' },
      },
    });

    // Remove tokens that are no longer valid (app uninstalled, etc.).
    await Promise.all(
      response.responses.map((r, i) => {
        const code = r.error?.code;
        if (code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token') {
          return db.collection('fcmTokens').doc(entries[i].id).delete().catch(() => {});
        }
        return null;
      })
    );

    res.json({ sent: response.successCount, failed: response.failureCount });
  } catch (e) {
    console.error('push/call error:', e);
    res.status(500).json({ error: 'Failed to send push' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`CLOVET backend listening on :${PORT}`);
});
