"use strict";

// Offline help. On first load the phone downloads two small plant-disease models, the runtime that
// executes them and a language pack of spoken prompts and first-aid advice. With no network the
// app then guides the farmer through a field survey, gives a first opinion from the leaf photo on
// the phone itself, and keeps the whole survey until the network returns for the full analysis.

// ------------------------------------------------------------ the models

// Each label is [crop, condition id]. Order must match the model's outputs.
const GENERAL_MODEL = {
  url: "https://huggingface.co/onnx-community/mobilenet_v2_1.0_224-plant-disease-identification-ONNX/resolve/main/onnx/model.onnx",
  fit: "crop",
  labels: [
    ["apple", "apple.scab"], ["apple", "apple.black_rot"], ["apple", "apple.cedar_rust"], ["apple", "healthy"],
    ["blueberry", "healthy"], ["cherry", "cherry.powdery_mildew"], ["cherry", "healthy"],
    ["maize", "maize.gray_leaf_spot"], ["maize", "maize.common_rust"], ["maize", "maize.northern_leaf_blight"], ["maize", "healthy"],
    ["grape", "grape.black_rot"], ["grape", "grape.esca"], ["grape", "grape.leaf_blight"], ["grape", "healthy"],
    ["citrus", "citrus.greening"], ["peach", "peach.bacterial_spot"], ["peach", "healthy"],
    ["pepper", "pepper.bacterial_spot"], ["pepper", "healthy"],
    ["potato", "potato.early_blight"], ["potato", "potato.late_blight"], ["potato", "healthy"],
    ["raspberry", "healthy"], ["soybean", "healthy"], ["squash", "squash.powdery_mildew"],
    ["strawberry", "strawberry.leaf_scorch"], ["strawberry", "healthy"],
    ["tomato", "tomato.bacterial_spot"], ["tomato", "tomato.early_blight"], ["tomato", "tomato.late_blight"],
    ["tomato", "tomato.leaf_mold"], ["tomato", "tomato.septoria"], ["tomato", "tomato.spider_mites"],
    ["tomato", "tomato.target_spot"], ["tomato", "tomato.yellow_leaf_curl"], ["tomato", "tomato.mosaic"], ["tomato", "healthy"],
  ],
};
// Staple crops; it also has a class for photos that are not a leaf at all.
const STAPLE_MODEL = {
  url: "https://huggingface.co/cabrel09/crop_leaf_disease_detector/resolve/main/onnx/model.onnx",
  fit: "stretch",
  labels: [
    ["maize", "maize.common_rust"], ["maize", "maize.gray_leaf_spot"], ["maize", "healthy"], ["", "invalid"],
    ["potato", "potato.early_blight"], ["potato", "healthy"], ["potato", "potato.late_blight"],
    ["rice", "rice.brown_spot"], ["rice", "healthy"], ["rice", "rice.leaf_blast"],
    ["wheat", "wheat.brown_rust"], ["wheat", "healthy"], ["wheat", "wheat.yellow_rust"],
  ],
};
// Which models can judge which crop. Citrus has no healthy class to compare against, so no opinion.
const CROP_MODELS = {
  tomato: [GENERAL_MODEL], pepper: [GENERAL_MODEL], grape: [GENERAL_MODEL], apple: [GENERAL_MODEL],
  potato: [GENERAL_MODEL, STAPLE_MODEL], maize: [GENERAL_MODEL, STAPLE_MODEL],
  rice: [STAPLE_MODEL], wheat: [STAPLE_MODEL], citrus: [], other: [GENERAL_MODEL],
};
const CROPS = [
  ["tomato", "🍅"], ["potato", "🥔"], ["maize", "🌽"], ["rice", "🌾"], ["wheat", "🌿"],
  ["pepper", "🫑"], ["grape", "🍇"], ["apple", "🍎"], ["citrus", "🍊"], ["other", "🌱"],
];

const MODEL_CACHE = "agriconnect-models-v1";
const RUNTIME_FILES = ["/vendor/ort/ort.wasm.min.js", "/vendor/ort/ort-wasm-simd-threaded.mjs", "/vendor/ort/ort-wasm-simd-threaded.wasm"];

async function modelBytes(url, mayDownload) {
  const cache = await caches.open(MODEL_CACHE);
  let res = await cache.match(url);
  if (!res) {
    if (!mayDownload || !navigator.onLine) return null;
    const net = await fetch(url);
    if (!net.ok) throw new Error(`model download ${net.status}`);
    await cache.put(url, net.clone());
    res = net;
  }
  return res.arrayBuffer();
}

