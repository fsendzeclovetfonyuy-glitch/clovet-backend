/**
 * CLOVET Backend — one server for everything CLOVET needs from the cloud:
 *
 *   /api/ai/smart-replies   → suggested quick replies (Claude)
 *   /api/ai/summarize       → chat summaries, 1:1 and group (Claude)
 *   /api/ai/translate       → message translation (Claude)
 *   /livekit-token          → signed tokens so the app can join calls
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
const multer = require('multer');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
app.use(express.json({ limit: '2mb' }));

// Holds an uploaded file in memory (not disk) — fine at these size limits,
// and simpler than managing upload dirs on an ephemeral host like Render.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 60 * 1024 * 1024 }, // 60MB — generous enough for a short video
});

// ── Config — set these as environment variables on your host ────────────
const APP_SHARED_SECRET = process.env.APP_SHARED_SECRET || 'CHANGE_ME';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY;
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL;

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
    const { roomName, participantName } = req.body || {};
    if (!roomName || !participantName) {
      return res.status(400).json({ error: 'roomName and participantName are required' });
    }
    if (!LIVEKIT_API_KEY || !LIVEKIT_API_SECRET || !LIVEKIT_WS_URL) {
      return res.status(500).json({ error: 'Server is missing LiveKit configuration' });
    }

    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: `${participantName}_${Date.now()}`,
      name: participantName,
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
//  CONTENT MODERATION — explicit-content check on photo/video uploads
// ═════════════════════════════════════════════════════════════════════════
// Sends the image (or a sampled video frame) to Claude's vision and asks
// for a flagged/not-flagged classification. Response shape matches what
// ContentModerationService in the Flutter app expects: {"flagged": bool}.
async function classifyImageBuffer(buffer, mimeType) {
  if (!anthropic) throw new Error('AI not configured');
  const response = await anthropic.messages.create({
    model: AI_MODEL,
    max_tokens: 20,
    system:
      'You are a content moderation classifier for a social/messaging app. ' +
      'Look at the image and decide if it contains pornographic or sexually ' +
      'explicit content. Reply with ONLY a JSON object, nothing else: ' +
      '{"flagged": true} or {"flagged": false}.',
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: buffer.toString('base64') },
          },
          { type: 'text', text: 'Classify this image.' },
        ],
      },
    ],
  });
  const text = response.content.find((b) => b.type === 'text')?.text ?? '{"flagged":false}';
  try {
    const parsed = JSON.parse(text.trim());
    return parsed.flagged === true;
  } catch {
    // If Claude didn't return clean JSON, fail safe (treat as flagged) rather
    // than silently letting unmoderated content through.
    return true;
  }
}

function mimeTypeFor(originalname, fallback) {
  const ext = path.extname(originalname || '').toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  return fallback;
}

app.post('/moderate/image', checkAuth, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const mimeType = mimeTypeFor(req.file.originalname, 'image/jpeg');
    const flagged = await classifyImageBuffer(req.file.buffer, mimeType);
    res.json({ flagged });
  } catch (e) {
    console.error('moderate/image error:', e);
    res.status(500).json({ error: 'Failed to check image' });
  }
});

app.post('/moderate/video', checkAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  // Video frames aren't readable by the vision model directly, so we pull
  // one frame (~1s in, to skip a possible black first frame) with ffmpeg
  // and classify that the same way as a photo. Not frame-by-frame
  // coverage, but catches the common case at negligible cost/latency.
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `${crypto.randomUUID()}-in`);
  const outPath = path.join(tmpDir, `${crypto.randomUUID()}-frame.jpg`);

  try {
    await fs.promises.writeFile(inPath, req.file.buffer);

    await new Promise((resolve, reject) => {
      ffmpeg(inPath)
        .on('end', resolve)
        .on('error', reject)
        .screenshots({ timestamps: ['1'], filename: path.basename(outPath), folder: tmpDir, size: '512x?' });
    });

    const frameBuffer = await fs.promises.readFile(outPath);
    const flagged = await classifyImageBuffer(frameBuffer, 'image/jpeg');
    res.json({ flagged });
  } catch (e) {
    console.error('moderate/video error:', e);
    res.status(500).json({ error: 'Failed to check video' });
  } finally {
    fs.promises.unlink(inPath).catch(() => {});
    fs.promises.unlink(outPath).catch(() => {});
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`CLOVET backend listening on :${PORT}`);
});
