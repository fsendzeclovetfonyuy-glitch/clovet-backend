'use strict';
// CLOVET backend — one server for: call pushes, message pushes, LiveKit tokens
// and the AI helpers. Deploy by replacing server.js and package.json on GitHub.

const crypto = require('crypto');
const express = require('express');
const cors = require('cors');

// ── Environment ─────────────────────────────────────────────────────────────
const SECRET = process.env.APP_SHARED_SECRET || '';
// LiveKit settings: the exact names are preferred, but any variable starting
// with LIVEKIT that looks like the url / api key / api secret is accepted.
function findLivekit(exact, test) {
  if (process.env[exact]) return { name: exact, value: process.env[exact].trim() };
  for (const k of Object.keys(process.env)) {
    if (/^LIVEKIT/i.test(k) && test(k.toUpperCase()) && process.env[k]) {
      return { name: k, value: process.env[k].trim() };
    }
  }
  return { name: '', value: '' };
}
const lkUrl = findLivekit('LIVEKIT_URL', (k) => /URL|HOST|WS|SERVER/.test(k) && !/KEY|SECRET/.test(k));
const lkSecret = findLivekit('LIVEKIT_API_SECRET', (k) => /SECRET/.test(k));
const lkKey = findLivekit('LIVEKIT_API_KEY', (k) => /KEY|ID/.test(k) && !/SECRET/.test(k));
let LIVEKIT_URL = lkUrl.value;
if (LIVEKIT_URL) {
  LIVEKIT_URL = LIVEKIT_URL.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://');
  if (!/^wss?:\/\//i.test(LIVEKIT_URL)) LIVEKIT_URL = 'wss://' + LIVEKIT_URL;
}
const LIVEKIT_API_KEY = lkKey.value;
const LIVEKIT_API_SECRET = lkSecret.value;
console.log(
  `LiveKit settings found -> url: ${lkUrl.name || 'MISSING'}, key: ${lkKey.name || 'MISSING'}, secret: ${lkSecret.name || 'MISSING'}`
);
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';

for (const name of [
  'APP_SHARED_SECRET',
  'FIREBASE_SERVICE_ACCOUNT',
  'ANTHROPIC_API_KEY',
]) {
  if (!process.env[name]) console.error(`MISSING environment variable: ${name}`);
}

// ── Firebase admin ──────────────────────────────────────────────────────────
let admin = null;
let db = null;
let fcm = null;
try {
  admin = require('firebase-admin');
  let raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set');
  raw = raw.trim();
  if (!raw.startsWith('{')) raw = Buffer.from(raw, 'base64').toString('utf8');
  const sa = JSON.parse(raw);
  if (sa.private_key) sa.private_key = sa.private_key.replace(/\\n/g, '\n');
  admin.initializeApp({ credential: admin.credential.cert(sa) });
  db = admin.firestore();
  fcm = admin.messaging();
  console.log('Firebase admin ready');
} catch (e) {
  console.error('Firebase admin NOT ready:', e.message);
}

// ── Small helpers ───────────────────────────────────────────────────────────
const str = (v) => (v === undefined || v === null ? '' : String(v));

function safeEqual(a, b) {
  const x = Buffer.from(str(a));
  const y = Buffer.from(str(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function authed(req) {
  if (!SECRET) return false;
  const given = (req.body && req.body.secret) || req.get('X-App-Secret') || '';
  return safeEqual(given, SECRET);
}

function requireAuth(req, res, next) {
  if (!authed(req)) {
    const given = (req.body && req.body.secret) || req.get('X-App-Secret') || '';
    console.error(
      `401 on ${req.path}: ` +
        (!SECRET ? 'APP_SHARED_SECRET is not set on the server' : given ? 'secret from the app does not match Render' : 'the app sent NO secret (start it with --dart-define=APP_SHARED_SECRET=...)')
    );
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

function requireFirebase(req, res, next) {
  if (!db || !fcm) return res.status(503).json({ error: 'firebase not ready' });
  next();
}

// ── Push sending ────────────────────────────────────────────────────────────
async function tokenFor(uid) {
  if (!uid) return null;
  const snap = await db.collection('fcmTokens').doc(uid).get();
  return snap.exists ? snap.data().token || null : null;
}

// Returns 'ok' | 'no-token' | 'failed'. Never throws.
async function sendPush(uid, message) {
  try {
    const token = await tokenFor(uid);
    if (!token) return 'no-token';
    await fcm.send({ token, ...message });
    return 'ok';
  } catch (e) {
    console.error(`fcm send to ${uid}: ${e.code || ''} ${e.message}`);
    if (
      e.code === 'messaging/registration-token-not-registered' ||
      e.code === 'messaging/invalid-registration-token'
    ) {
      db.collection('fcmTokens')
        .doc(uid)
        .set({ token: admin.firestore.FieldValue.delete() }, { merge: true })
        .catch(() => {});
    }
    return 'failed';
  }
}

// Calls are data-only, high priority: the phone's own CLOVET code (not the
// system) decides how to ring, so it works with the app closed or locked.
function callData(callId, d) {
  return {
    type: 'call',
    callId,
    callerId: str(d.callerId),
    callerName: str(d.callerName),
    isVideo: d.isVideo === true ? 'true' : 'false',
    isGroup: d.isGroup === true ? 'true' : 'false',
    title: str(d.title),
  };
}

function chatPreview(msgType, text) {
  switch (str(msgType).toLowerCase()) {
    case 'image':
      return '📷 Photo';
    case 'video':
      return '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'audio':
      return '🎵 Audio';
    case 'document':
    case 'file':
      return '📄 Document';
    case 'poll':
      return '📊 Poll';
    default:
      return str(text) || 'New message';
  }
}

async function nameOf(uid) {
  try {
    const s = await db.collection('publicUsers').doc(uid).get();
    const n = s.exists ? str(s.data().name) : '';
    return n || 'CLOVET user';
  } catch (_) {
    return 'CLOVET user';
  }
}

function notifyMessage(title, body, tag, data) {
  return {
    notification: { title: str(title), body: str(body).slice(0, 180) },
    data: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, str(v)])),
    android: {
      priority: 'high',
      ttl: 24 * 3600 * 1000,
      notification: { channelId: 'clovet_messages', tag: str(tag), sound: 'default' },
    },
  };
}

// ── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.get('/', (_req, res) => res.send('CLOVET backend'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ── LiveKit token ───────────────────────────────────────────────────────────
app.post('/livekit-token', requireAuth, async (req, res) => {
  try {
    if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
      console.error('livekit-token: LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET missing on Render');
      return res.status(500).json({ error: 'livekit not configured' });
    }
    const { roomName, identity, participantName, displayName } = req.body || {};
    const id = str(identity || participantName);
    if (!roomName || !id) return res.status(400).json({ error: 'roomName and identity required' });
    const { AccessToken } = require('livekit-server-sdk');
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: id,
      name: str(displayName || participantName || id),
      ttl: '2h',
    });
    at.addGrant({ roomJoin: true, room: str(roomName), canPublish: true, canSubscribe: true });
    const token = await at.toJwt();
    console.log(`livekit-token issued: room ${str(roomName)} for ${id} -> ${LIVEKIT_URL}`);
    res.json({ token, url: LIVEKIT_URL });
  } catch (e) {
    console.error('livekit-token:', e.message);
    res.status(500).json({ error: 'token failed' });
  }
});

