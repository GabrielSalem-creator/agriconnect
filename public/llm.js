"use strict";

// The offline assistant: models that run on the phone itself so the farmer can still talk, show
// the plant and get an answer with no network. They are downloaded once, with a visible progress
// bar, and kept on the phone.
//
//  - a speech model turns the farmer's spoken English into text (in testing it was reliable for
//    English only, so other languages keep the recording for the server to transcribe later);
//  - a text-matching model compares those words with the known symptom descriptions;
//  - the image models (offline.js) judge the photo;
//  - the two judgements are combined, and the farmer hears advice that was written in advance
//    in their language.
//
// Small general-purpose language models were tried here and rejected: at a size a phone browser
// can hold, they misread diseased leaves and invented product names.

const ASR_ID = "onnx-community/whisper-base";
const ASR_DTYPE = { encoder_model: "q8", decoder_model_merged: "q8" };
const EMB_ID = "Xenova/all-MiniLM-L6-v2";
const LLM_TOTAL_MB = 100;

let tf = null;          // the model library
let asr = null;         // speech to English text
let embed = null;       // text to meaning vector
let llmLoading = null;
let offlineBusy = false;
let englishPack = null; // symptom descriptions the matcher compares against
const conditionVectors = new Map();

const llmDownloaded = () => store.get("assistant") === "1";

function showDownload(fraction, label) {
  $("llmCard").hidden = false;
  $("llmGet").hidden = true;
  $("llmBar").hidden = false;
  $("llmFill").style.width = `${Math.round(fraction * 100)}%`;
  $("llmText").textContent = label;
}

// Loads the models, downloading them the first time. Resolves true when the assistant is usable.
function loadLLM() {
  if (asr && embed) return Promise.resolve(true);
  if (llmLoading) return llmLoading;
  const firstTime = !llmDownloaded();
  const files = new Map();
  const onProgress = (p) => {
    if (!firstTime || p.status !== "progress" || !p.total) return;
    files.set(p.file, p.loaded);
    const mb = [...files.values()].reduce((a, b) => a + b, 0) / 1e6;
    showDownload(Math.min(0.99, mb / LLM_TOTAL_MB), `🧠 ⬇️ ${Math.round(mb)} / ${LLM_TOTAL_MB} MB`);
  };
  llmLoading = (async () => {
    try {
      if (firstTime) showDownload(0, `🧠 ⬇️ 0 / ${LLM_TOTAL_MB} MB`);
      tf ??= await import("https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/dist/transformers.min.js");
      tf.env.allowLocalModels = false;
      englishPack ??= await fetch("/api/pack?lang=en-US").then((r) => r.json()).then(
        (p) => {
          if (p && p.conditions && Object.keys(p.conditions).length) store.set("pack:en-US", JSON.stringify(p));
          return p;
        },
        () => JSON.parse(store.get("pack:en-US")),
      );
      embed = await tf.pipeline("feature-extraction", EMB_ID, { dtype: "q8", device: "wasm", progress_callback: onProgress });
      asr = await tf.pipeline("automatic-speech-recognition", ASR_ID, { dtype: ASR_DTYPE, device: "wasm", progress_callback: onProgress });
      store.set("assistant", "1");
      // Keep the runtime files the library fetched, so it starts with no network next time.
      const fetched = performance.getEntriesByType("resource").map((r) => r.name).filter((u) => u.includes("cdn.jsdelivr.net"));
      if (fetched.length) caches.open("agriconnect-vendor-v1").then((c) => c.addAll(fetched)).catch(() => {});
      if (firstTime) {
        showDownload(1, "🧠 ✓");
        setTimeout(() => ($("llmCard").hidden = true), 2500);
      }
      return true;
    } catch (err) {
      console.error("offline assistant:", err);
      asr = embed = null;
      if (firstTime) {
        $("llmBar").hidden = true;
        $("llmGet").hidden = false;
        $("llmText").textContent = "🧠 ⚠️";
      }
      return false;
    } finally {
      llmLoading = null;
    }
  })();
  return llmLoading;
}

const speaksEnglish = () => lang.toLowerCase().startsWith("en");

// Start the one-time download once the app is running, unless the connection is slow or metered.
function offerLLM() {
  if (llmDownloaded() || !speaksEnglish() || !navigator.onLine || typeof WebAssembly !== "object") return;
  if (slowNet()) {
    $("llmCard").hidden = false;
    $("llmText").textContent = `🧠 ${LLM_TOTAL_MB} MB`;
    return;
  }
  loadLLM();
}

// ------------------------------------------------------------ hearing

async function toMono16k(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = audioCtx || new Ctx();
  const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  return (await offline.startRendering()).getChannelData(0);
}

// What the farmer said in English, as text.
async function hearOffline(blob) {
  const out = await asr(await toMono16k(blob), { language: "en", task: "transcribe" });
  return (out.text || "").trim();
}

// ------------------------------------------------------------ understanding

const CROP_WORDS = {
  tomato: /tomato/i, potato: /potato/i, maize: /maize|corn/i, rice: /rice|paddy/i, wheat: /wheat/i,
  pepper: /pepper|chil+i|capsicum/i, grape: /grape|vine/i, apple: /apple/i, citrus: /citrus|orange|lemon|lime/i,
};
const cropIn = (text) => Object.keys(CROP_WORDS).find((c) => CROP_WORDS[c].test(text)) || "";

const englishName = (id) => id.split(".")[1].replace(/_/g, " ");

