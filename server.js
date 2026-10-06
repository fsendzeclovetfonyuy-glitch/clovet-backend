'use strict';
// CLOVET backend — one server for: AI (smart replies / summarize / translate),
// LiveKit call tokens, call push, and message / group / friend-request push.
//
// Needs only: express, firebase-admin, livekit-server-sdk (Node 18+).
//
// Render environment variables used:
//   APP_SHARED_SECRET          must match --dart-define=APP_SHARED_SECRET in the app
//   ANTHROPIC_API_KEY          for the AI features
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET, LIVEKIT_URL
//   FIREBASE_SERVICE_ACCOUNT   the service-account JSON (as text)

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const { AccessToken } = require('livekit-server-sdk');

const PORT = process.env.PORT || 3000;
const APP_SECRET = process.env.APP_SHARED_SECRET || process.env.APP_SECRET || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY || '';
const AI_MODEL = process.env.AI_MODEL || 'claude-haiku-4-5-20251001';
const LK_KEY = process.env.LIVEKIT_API_KEY || '';
const LK_SECRET = process.env.LIVEKIT_API_SECRET || '';
const LK_URL = process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || '';

// ───────────────────────── Firebase ─────────────────────────
let db = null;
let fcm = null;
try {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (raw) {
    const text = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
    const cred = JSON.parse(text);
    if (cred.private_key) cred.private_key = cred.private_key.replace(/\\n/g, '\n');
    admin.initializeApp({ credential: admin.credential.cert(cred) });
    db = admin.firestore();
    fcm = admin.messaging();
    console.log('Firebase admin ready');
  } else {
    console.warn('FIREBASE_SERVICE_ACCOUNT is not set — push is disabled');
  }
} catch (e) {
  console.error('Firebase init failed:', e.message);
}

// ───────────────────────── App ─────────────────────────
const app = express();
app.use(express.json({ limit: '2mb' }));

function authorized(req) {
  if (!APP_SECRET) return true;
  const got = String(req.get('X-App-Secret') || (req.body && req.body.secret) || '');
  const a = Buffer.from(got);
  const b = Buffer.from(APP_SECRET);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.get('/', (_req, res) => res.send('CLOVET backend'));
app.get('/health', (_req, res) => res.json({ ok: true }));

// ───────────────────────── LiveKit token ─────────────────────────
app.post('/livekit-token', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { roomName, identity, participantName, displayName } = req.body || {};
    const id = String(identity || participantName || '').trim();
    if (!roomName || !id) return res.status(400).json({ error: 'roomName and identity required' });
    if (!LK_KEY || !LK_SECRET || !LK_URL) {
      return res.status(500).json({ error: 'LiveKit is not configured on the server' });
    }
    const at = new AccessToken(LK_KEY, LK_SECRET, {
      identity: id,
      name: String(displayName || participantName || id),
      ttl: '2h',
    });
    at.addGrant({
      roomJoin: true,
      room: String(roomName),
      canPublish: true,
      canSubscribe: true,
    });
    const token = await at.toJwt();
    res.json({ token, url: LK_URL });
  } catch (e) {
    console.error('livekit-token:', e);
    res.status(500).json({ error: 'token failed' });
  }
});