// ── Call push: wake every phone being called ────────────────────────────────
app.post('/api/push/call', requireAuth, requireFirebase, async (req, res) => {
  try {
    const callId = str(req.body && req.body.callId);
    if (!callId) return res.status(400).json({ error: 'callId required' });
    const snap = await db.collection('calls').doc(callId).get();
    if (!snap.exists) return res.status(404).json({ error: 'call not found' });
    const d = snap.data();
    if (d.status !== 'ringing') return res.json({ ok: true, skipped: 'not ringing' });
    const ids = (Array.isArray(d.calleeIds) ? d.calleeIds : []).filter((u) => u && u !== d.callerId);
    const message = {
      data: callData(callId, d),
      android: { priority: 'high', ttl: 45 * 1000 },
    };
    const results = await Promise.all(ids.map((uid) => sendPush(uid, message)));
    const sent = results.filter((r) => r === 'ok').length;
    console.log(`call ${callId}: pushed ${sent}/${ids.length} (${results.join(',')})`);
    res.json({ ok: true, sent, total: ids.length });
  } catch (e) {
    console.error('push/call:', e.message);
    res.status(500).json({ error: 'push failed' });
  }
});

// When a call stops ringing (answered, declined, cancelled, deleted) tell the
// called phones to stop ringing — this is what silences a closed app's alert.
function watchCalls() {
  if (!db) return;
  try {
    db.collection('calls')
      .where('status', '==', 'ringing')
      .onSnapshot(
        (snap) => {
          snap.docChanges().forEach((ch) => {
            if (ch.type !== 'removed') return;
            const d = ch.doc.data() || {};
            const ids = Array.isArray(d.calleeIds) ? d.calleeIds : [];
            ids.forEach((uid) =>
              sendPush(uid, {
                data: { type: 'callEnded', callId: ch.doc.id },
                android: { priority: 'high', ttl: 30 * 1000 },
              })
            );
          });
        },
        (err) => {
          console.error('calls watcher error:', err.message);
          setTimeout(watchCalls, 5000);
        }
      );
  } catch (e) {
    console.error('calls watcher failed to start:', e.message);
  }
}