let runtime = null;
function loadRuntime() {
  return (runtime ??= new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = RUNTIME_FILES[0];
    tag.onload = () => {
      ort.env.wasm.wasmPaths = "/vendor/ort/";
      ort.env.wasm.numThreads = 1;
      resolve();
    };
    tag.onerror = () => {
      runtime = null;
      reject(new Error("runtime unavailable"));
    };
    document.head.append(tag);
  }));
}

const sessions = new Map();
function getSession(model, mayDownload) {
  if (!sessions.has(model.url)) {
    const p = (async () => {
      const bytes = await modelBytes(model.url, mayDownload);
      if (!bytes) return null;
      await loadRuntime();
      return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"] });
    })();
    sessions.set(model.url, p);
    p.then((s) => s || sessions.delete(model.url), () => sessions.delete(model.url));
  }
  return sessions.get(model.url);
}

// 224x224 input in the layout the models expect, pixel values scaled to -1..1.
const inputCanvas = document.createElement("canvas");
inputCanvas.width = inputCanvas.height = 224;
function toTensor(source, fit) {
  const ctx = inputCanvas.getContext("2d", { willReadFrequently: true });
  const w = source.width, h = source.height;
  if (fit === "crop") {
    // shortest side to 256, then the central 224 square
    const side = Math.min(w, h) * (224 / 256);
    ctx.drawImage(source, (w - side) / 2, (h - side) / 2, side, side, 0, 0, 224, 224);
  } else {
    ctx.drawImage(source, 0, 0, w, h, 0, 0, 224, 224);
  }
  const px = ctx.getImageData(0, 0, 224, 224).data;
  const data = new Float32Array(3 * 224 * 224);
  for (let i = 0; i < 224 * 224; i++) {
    data[i] = px[i * 4] / 127.5 - 1;
    data[i + 50176] = px[i * 4 + 1] / 127.5 - 1;
    data[i + 100352] = px[i * 4 + 2] / 127.5 - 1;
  }
  return new ort.Tensor("float32", data, [1, 3, 224, 224]);
}

// The phone's own opinion of a leaf photo: a list of { id, prob }, most likely first, or null.
async function classifyLeaf(source, crop) {
  const models = CROP_MODELS[crop] || [];
  const sums = new Map();
  const counts = new Map();
  const logitsOf = async (model, fit) => {
    const session = await getSession(model, false).catch(() => null);
    if (!session) return null;
    const out = await session.run({ [session.inputNames[0]]: toTensor(source, fit) });
    let logits = Array.from(out[session.outputNames[0]].data);
    if (logits.length === model.labels.length + 1) logits = logits.slice(1); // leading background class
    return logits.length === model.labels.length ? logits : null;
  };

  // Whatever the crop, first ask the staple model whether this is a leaf at all.
  if (models.length) {
    const all = await logitsOf(STAPLE_MODEL, "stretch");
    if (all) {
      const max = Math.max(...all);
      const exp = all.map((v) => Math.exp(v - max));
      const invalid = exp[STAPLE_MODEL.labels.findIndex((l) => l[1] === "invalid")] / exp.reduce((a, b) => a + b, 0);
      if (invalid > 0.5) return null;
    }
  }

  // Each model looks at the photo twice (central square and whole frame) and the views are averaged.
  for (const model of models) for (const fit of ["crop", "stretch"]) {
    const logits = await logitsOf(model, fit);
    if (!logits) continue;
    // Only the classes of the crop the farmer chose compete, which removes most wrong answers.
    const keep = model.labels.map(([c, id]) => crop === "other" || c === crop || id === "invalid");
    const max = Math.max(...logits.filter((_, i) => keep[i]));
    const exp = logits.map((v, i) => (keep[i] ? Math.exp(v - max) : 0));
    const total = exp.reduce((a, b) => a + b, 0);
    exp.forEach((v, i) => {
      if (!keep[i]) return;
      const id = model.labels[i][1];
      sums.set(id, (sums.get(id) || 0) + v / total);
    });
    for (const id of new Set(model.labels.filter((_, i) => keep[i]).map((l) => l[1]))) {
      counts.set(id, (counts.get(id) || 0) + 1);
    }
  }
  if (!sums.size) return null;
  sums.delete("invalid");
  let list = [...sums].map(([id, v]) => ({ id, prob: v / counts.get(id) }));
  const norm = list.reduce((a, b) => a + b.prob, 0) || 1;
  list = list.map((o) => ({ id: o.id, prob: o.prob / norm })).sort((a, b) => b.prob - a.prob);
  return list.slice(0, 3);
}