// ───────────────────────── AI ─────────────────────────
async function askClaude(system, userText, maxTokens) {
  if (!ANTHROPIC_KEY) throw new Error('ANTHROPIC_API_KEY is not set');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: AI_MODEL,
      max_tokens: maxTokens || 300,
      system,
      messages: [{ role: 'user', content: userText }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return (j.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
}

function transcript(messages, limit) {
  const list = Array.isArray(messages) ? messages.slice(-limit) : [];
  return list
    .map((m) => {
      const who = m.sender ? String(m.sender) : m.fromMe ? 'Me' : 'Them';
      return `${who}: ${String(m.text || '').slice(0, 500)}`;
    })
    .filter((l) => !l.endsWith(': '))
    .join('\n');
}

app.post('/api/ai/smart-replies', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const convo = transcript(req.body && req.body.messages, 12);
    if (!convo) return res.json({ replies: [] });
    const out = await askClaude(
      'You suggest quick chat replies. Given a conversation, write 3 short, natural replies (max 8 words each) that "Me" could send next. ' +
        'Match the language of the conversation. Reply with ONLY a JSON array of strings, nothing else.',
      convo,
      200
    );
    let replies = [];
    try {
      const start = out.indexOf('[');
      const end = out.lastIndexOf(']');
      replies = JSON.parse(out.slice(start, end + 1));
    } catch (_) {
      replies = out.split('\n').map((s) => s.replace(/^[-*\d.\s"]+|"+,?$/g, '').trim()).filter(Boolean);
    }
    replies = replies.filter((s) => typeof s === 'string' && s.trim()).slice(0, 4);
    res.json({ replies });
  } catch (e) {
    console.error('smart-replies:', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/api/ai/summarize', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const convo = transcript(req.body && req.body.messages, 80);
    if (!convo) return res.json({ summary: 'Nothing to summarize yet.' });
    const summary = await askClaude(
      'Summarize this chat so someone can catch up quickly. Be brief (2-5 short sentences or bullets), mention who said what when it matters, ' +
        'and use the language of the conversation.',
      convo,
      400
    );
    res.json({ summary });
  } catch (e) {
    console.error('summarize:', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

app.post('/api/ai/translate', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  try {
    const { text, targetLanguage } = req.body || {};
    if (!text || !targetLanguage) return res.status(400).json({ error: 'text and targetLanguage required' });
    const translated = await askClaude(
      `Translate the user's message into ${String(targetLanguage).slice(0, 40)}. Reply with ONLY the translation, no quotes or notes.`,
      String(text).slice(0, 2000),
      600
    );
    res.json({ translated });
  } catch (e) {
    console.error('translate:', e.message);
    res.status(500).json({ error: 'failed' });
  }
});

// ───────────────────────── Push helpers ─────────────────────────
const recentlySent = new Map(); // dedupe key -> time
function firstTime(key) {
  const now = Date.now();
  for (const [k, t] of recentlySent) if (now - t > 10 * 60 * 1000) recentlySent.delete(k);
  if (recentlySent.has(key)) return false;
  recentlySent.set(key, now);
  return true;
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function strMap(o) {
  const out = {};
  for (const k of Object.keys(o || {})) out[k] = String(o[k] == null ? '' : o[k]);
  return out;
}

async function nameOf(uid) {
  try {
    const d = await db.collection('publicUsers').doc(uid).get();
    const n = d.exists ? (d.data().name || '').toString().trim() : '';
    return n || 'CLOVET user';
  } catch (_) {
    return 'CLOVET user';
  }
}

// kind 'call' rings loudly on the "calls" channel; everything else is a
// high-importance heads-up banner on the "messages" channel.
async function sendToUser(uid, { title, body, kind, data }) {
  if (!fcm || !db || !uid) return false;
  let token = null;
  try {
    const d = await db.collection('fcmTokens').doc(uid).get();
    token = d.exists ? d.data().token : null;
  } catch (e) {
    console.error('token read:', e.message);
  }
  if (!token) return false;
  const isCall = kind === 'call';
  const message = {
    token,
    notification: { title: clip(title, 80), body: clip(body, 180) },
    data: strMap(data),
    android: {
      priority: 'high',
      ...(isCall ? { ttl: 45000 } : {}),
      notification: {
        channelId: isCall ? 'calls' : 'messages',
        sound: 'default',
        priority: isCall ? 'max' : 'high',
        visibility: 'public',
        defaultVibrateTimings: true,
      },
    },
    apns: {
      headers: { 'apns-priority': '10' },
      payload: { aps: { sound: 'default' } },
    },
  };
  try {
    await fcm.send(message);
    return true;
  } catch (e) {
    const code = e && e.code ? String(e.code) : '';
    console.error('fcm send:', code || e.message);
    if (code.includes('registration-token-not-registered') || code.includes('invalid-registration-token')) {
      db.collection('fcmTokens').doc(uid).delete().catch(() => {});
    }
    return false;
  }
}

function previewFor(m) {
  const t = String(m.msgType || 'text');
  const caption = m.caption ? ` ${m.caption}` : '';
  switch (t) {
    case 'image': return '📷 Photo' + caption;
    case 'video': return '🎥 Video' + caption;
    case 'voice': return '🎤 Voice message';
    case 'audio': return '🎵 Audio';
    case 'document':
    case 'file': return '📄 ' + (m.fileName || 'File');
    case 'poll': return '📊 Poll: ' + (m.text || '');
    default: return m.text || 'New message';
  }
}

function isFresh(ts, maxMs) {
  if (!ts || typeof ts.toMillis !== 'function') return true;
  return Date.now() - ts.toMillis() <= maxMs;
}

// ───────────────────────── Call push ─────────────────────────
async function handleCallPush(callId) {
  const snap = await db.collection('calls').doc(callId).get();
  if (!snap.exists) return;
  const c = snap.data();
  if (c.status !== 'ringing') return;
  if (!isFresh(c.createdAt, 60 * 1000)) return;
  if (!firstTime('call:' + callId)) return;
  const isVideo = c.isVideo === true;
  const kindText = isVideo ? 'Video call' : 'Voice call';
  const callerName = c.callerName || (await nameOf(c.callerId));
  const title = c.isGroup ? `${callerName} started a group call` : `${callerName} is calling`;
  const body = c.isGroup && c.title ? `${c.title} · ${kindText}` : `Incoming ${kindText.toLowerCase()}`;
  const callees = Array.isArray(c.calleeIds) ? c.calleeIds : [];
  await Promise.all(
    callees
      .filter((u) => u && u !== c.callerId)
      .map((u) => sendToUser(u, { title, body, kind: 'call', data: { type: 'call', callId } }))
  );
}

app.post('/api/push/call', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  const callId = String((req.body && req.body.callId) || '').trim();
  if (!callId) return res.status(400).json({ error: 'callId required' });
  if (!db) return res.status(503).json({ error: 'push not configured' });
  res.json({ ok: true });
  try {
    await handleCallPush(callId);
  } catch (e) {
    console.error('push/call:', e.message);
  }
});

// ───────────────────────── Message / group / friend push ─────────────────────────
async function handleEvent(ev) {
  const type = String(ev.type || '');
  const id = String(ev.id || '').trim();
  if (!id) return;

  if (type === 'chat') {
    const chatId = String(ev.chatId || '').trim();
    if (!chatId || !firstTime(`chat:${chatId}:${id}`)) return;
    const s = await db.collection('chats').doc(chatId).collection('messages').doc(id).get();
    if (!s.exists) return;
    const m = s.data();
    if (!m.from || !m.to || m.from === m.to) return;
    if (!isFresh(m.createdAt, 10 * 60 * 1000)) return;
    const sender = await nameOf(m.from);
    await sendToUser(m.to, {
      title: sender,
      body: previewFor(m),
      kind: 'message',
      data: { type: 'chat', chatId, from: m.from, messageId: id },
    });
    return;
  }

  if (type === 'group') {
    const groupId = String(ev.groupId || '').trim();
    if (!groupId || !firstTime(`group:${groupId}:${id}`)) return;
    const gs = await db.collection('groups').doc(groupId).get();
    if (!gs.exists) return;
    const g = gs.data();
    const members = Array.isArray(g.memberIds) ? g.memberIds : [];
    const ms = await db.collection('groups').doc(groupId).collection('messages').doc(id).get();
    if (!ms.exists) return;
    const m = ms.data();
    if (!m.from || !members.includes(m.from)) return;
    if (!isFresh(m.createdAt, 10 * 60 * 1000)) return;
    const sender = await nameOf(m.from);
    const groupName = g.name || 'Group';
    await Promise.all(
      members
        .filter((u) => u && u !== m.from)
        .map((u) =>
          sendToUser(u, {
            title: groupName,
            body: `${sender}: ${previewFor(m)}`,
            kind: 'message',
            data: { type: 'group', groupId, from: m.from, messageId: id },
          })
        )
    );
    return;
  }

  if (type === 'friendRequest' || type === 'friendAccepted') {
    if (!firstTime(`${type}:${id}`)) return;
    const s = await db.collection('friendRequests').doc(id).get();
    if (!s.exists) return;
    const r = s.data();
    if (type === 'friendRequest') {
      if (r.status !== 'pending' || !r.to) return;
      await sendToUser(r.to, {
        title: 'New friend request',
        body: `${r.fromName || 'Someone'} sent you a friend request`,
        kind: 'message',
        data: { type: 'friendRequest', requestId: id, from: r.from },
      });
    } else {
      if (r.status !== 'accepted' || !r.from) return;
      await sendToUser(r.from, {
        title: 'Friend request accepted',
        body: `${r.toName || 'Someone'} accepted your friend request`,
        kind: 'message',
        data: { type: 'friendAccepted', requestId: id, from: r.to },
      });
    }
  }
}

app.post('/api/push/event', async (req, res) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  if (!db) return res.status(503).json({ error: 'push not configured' });
  res.json({ ok: true });
  try {
    await handleEvent(req.body || {});
  } catch (e) {
    console.error('push/event:', e.message);
  }
});

app.listen(PORT, () => console.log(`CLOVET backend listening on ${PORT}`));
