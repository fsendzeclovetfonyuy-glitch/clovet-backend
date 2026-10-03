# CLOVET Backend

One server for everything CLOVET needs from the cloud:
- **AI features** — smart replies, chat summaries, translation (via Claude)
- **Calls** — LiveKit access tokens for voice/video calls

Replaces the two separate services from before (clovet-ai-backend +
LiveKit token server). One deployment, one URL.

## 1. Get your credentials

**Anthropic (for AI features):**
1. Go to console.anthropic.com → API Keys → create one.

**LiveKit (for calls):**
1. Go to cloud.livekit.io → sign up → create a project.
2. From project settings, grab: API Key, API Secret, WebSocket URL.

## 2. Local test
```
npm install
cp .env.example .env
# fill in .env with your real values
node -r dotenv/config server.js
```
(Or just export the variables in your shell instead of using a .env file
— either works, `.env.example` is just a reference for what's needed.)

Test the AI endpoint:
```
curl -X POST http://localhost:8080/api/ai/translate \
  -H "Content-Type: application/json" \
  -H "X-App-Secret: your-shared-secret" \
  -d '{"text":"Hello, how are you?","targetLanguage":"French"}'
```

Test the call token endpoint:
```
curl -X POST http://localhost:8080/livekit-token \
  -H "Content-Type: application/json" \
  -d '{"roomName":"test-room","participantName":"Sendze","secret":"your-shared-secret"}'
```

## 3. Deploy
1. Push this folder to a GitHub repo (can reuse/rename your existing
   `Clovet--AI-backend` repo — just replace its contents with this folder).
2. Deploy on Render/Railway/Fly.io as a **Web Service**.
3. Set all 5 environment variables from `.env.example` on the host.
4. You'll get a URL like `https://clovet-backend.onrender.com`.

## 4. Point the Flutter app at it
In `main.dart`:
- `AiAssistService._baseUrl` → `https://your-deployed-url/api/ai`
- `AiAssistService._appSecret` → your `APP_SHARED_SECRET` value
- `CallScreen._tokenEndpoint` → `https://your-deployed-url/livekit-token`
- `CallScreen._appSecret` → the SAME `APP_SHARED_SECRET` value

Both `_appSecret` fields should be the same string — the server accepts
it as an `X-App-Secret` header (used by AI calls) or in the JSON body
(used by the call token request), so you don't need to change how either
part of the app sends it.

## Notes
- Free tiers on most hosts sleep after inactivity — first request after
  idle time takes a few seconds while it wakes up. Fine for testing.
- `claude-sonnet-4-5` is set as the model for AI features — change
  `AI_MODEL` in `server.js` if you want a different one.