// ── Message / friend-request pushes ─────────────────────────────────────────
const seenEvents = new Map(); // dedupe repeated taps from the app
function firstTime(key) {
  const now = Date.now();
  for (const [k, t] of seenEvents) if (now - t > 10 * 60 * 1000) seenEvents.delete(k);
  if (seenEvents.has(key)) return false;
  seenEvents.set(key, now);
  return true;
}

app.post('/api/push/event', requireAuth, requireFirebase, async (req, res) => {
  try {
    const { type, id, chatId, groupId } = req.body || {};
    if (!type || !id) return res.status(400).json({ error: 'type and id required' });
    if (!firstTime(`${type}:${chatId || groupId || ''}:${id}`)) return res.json({ ok: true, dup: true });

    if (type === 'chat') {
      const snap = await db.collection('chats').doc(str(chatId)).collection('messages').doc(str(id)).get();
      if (!snap.exists) return res.status(404).json({ error: 'message not found' });
      const m = snap.data();
      if (!m.to || !m.from) return res.json({ ok: true });
      if (m.visibleTo && m.visibleTo !== m.to) return res.json({ ok: true, skipped: 'private' });
      const name = await nameOf(m.from);
      const r = await sendPush(
        m.to,
        notifyMessage(name, chatPreview(m.msgType, m.text), str(chatId), { type: 'chat', chatId, senderId: m.from, id })
      );
      return res.json({ ok: true, result: r });
    }

    if (type === 'group') {
      const gRef = db.collection('groups').doc(str(groupId));
      const [gSnap, mSnap] = await Promise.all([gRef.get(), gRef.collection('messages').doc(str(id)).get()]);
      if (!gSnap.exists || !mSnap.exists) return res.status(404).json({ error: 'not found' });
      const g = gSnap.data();
      const m = mSnap.data();
      const name = await nameOf(m.from);
      const members = (Array.isArray(g.memberIds) ? g.memberIds : []).filter((u) => u && u !== m.from);
      const body = `${name}: ${chatPreview(m.msgType, m.text)}`;
      const results = await Promise.all(
        members.map((uid) =>
          sendPush(uid, notifyMessage(str(g.name) || 'Group', body, str(groupId), { type: 'group', groupId, senderId: m.from, id }))
        )
      );
      return res.json({ ok: true, sent: results.filter((r) => r === 'ok').length });
    }

    if (type === 'friendRequest' || type === 'friendAccepted') {
      const snap = await db.collection('friendRequests').doc(str(id)).get();
      if (!snap.exists) return res.status(404).json({ error: 'request not found' });
      const r = snap.data();
      if (type === 'friendRequest') {
        const out = await sendPush(
          r.to,
          notifyMessage('Friend request', `${str(r.fromName) || 'Someone'} sent you a friend request`, `fr_${id}`, {
            type: 'friendRequest',
            id,
          })
        );
        return res.json({ ok: true, result: out });
      }
      const out = await sendPush(
        r.from,
        notifyMessage('Friend request accepted', `${str(r.toName) || 'Someone'} accepted your friend request`, `fa_${id}`, {
          type: 'friendAccepted',
          id,
        })
      );
      return res.json({ ok: true, result: out });
    }

    res.status(400).json({ error: 'unknown type' });
  } catch (e) {
    console.error('push/event:', e.message);
    res.status(500).json({ error: 'push failed' });
  }
});