async function vectorOf(text) {
  return (await embed(text, { pooling: "mean", normalize: true })).data;
}

// How well the farmer's words fit each known problem of that crop: [{ id, fit }] with fit 0..1.
async function matchSymptoms(said, crop) {
  if (!said || said.split(/\s+/).length < 4 || !englishPack) return [];
  const ids = Object.keys(englishPack.conditions).filter((id) => !crop || crop === "other" || id.startsWith(`${crop}.`));
  const v = await vectorOf(said);
  const out = [];
  for (const id of ids) {
    if (!conditionVectors.has(id)) {
      conditionVectors.set(id, await vectorOf(`${englishName(id)}. ${englishPack.conditions[id].what}`));
    }
    const c = conditionVectors.get(id);
    let sim = 0;
    for (let i = 0; i < v.length; i++) sim += v[i] * c[i];
    // Below 0.35 the words say nothing specific; 0.7 is a close description.
    out.push({ id, fit: Math.max(0, Math.min(1, (sim - 0.35) / 0.35)) });
  }
  return out.sort((a, b) => b.fit - a.fit);
}

// One judgement from the photo and the farmer's words together: [{ id, prob }], best first.
async function combineOpinion(imageOpinion, said, crop) {
  const words = await matchSymptoms(said, crop).catch(() => []);
  if (!words.length || words[0].fit === 0) return imageOpinion;
  if (!imageOpinion || !imageOpinion.length) {
    // Words alone never count as more than a cautious guess.
    return words.slice(0, 3).map((w) => ({ id: w.id, prob: w.fit * 0.7 })).filter((o) => o.prob > 0);
  }
  const scores = new Map();
  for (const o of imageOpinion) scores.set(o.id, o.prob * 0.5);
  for (const w of words) scores.set(w.id, (scores.get(w.id) || 0) + w.fit * 0.5);
  return [...scores].map(([id, prob]) => ({ id, prob })).sort((a, b) => b.prob - a.prob).slice(0, 3);
}

// The spoken answer for an opinion, from the advice prepared in the farmer's language.
function adviceFor(opinion) {
  const ui = (pack && pack.ui) || {};
  const top = opinion && opinion[0];
  const known = top && pack && pack.conditions[top.id];
  if (top && top.id === "healthy" && top.prob >= 0.6) return ui.healthy || "";
  if (!known || top.prob < 0.4) return ui.not_sure || "";
  const sure = top.prob >= 0.85 ? ui.fairly_sure : ui.not_very_sure;
  if (top.prob < 0.5) return `${ui.looks_like} ${known.name}. ${sure}`;
  return `${ui.looks_like} ${known.name}. ${sure} ${known.what} ${ui.do_now} ${known.now.join(" ")}`;
}

// One spoken exchange with no network: hear, look, combine, answer, and keep it all for later.
async function offlineAsk({ audio, text }) {
  if (offlineBusy) return;
  offlineBusy = true;
  render();
  const ai = $("ai");
  ai.className = "";
  ai.textContent = "";
  try {
    // The speech and matching models serve English; other languages get the photo judged now
    // and their recording kept for the full analysis.
    const ready = speaksEnglish() && llmDownloaded() && (await loadLLM());
    if (!pack) await loadPack();

    // What the camera sees right now.
    const shotNow = document.createElement("canvas");
    const haveView = video.readyState >= 2 && video.videoWidth > 0;
    if (haveView) {
      const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
      shotNow.width = Math.round(video.videoWidth * scale);
      shotNow.height = Math.round(video.videoHeight * scale);
      shotNow.getContext("2d").drawImage(video, 0, 0, shotNow.width, shotNow.height);
    }

    const said = text ? text.trim() : audio && ready ? await hearOffline(audio).catch(() => "") : "";
    $("you").textContent = said || (audio ? "🎙️ 💾" : "");

    // The crop comes from the farmer's words, or from the last survey.
    const named = speaksEnglish() ? cropIn(said) : "";
    const crop = named || store.get("crop") || "";
    if (named) store.set("crop", crop);
    if (!crop) {
      // Without knowing the crop nothing can be judged: the guided survey asks for it first.
      openSurvey(true);
      return;
    }

    const seen = haveView ? await classifyLeaf(shotNow, crop).catch(() => null) : null;
    const opinion = ready ? await combineOpinion(seen, said, crop) : seen;
    const reply = `${adviceFor(opinion)} ${(pack && pack.ui.saved_wait) || ""}`.trim();
    ai.textContent = reply;
    speakNow(reply);

    // Keep the exchange so the full analysis can run when the network returns.
    await captures.put({
      id: String(Date.now()),
      capturedAt: clientTime().clientTime,
      offline: true,
      crop,
      photos: haveView ? [{ kind: "live", b64: shotNow.toDataURL("image/jpeg", 0.72).split(",")[1] }] : [],
      answers: {},
      voice: said ? null : audio || null,
      note: said,
      opinion: opinion || [],
      phoneSaid: reply,
    }).catch(() => {});
    showQueue();
  } catch (err) {
    console.error(err);
    // Without the assistant, the guided survey still works.
    openSurvey(true);
  } finally {
    offlineBusy = false;
    render();
  }
}

$("llmGet").onclick = () => loadLLM();
window.addEventListener("offline", () => {
  if (!started) return;
  // No network: tap the orb to speak; the phone answers by itself.
  tapToTalk = true;
  if (speaksEnglish() && llmDownloaded()) loadLLM();
});
