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

## Working without network

On first load the phone downloads two small plant-disease models (about 31 MB), the runtime that executes them (14 MB) and a language pack, and keeps them. With no network the app:

- guides the farmer through a field survey: labelled photos (field, plant, leaf, underside, stem, roots, soil), tapped answers and a spoken note;
- gives a first opinion from the leaf photo using the on-device models, with first-aid steps from the language pack;
- keeps the saved plan and its outlook ("what may come next, what to watch for, what to do") readable and audible;
- stores the survey and sends it for the full analysis as soon as the network returns.

The on-device models are open models from Hugging Face trained mostly on laboratory photos. They are a first opinion only and are often unsure on real field photos; the full analysis corrects them.

Language packs for English, Arabic, French, Swahili, Hindi, Spanish and Portuguese are in `packs/`. Other languages are generated on first request, which takes a minute or two.

### The offline assistant

For English speakers the phone also downloads a speech model and a text-matching model (about 100 MB, with a progress bar). With no network the farmer taps the orb and speaks; the phone turns the speech into text, compares the words with known symptom descriptions, combines that with the photo judgement, and speaks advice prepared in advance.

In other languages the phone judges the photo, keeps the voice recording, and has it transcribed with the full analysis when the network returns. The on-device speech model was tested in Arabic and Swahili and was not usable.

Small general-purpose language models (a 500M vision-language model and a 1B text model) were tested for this role and rejected: they misread diseased leaves, could not match symptoms, and one invented a pesticide name.

- `public/llm.js` — on-device speech understanding, symptom matching and the offline conversation.
- `public/offline.js` — on-device models, guided survey, saved surveys and sync.
- `offline-pack.js` — source text of the survey and the list of conditions.