// ------------------------------------------------------------ language pack

let pack = null;
async function loadPack() {
  const key = `pack:${lang}`;
  try {
    const res = await fetch(`/api/pack?lang=${encodeURIComponent(lang)}`);
    const fresh = await res.json();
    if (fresh?.ui) {
      pack = fresh;
      if (res.ok) store.set(key, JSON.stringify(fresh));
      return pack;
    }
  } catch {}
  try { pack = JSON.parse(store.get(key)); } catch {}
  return pack;
}

// ------------------------------------------------------------ getting ready for no network

let offlineReady = false;
function showOfflineStatus(text) {
  const el = $("offlineStatus");
  el.textContent = text;
  el.hidden = !text;
}

// Downloads everything once; later visits find it all on the phone already.
async function prepareOffline() {
  try {
    await loadPack();
    const have = await caches.open(MODEL_CACHE).then((c) => c.keys()).then((k) => k.length);
    // On a very slow or metered connection, wait for a better one before the big download.
    if (have < 2 && (slowNet() || !navigator.onLine)) return;
    if (have < 2) showOfflineStatus("⬇️");
    await caches.open("agriconnect-vendor-v1").then((c) => c.addAll(RUNTIME_FILES)).catch(() => {});
    await getSession(GENERAL_MODEL, true);
    await getSession(STAPLE_MODEL, true);
    offlineReady = true;
    showOfflineStatus("");
  } catch {
    showOfflineStatus("");
  }
}

// ------------------------------------------------------------ saved surveys (IndexedDB)

