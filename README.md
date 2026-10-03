# AgriConnect

A voice-and-camera field agronomist for smallholder farmers. The farmer opens the app, talks in their own language and points the phone at the crop. The assistant guides them to show what it needs (leaf underside, roots, soil, the whole field), diagnoses the problem, saves a dated plan with reminders, estimates the harvest, and builds a farm record the farmer can share with a micro-finance lender.

## Run locally

```
npm install
npm start
```

Create a `.env` file first:

```
ANTHROPIC_API_KEY=...
ELEVENLABS_API_KEY=...
```

Open `http://localhost:3000` in Chrome.

## Deploy

Any Node host works (Node 20.12 or newer). Build command `npm install`, start command `npm start`. The server listens on `PORT`.

Environment variables:

| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | yes | Diagnosis and conversation |
| `ELEVENLABS_API_KEY` | no | Natural voice and fallback speech recognition; without it the phone's own voice is used |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | recommended | Fixed push-notification keys so reminders keep working after a redeploy. Generate with `npx web-push generate-vapid-keys` |
| `AGRI_DATA_DIR` | recommended | Folder on a persistent disk for farmer plans and records. Without one, data is lost when the host restarts |
| `AGRI_EFFORT` | no | `low` (default, fastest) or `medium` |
| `AGRI_TTS_DAILY_CHARS` | no | Daily cap on spoken characters, default 40000 |

The phone needs HTTPS for the camera and microphone, which hosted deployments provide.

## How it works

- `server.js` — HTTP server, conversation loop, plan reminders (web push), voice proxy, farm record page.
- `prompt.js` — the agronomy method and the tools the assistant uses.
- `public/` — the phone app: camera, speech recognition, voice playback, plan sheet.