// ── AI helpers (Claude) ─────────────────────────────────────────────────────
async function askClaude(system, user, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(j.error && j.error.message) || 'error'}`);
  return (j.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function transcript(messages, withSender) {
  return (Array.isArray(messages) ? messages : [])
    .slice(-60)
    .map((m) => {
      const who = m.fromMe ? 'Me' : withSender && m.sender ? m.sender : 'Them';
      return `${who}: ${str(m.text).slice(0, 500)}`;
    })
    .join('\n');
}

app.post('/api/ai/smart-replies', requireAuth, async (req, res) => {
  try {
    const convo = transcript(req.body && req.body.messages, false);
    if (!convo) return res.json({ replies: [] });
    const out = await askClaude(
      'You write quick-reply suggestions for a chat app. Reply ONLY with a JSON array of 3 short replies (max 6 words each) that "Me" could send next, in the same language as the conversation. No other text.',
      convo,
      200
    );
    let replies = [];
    try {
      const m = out.match(/\[[\s\S]*\]/);
      replies = JSON.parse(m ? m[0] : out).map(str).filter(Boolean).slice(0, 4);
    } catch (_) {}
    res.json({ replies });
  } catch (e) {
    console.error('smart-replies:', e.message);
    res.status(500).json({ error: 'ai failed' });
  }
});

app.post('/api/ai/summarize', requireAuth, async (req, res) => {
  try {
    const convo = transcript(req.body && req.body.messages, true);
    if (!convo) return res.json({ summary: '' });
    const summary = await askClaude(
      'Summarize this chat conversation in 2-4 short sentences so someone can catch up quickly. Mention who said what when it matters. Use the conversation\'s language. No preamble.',
      convo,
      400
    );
    res.json({ summary });
  } catch (e) {
    console.error('summarize:', e.message);
    res.status(500).json({ error: 'ai failed' });
  }
});

app.post('/api/ai/translate', requireAuth, async (req, res) => {
  try {
    const text = str(req.body && req.body.text).slice(0, 2000);
    const lang = str(req.body && req.body.targetLanguage) || 'English';
    if (!text) return res.json({ translated: '' });
    const translated = await askClaude(
      `Translate the user's message into ${lang}. Reply with ONLY the translation, nothing else.`,
      text,
      800
    );
    res.json({ translated });
  } catch (e) {
    console.error('translate:', e.message);
    res.status(500).json({ error: 'ai failed' });
  }
});

// ── Start ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
  console.log(`CLOVET backend listening on ${PORT}`);
  watchCalls();
});