const captures = (() => {
  let db;
  const open = () =>
    (db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("agriconnect", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("captures", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((resolve, reject) => {
      const tx = d.transaction("captures", mode);
      const req = fn(tx.objectStore("captures"));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
    });
  };
  return {
    put: (value) => run("readwrite", (s) => s.put(value)),
    all: () => run("readonly", (s) => s.getAll()),
    remove: (id) => run("readwrite", (s) => s.delete(id)),
  };
})();

async function showQueue() {
  const n = await captures.all().then((l) => l.length, () => 0);
  $("queueBadge").hidden = !n;
  $("queueBadge").textContent = n;
}

// ------------------------------------------------------------ the guided survey

const PHOTO_STEPS = ["field", "plant", "leaf", "under", "stem", "roots", "soil"];
// English descriptions sent with the survey, whatever language the farmer uses.
const PHOTO_LABEL = {
  field: "the whole field", plant: "one whole sick plant", leaf: "a sick leaf, top side, close up",
  under: "the underside of that leaf", stem: "the base of the stem at soil level",
  roots: "the roots of a pulled plant", soil: "soil from a hand-deep hole next to a sick plant",
};
const QUESTIONS = {
  q_when: ["when it started", ["a few days ago", "about a week ago", "more than two weeks ago"]],
  q_pattern: ["where in the field", ["a few plants here and there", "in patches", "the whole field", "along the edges or in low spots"]],
  q_leaves: ["which leaves got sick first", ["the bottom leaves", "the top leaves", "all at the same time"]],
  q_water: ["how the crop gets water", ["rain only", "furrows or flooding", "by hand or drip", "sprinkler"]],
  q_weather: ["weather in the past days", ["dry and hot", "normal", "a lot of rain", "cold"]],
  q_applied: ["recently applied", ["nothing", "fertiliser", "a spray against pests or disease", "both fertiliser and a spray"]],
  q_size: ["plot size", ["a small garden", "about a quarter of a hectare", "about half a hectare", "a hectare or more"]],
};

let surveyOpen = false;
let sv = null;          // the survey being filled in
let svRecorder = null;

function speakNow(text) {
  stopSpeaking();
  spokenRecently = "";
  say(text);
}

async function openSurvey(becauseOffline) {
  if (surveyOpen) return;
  if (!pack) await loadPack();
  if (!pack) {
    $("ai").className = "error";
    $("ai").textContent = "📡 ✕";
    return;
  }
  surveyOpen = true;
  // The survey is driven by taps; stop listening so the microphone is free for the voice note.
  recWanted = false;
  if (rec) { try { rec.abort(); } catch {} }
  bargeIn();
  sv = { step: -1, crop: "", photos: [], answers: {}, voice: null, opinion: null, opinionJob: null, offline: !navigator.onLine };
  sv.steps = [{ type: "crop" }, ...PHOTO_STEPS.map((k) => ({ type: "photo", key: k })),
    ...Object.keys(QUESTIONS).map((k) => ({ type: "question", key: k })), { type: "voice" }, { type: "result" }];
  $("survey").hidden = false;
  $("bottom").hidden = true;
  $("top").hidden = true;
  sv.intro = becauseOffline ? pack.ui.offline_intro : pack.ui.survey_intro;
  nextStep();
}

function closeSurvey() {
  if (!surveyOpen) return;
  surveyOpen = false;
  if (svRecorder) { try { svRecorder.stop(); } catch {} }
  stopSpeaking();
  $("survey").hidden = true;
  $("bottom").hidden = false;
  $("top").hidden = false;
  if (Recognition && started) startListening();
  render();
}

function nextStep() {
  sv.step++;
  const step = sv.steps[sv.step];
  const ui = pack.ui;
  const options = $("svOptions");
  options.textContent = "";
  $("svResult").hidden = true;
  $("svShutter").hidden = step.type !== "photo";
  $("svMic").hidden = step.type !== "voice";
  $("svSkip").hidden = step.type === "crop" || step.type === "question" || step.type === "result";
  $("svSkip").textContent = step.type === "voice" ? "➤" : ui.skip;
  $("svDots").textContent = `${Math.min(sv.step + 1, sv.steps.length - 1)} / ${sv.steps.length - 1}`;

  const addOption = (label, onTap) => {
    const b = document.createElement("button");
    b.className = "svOption";
    b.dir = "auto";
    b.textContent = label;
    b.onclick = onTap;
    options.append(b);
  };

  let prompt = "";
  let alsoSay = "";
  if (step.type === "crop") {
    prompt = ui.pick_crop;
    options.className = "grid";
    for (const [crop, icon] of CROPS) {
      addOption(`${icon} ${ui[`crop_${crop}`]}`, () => {
        sv.crop = crop;
        nextStep();
      });
    }
  } else if (step.type === "photo") {
    prompt = ui[`p_${step.key}`];
  } else if (step.type === "question") {
    prompt = ui[step.key];
    options.className = "";
    QUESTIONS[step.key][1].forEach((_, i) => {
      const label = ui[`${step.key}.${i}`];
      alsoSay += ` ${label}.`;
      addOption(label, () => {
        sv.answers[step.key] = i;
        nextStep();
      });
    });
  } else if (step.type === "voice") {
    prompt = ui.voice_note;
  } else {
    return finishSurvey();
  }
  $("svPrompt").textContent = prompt;
  speakNow(`${sv.intro || ""} ${prompt}${alsoSay}`);
  sv.intro = "";
}

function takeSurveyPhoto() {
  const step = sv.steps[sv.step];
  if (step.type !== "photo" || video.readyState < 2) return;
  const scale = Math.min(1, 1024 / Math.max(video.videoWidth, video.videoHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(video.videoWidth * scale);
  c.height = Math.round(video.videoHeight * scale);
  c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
  sv.photos.push({ kind: step.key, b64: c.toDataURL("image/jpeg", 0.72).split(",")[1] });
  // The close-up leaf is what the phone's model judges; the whole plant is the fallback.
  if (step.key === "leaf" || (step.key === "plant" && !sv.opinionJob)) {
    const job = classifyLeaf(c, sv.crop).catch(() => null);
    if (step.key === "leaf") sv.opinionJob = job;
    else sv.plantJob = job;
  }
  video.classList.add("flash");
  setTimeout(() => video.classList.remove("flash"), 180);
  nextStep();
}

async function toggleSurveyNote() {
  if (svRecorder) return svRecorder.stop();
  stopSpeaking();
  try {
    micStream ||= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return nextStep();
  }
  const chunks = [];
  const r = new MediaRecorder(micStream, { audioBitsPerSecond: 24000 });
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = () => {
    svRecorder = null;
    $("svMic").classList.remove("on");
    if (chunks.length && surveyOpen) {
      sv.voice = new Blob(chunks, { type: r.mimeType });
      nextStep();
    }
  };
  svRecorder = r;
  $("svMic").classList.add("on");
  r.start();
  setTimeout(() => svRecorder === r && r.stop(), 90000);
}

async function finishSurvey() {
  const ui = pack.ui;
  $("svPrompt").textContent = "⏳";
  const opinion = (await (sv.opinionJob || sv.plantJob || null)) || null;
  const top = opinion && opinion[0];
  const known = top && pack.conditions[top.id];
  const box = $("svResult");
  box.textContent = "";
  const line = (cls, text) => {
    const el = document.createElement("p");
    el.className = cls;
    el.dir = "auto";
    el.textContent = text;
    box.append(el);
  };

  let spoken;
  if (top && top.id === "healthy" && top.prob >= 0.6) {
    spoken = ui.healthy;
    line("svName", `✅ ${ui.healthy}`);
  } else if (known && top.prob >= 0.4 && top.prob < 0.6) {
    // Two candidates too close to call: name them, give no treatment yet.
    spoken = `${ui.looks_like} ${known.name}. ${ui.not_very_sure}`;
    for (const o of opinion.slice(0, 2)) {
      const c = pack.conditions[o.id];
      if (c) line("svName", `❔ ${c.name} · ${Math.round(o.prob * 100)}%`);
    }
  } else if (known && top.prob >= 0.6) {
    const sure = top.prob >= 0.85 ? ui.fairly_sure : ui.not_very_sure;
    spoken = `${ui.looks_like} ${known.name}. ${sure} ${known.what} ${ui.do_now} ${known.now.join(" ")}`;
    line("svName", `${known.name} · ${Math.round(top.prob * 100)}%`);
    line("svWhat", known.what);
    known.now.forEach((n, i) => line("svDo", `${i + 1}. ${n}`));
  } else {
    spoken = ui.not_sure;
    line("svName", `❔ ${ui.not_sure}`);
  }
  line("svWait", `💾 ${ui.saved_wait}`);
  $("svPrompt").textContent = "";
  box.hidden = false;
  $("svSkip").hidden = false;
  $("svSkip").textContent = "✓";

  await captures.put({
    id: String(Date.now()),
    capturedAt: clientTime().clientTime,
    offline: sv.offline,
    crop: sv.crop,
    photos: sv.photos,
    answers: sv.answers,
    voice: sv.voice,
    opinion,
  }).catch(() => {});
  showQueue();

  if (navigator.onLine) {
    // With network the full analysis starts at once and the assistant speaks for itself.
    closeSurvey();
    syncCaptures();
  } else {
    speakNow(`${spoken} ${ui.saved_wait}`);
  }
}

// ------------------------------------------------------------ sending surveys when the network is back

let syncing = false;
async function syncCaptures() {
  if (syncing || !navigator.onLine || !started || surveyOpen) return;
  syncing = true;
  try {
    for (const c of await captures.all()) {
      while (turn || isSpeaking()) await new Promise((r) => setTimeout(r, 500));
      if (surveyOpen || !navigator.onLine) break;
      if (c.voice && !c.note) {
        try {
          const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": c.voice.type || "audio/webm" }, body: c.voice });
          c.note = (await res.json()).text || "";
          c.voice = null;
          await captures.put(c);
        } catch {}
      }
      if (c.offline && pack) $("you").textContent = pack.ui.syncing;
      const answers = {};
      for (const [q, i] of Object.entries(c.answers || {})) {
        if (QUESTIONS[q]) answers[QUESTIONS[q][0]] = QUESTIONS[q][1][i];
      }
      const ok = await sendTurn("report", "", {
        frames: c.photos.map((p) => p.b64),
        frameLabels: c.photos.map((p) => PHOTO_LABEL[p.kind]),
        survey: { capturedAt: c.capturedAt, offline: c.offline, crop: c.crop, answers, note: c.note || "", opinion: c.opinion || [] },
      });
      if (!ok) break;
      await captures.remove(c.id);
      showQueue();
    }
  } finally {
    syncing = false;
  }
}

// ------------------------------------------------------------ wiring

$("surveyBtn").onclick = () => openSurvey(!navigator.onLine);
$("svClose").onclick = closeSurvey;
$("svShutter").onclick = takeSurveyPhoto;
$("svMic").onclick = toggleSurveyNote;
$("svSkip").onclick = () => (sv.steps[sv.step].type === "result" ? closeSurvey() : nextStep());
window.addEventListener("online", () => setTimeout(syncCaptures, 1500));
setInterval(syncCaptures, 60000);
showQueue();
