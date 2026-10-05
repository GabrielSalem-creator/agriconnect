"use strict";

const LANGS = [
  ["en-US", "English"], ["fr-FR", "Français"], ["ar-SA", "العربية"], ["es-ES", "Español"],
  ["pt-BR", "Português"], ["hi-IN", "हिन्दी"], ["bn-BD", "বাংলা"], ["ur-PK", "اردو"],
  ["sw-KE", "Kiswahili"], ["am-ET", "አማርኛ"], ["ha-NG", "Hausa"], ["yo-NG", "Yorùbá"],
  ["ig-NG", "Igbo"], ["zu-ZA", "isiZulu"], ["af-ZA", "Afrikaans"], ["so-SO", "Soomaali"],
  ["rw-RW", "Kinyarwanda"], ["id-ID", "Bahasa Indonesia"], ["ms-MY", "Bahasa Melayu"],
  ["fil-PH", "Filipino"], ["vi-VN", "Tiếng Việt"], ["th-TH", "ไทย"], ["my-MM", "မြန်မာ"],
  ["km-KH", "ខ្មែរ"], ["lo-LA", "ລາວ"], ["ne-NP", "नेपाली"], ["si-LK", "සිංහල"],
  ["ta-IN", "தமிழ்"], ["te-IN", "తెలుగు"], ["mr-IN", "मराठी"], ["gu-IN", "ગુજરાતી"],
  ["kn-IN", "ಕನ್ನಡ"], ["ml-IN", "മലയാളം"], ["pa-IN", "ਪੰਜਾਬੀ"], ["fa-IR", "فارسی"],
  ["tr-TR", "Türkçe"], ["uz-UZ", "Oʻzbekcha"], ["ru-RU", "Русский"], ["uk-UA", "Українська"],
  ["zh-CN", "中文"], ["ja-JP", "日本語"], ["ko-KR", "한국어"], ["de-DE", "Deutsch"], ["it-IT", "Italiano"],
];

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const video = $("cam");
const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const isAndroid = /Android/i.test(navigator.userAgent);
const net = navigator.connection;
const slowNet = () => Boolean(net && (net.saveData || /2g/.test(net.effectiveType || "")));

let farmerId = store.get("farmer");
if (!farmerId) {
  farmerId = (crypto.randomUUID ? crypto.randomUUID() : `f-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`).toLowerCase();
  store.set("farmer", farmerId);
}

let lang = store.get("lang") || pickDefaultLang();
let plan = null;
let location_ = null;
let started = false;

// conversation state
let turn = null;            // AbortController of the request in flight
let utterance = "";         // finalised farmer speech not yet sent
let sendTimer = 0;
let wasInterrupted = false;
let awaitingView = false;   // the AI asked to be shown something
let lookTimer = 0;
let lastSentAt = 0;
let hearingUntil = 0;

function pickDefaultLang() {
  const nav = navigator.language || "en-US";
  const exact = LANGS.find(([c]) => c.toLowerCase() === nav.toLowerCase());
  const loose = LANGS.find(([c]) => c.split("-")[0] === nav.split("-")[0]);
  return (exact || loose || LANGS[0])[0];
}

// ------------------------------------------------------------ speaking

let ttsGen = 0;
let ttsPending = 0;
let spokenRecently = "";
let speechEndedAt = 0;
let voices = [];

const loadVoices = () => { voices = window.speechSynthesis ? speechSynthesis.getVoices() : []; };
if (window.speechSynthesis) {
  loadVoices();
  speechSynthesis.onvoiceschanged = loadVoices;
}

function pickVoice() {
  const base = lang.split("-")[0].toLowerCase();
  const norm = (v) => v.lang.replace("_", "-").toLowerCase();
  return (
    voices.find((v) => norm(v) === lang.toLowerCase()) ||
    voices.find((v) => norm(v).split("-")[0] === base) ||
    null
  );
}

const isSpeaking = () => ttsPending > 0;

let audioCtx = null;
let audioSource = null;
let cloudVoice = true;          // switched off when the server has no voice for this language or quota
let sayChain = Promise.resolve();

// Natural voice from the server; null means use the phone's own voice for this sentence.
async function fetchVoice(text) {
  if (!cloudVoice || !audioCtx || !navigator.onLine) return null;
  try {
    const res = await fetch("/api/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, lang }),
    });
    if (res.status === 501 || res.status === 429) cloudVoice = false;
    if (!res.ok) return null;
    return await audioCtx.decodeAudioData(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function playBuffer(buffer) {
  return new Promise((resolve) => {
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.connect(audioCtx.destination);
    src.onended = resolve;
    audioSource = src;
    src.start();
  });
}

function speakOnDevice(text) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    const voice = pickVoice();
    if (voice) u.voice = voice;
    u.lang = voice ? voice.lang : lang;
    u.onend = u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

function say(text) {
  text = text.replace(/[*_#`]/g, "").trim();
  if (!text) return;
  const gen = ttsGen;
  ttsPending++;
  spokenRecently += " " + text;
  // Fetch every sentence's audio at once, but play them in order.
  const voice = fetchVoice(text);
  sayChain = sayChain.then(async () => {
    const buffer = await voice;
    if (gen !== ttsGen) return;
    await (buffer ? playBuffer(buffer) : speakOnDevice(text));
    if (gen !== ttsGen) return;
    ttsPending = Math.max(0, ttsPending - 1);
    if (!ttsPending) {
      speechEndedAt = Date.now();
      render();
      maybeAutoLook();
    }
  });
  render();
}

function stopSpeaking() {
  ttsGen++;
  if (ttsPending) speechEndedAt = Date.now();
  ttsPending = 0;
  sayChain = Promise.resolve();
  if (audioSource) { try { audioSource.stop(); } catch {} audioSource = null; }
  if (window.speechSynthesis) speechSynthesis.cancel();
}

// Speak the reply sentence by sentence as it streams in.
let speakBuffer = "";
function feedSpeech(delta, flush) {
  speakBuffer += delta;
  for (;;) {
    const m = speakBuffer.match(/^[\s\S]*?[.!?。！？।؟…\n]+(?=\s)/);
    if (!m) break;
    say(m[0]);
    speakBuffer = speakBuffer.slice(m[0].length);
  }
  if (flush) {
    say(speakBuffer);
    speakBuffer = "";
  }
}

// ------------------------------------------------------------ listening

let rec = null;
let recWanted = false;

const words = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

// The microphone also hears the phone's own voice; drop transcripts that are just that.
function isEcho(heard) {
  const w = words(heard);
  if (!w.length) return true;
  const spoken = new Set(words(spokenRecently));
  if (w.filter((x) => spoken.has(x)).length / w.length >= 0.6) return true;
  return words(spokenRecently).join("").includes(w.join(""));
}

function startListening() {
  if (!Recognition) return;
  recWanted = true;
  if (rec) return;
  rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.continuous = !isAndroid; // Android repeats results in continuous mode
  rec.onresult = onHeard;
  rec.onerror = (e) => {
    if (e.error === "not-allowed") {
      recWanted = false;
      showTyping(true);
    } else if (e.error === "language-not-supported" || e.error === "service-not-allowed" || (e.error === "network" && !navigator.onLine)) {
      // This browser cannot recognise the language: record and let the server transcribe.
      recWanted = false;
      tapToTalk = true;
      render();
    }
  };
  rec.onend = () => {
    rec = null;
    if (recWanted) setTimeout(startListening, 150);
  };
  try { rec.start(); } catch { rec = null; }
}

function restartListening() {
  if (rec) { try { rec.abort(); } catch {} }
  else startListening();
}

function onHeard(e) {
  let finalText = "";
  let interim = "";
  for (let i = e.resultIndex; i < e.results.length; i++) {
    const r = e.results[i];
    if (r.isFinal) finalText += r[0].transcript + " ";
    else interim += r[0].transcript;
  }
  const heard = (finalText + interim).trim();
  if (!heard || surveyOpen) return;

  const echoPossible = isSpeaking() || Date.now() - speechEndedAt < 1200;
  if (echoPossible && isEcho(heard)) return;

  // The farmer is talking over the AI: stop it at once.
  if ((isSpeaking() || turn) && heard.length >= 4) bargeIn();

  hearingUntil = Date.now() + 1200;
  clearTimeout(lookTimer);
  if (finalText.trim()) utterance = (utterance + " " + finalText).trim();
  $("you").textContent = (utterance + " " + interim).trim();
  scrollCaption();
  render();

  clearTimeout(sendTimer);
  if (utterance) sendTimer = setTimeout(flushUtterance, interim ? 1800 : 900);
}

function flushUtterance() {
  const text = utterance;
  utterance = "";
  if (text) sendTurn("say", text);
}

// Tap-to-talk for browsers with no speech recognition: tap the orb, speak, tap again.
let tapToTalk = false;
let micStream = null;
let recorder = null;

async function toggleRecording() {
  if (!tapToTalk || !window.MediaRecorder) return;
  if (recorder) return recorder.stop();
  bargeIn();
  try {
    micStream ||= await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return showTyping(true);
  }
  const chunks = [];
  const r = new MediaRecorder(micStream, { audioBitsPerSecond: 24000 });
  r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  r.onstop = async () => {
    recorder = null;
    render();
    const blob = new Blob(chunks, { type: r.mimeType });
    if (!navigator.onLine) return offlineAsk({ audio: blob });
    try {
      const res = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob });
      const { text } = await res.json();
      if (text) {
        $("you").textContent = text;
        sendTurn("say", text);
      }
    } catch {
      showTyping(true);
    }
  };
  recorder = r;
  r.start();
  render();
  // Never record longer than a minute.
  setTimeout(() => recorder === r && r.stop(), 60000);
}

function bargeIn() {
  if (isSpeaking() || (turn && !saving)) wasInterrupted = true;
  stopSpeaking();
  speakBuffer = "";
  // While the plan is being saved the request is left to finish; only the voice stops.
  if (turn && !saving) {
    turn.abort();
    turn = null;
  }
  render();
}

// ------------------------------------------------------------ camera

const shot = document.createElement("canvas");
const tiny = document.createElement("canvas");
tiny.width = 32;
tiny.height = 24;
const tinyCtx = tiny.getContext("2d", { willReadFrequently: true });

let keyframes = [];     // { t, data, sent }
let prevThumb = null;
let keyThumb = null;
let sentThumb = null;   // what the camera showed in the last frame the AI received

// Small frames by default; full detail only when the AI has asked to be shown something.
function grab(detail) {
  if (video.readyState < 2 || !video.videoWidth) return null;
  const max = slowNet() ? 448 : detail ? 1024 : 640;
  const scale = Math.min(1, max / Math.max(video.videoWidth, video.videoHeight));
  shot.width = Math.round(video.videoWidth * scale);
  shot.height = Math.round(video.videoHeight * scale);
  shot.getContext("2d").drawImage(video, 0, 0, shot.width, shot.height);
  return shot.toDataURL("image/jpeg", slowNet() ? 0.5 : 0.62).split(",")[1];
}

function thumb() {
  tinyCtx.drawImage(video, 0, 0, tiny.width, tiny.height);
  const px = tinyCtx.getImageData(0, 0, tiny.width, tiny.height).data;
  const g = new Uint8Array(px.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = (px[i * 4] * 3 + px[i * 4 + 1] * 6 + px[i * 4 + 2]) / 10;
  return g;
}

function diff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// Watch the live feed and keep a still of every new scene once the camera holds steady on it.
function watchCamera() {
  if (!started || document.hidden || video.readyState < 2) return;
  const now = thumb();
  const steady = prevThumb && diff(now, prevThumb) < 7;
  const newScene = !keyThumb || diff(now, keyThumb) > 16;
  prevThumb = now;
  if (steady && newScene) {
    const data = grab();
    if (!data) return;
    keyThumb = now;
    keyframes.push({ t: Date.now(), data, sent: false });
    if (keyframes.length > 6) keyframes.shift();
    maybeAutoLook();
  }
}

// Send only what the AI has not seen: nothing if the view is unchanged, one earlier scene at most.
function collectFrames(kind, detail) {
  if (kind === "open" || video.readyState < 2) return [];
  const now = Date.now();
  const view = thumb();
  const unchanged = sentThumb && diff(view, sentThumb) < 9;
  const earlier = slowNet() ? [] : keyframes.filter((k) => !k.sent && now - k.t < 30000 && now - k.t > 1500).slice(-1);
  for (const k of keyframes) k.sent = true;
  keyThumb = view;
  if (unchanged && !detail && !earlier.length) return [];
  const frames = earlier.map((k) => k.data);
  const live = grab(detail);
  if (live) {
    frames.push(live);
    sentThumb = view;
  }
  return frames;
}

// The AI asked to see something: once the farmer points the camera at it, send the view without waiting for words.
function maybeAutoLook() {
  clearTimeout(lookTimer);
  const idle = () => !turn && !isSpeaking() && !utterance && Date.now() > hearingUntil;
  const fresh = () => keyframes.some((k) => !k.sent && k.t > lastSentAt);
  if (!awaitingView || !idle() || !fresh()) return;
  lookTimer = setTimeout(() => {
    if (awaitingView && idle() && fresh()) sendTurn("look", "");
  }, 2000);
}

// ------------------------------------------------------------ the turn

function clientTime() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return {
    localDate: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
    clientTime: d.toLocaleString("en-GB", {
      weekday: "long", year: "numeric", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit",
    }),
  };
}

let saving = false;     // the AI has spoken and is now writing the plan

async function sendTurn(kind, text, extra) {
  while (turn && saving) await new Promise((r) => setTimeout(r, 200));
  if (turn) turn.abort();
  stopSpeaking();
  clearTimeout(lookTimer);
  const ctrl = new AbortController();
  turn = ctrl;
  speakBuffer = "";
  spokenRecently = "";
  const frames = extra ? extra.frames : collectFrames(kind, awaitingView);
  setHint("");
  awaitingView = false;
  lastSentAt = Date.now();

  const body = {
    farmer: farmerId, lang, kind, text,
    frames,
    interrupted: wasInterrupted,
    readAloud,
    location: location_,
    tz: new Date().getTimezoneOffset(),
    ...clientTime(),
    ...extra,
  };
  wasInterrupted = false;
  readAloud = [];

  const ai = $("ai");
  ai.className = "";
  let reply = "";
  let offline = false;
  let delivered = false;
  render();

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === "delta") {
          if (!reply) $("you").textContent = "";
          reply += ev.text;
          ai.textContent = reply;
          scrollCaption();
          feedSpeech(ev.text, false);
        } else if (ev.t === "saving") {
          feedSpeech("", true);
          saving = true;
        } else if (ev.t === "done") {
          delivered = true;
          feedSpeech("", true);
          if (ev.plan !== undefined) setPlan(ev.plan);
          setRecord(ev.record);
          if (ev.ask) {
            setHint(ev.ask);
            awaitingView = true;
          }
        } else if (ev.t === "error") {
          ai.className = "error";
          ai.textContent = ev.message;
        }
      }
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      offline = true;
      ai.className = "error";
      ai.textContent = "📡 ✕";
      // No network: the phone takes over with the guided survey and its own first opinion.
      if (kind !== "report" && !navigator.onLine) {
        // The phone takes over: tap the orb to speak, or follow the guided survey.
        tapToTalk = true;
        setTimeout(() => (text ? offlineAsk({ text }) : openSurvey(true)), 300);
      }
    }
  } finally {
    if (turn === ctrl) {
      turn = null;
      saving = false;
      render(offline);
      maybeAutoLook();
    }
  }
  return delivered;
}

// ------------------------------------------------------------ interface

function render(offline) {
  const orb = $("orb");
  orb.className = offline === true ? "offline"
    : recorder ? "hearing"
    : typeof offlineBusy !== "undefined" && offlineBusy ? "thinking"
    : isSpeaking() ? "speaking"
    : turn ? "thinking"
    : Date.now() < hearingUntil ? "hearing"
    : started ? "listening" : "idle";
}
setInterval(() => { if (started && !turn && !isSpeaking()) render(); }, 600);

function scrollCaption() {
  const c = $("caption");
  c.scrollTop = c.scrollHeight;
}

function setHint(text) {
  $("hintText").textContent = text;
  $("hint").hidden = !text;
}

function showTyping(show) {
  $("typeForm").hidden = !show;
  if (show) $("typeInput").focus();
}

function today() {
  return clientTime().localDate;
}

function setPlan(p) {
  plan = p;
  store.set("plan", JSON.stringify(p));
  const due = plan ? plan.steps.filter((s) => !s.done && s.date <= today()).length : 0;
  $("badge").hidden = !due;
  $("badge").textContent = due;
  if (!$("plan").hidden) drawPlan();
  if (plan && started) enablePush();
}

function setRecord(url) {
  $("recordBtn").hidden = !url;
  if (url) $("recordBtn").href = url;
}

// Let the server ping this phone when a plan step is due, even with the app closed.
async function enablePush() {
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return;
  if (!plan || Notification.permission === "denied") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission !== "granted" && (await Notification.requestPermission()) !== "granted") return;
    const { key } = await (await fetch("/api/push-key")).json();
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }));
    await fetch("/api/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ farmer: farmerId, subscription: sub, tz: new Date().getTimezoneOffset() }),
    });
  } catch {}
}

function drawPlan() {
  const list = $("steps");
  list.textContent = "";
  $("planSummary").textContent = plan ? plan.summary : "";
  $("calBtn").hidden = !plan || !plan.steps.some((s) => !s.done);
  $("calBtn").href = `/api/plan.ics?f=${farmerId}`;
  if (!plan || !plan.steps.length) {
    const li = document.createElement("div");
    li.className = "empty";
    li.textContent = "📅 …";
    list.append(li);
    return;
  }
  const fmt = new Intl.DateTimeFormat(lang, { weekday: "long", day: "numeric", month: "long" });
  for (const s of plan.steps) {
    const li = document.createElement("li");
    li.className = s.done ? "done" : s.date <= today() ? "due" : "";
    const add = (cls, text) => {
      const el = document.createElement("div");
      el.className = cls;
      el.dir = "auto";
      el.textContent = text;
      li.append(el);
    };
    add("icon", s.done ? "✅" : s.check_with_camera ? "📷" : "🌱");
    add("when", `${fmt.format(new Date(s.date + "T12:00:00"))} · ${s.time}`);
    add("title", s.title);
    add("what", s.instruction);
    // Tapping a step reads it aloud, for farmers who cannot read it.
    li.onclick = () => {
      stopSpeaking();
      spokenRecently = "";
      say(s.instruction);
    };
    list.append(li);
  }

  // What may come next: readable and audible with no network.
  for (const o of plan.outlook || []) {
    const li = document.createElement("li");
    li.className = "outlook";
    const add = (cls, text) => {
      const el = document.createElement("div");
      el.className = cls;
      el.dir = "auto";
      el.textContent = text;
      li.append(el);
    };
    add("icon", "🔭");
    add("when", o.when);
    add("title", o.expect);
    add("what", `👁 ${o.watch_for}`);
    add("what then", `➜ ${o.then_do}`);
    const ui = (typeof pack !== "undefined" && pack && pack.ui) || {};
    li.onclick = () => {
      stopSpeaking();
      spokenRecently = "";
      say(`${o.when}. ${o.expect} ${ui.if_you_see || ""} ${o.watch_for} ${ui.then_do || ""} ${o.then_do}`);
    };
    list.append(li);
  }
}

async function loadState() {
  try {
    const res = await fetch(`/api/state?f=${farmerId}`);
    if (!res.ok) throw new Error("state");
    const state = await res.json();
    setPlan(state.plan);
    setRecord(state.record);
  } catch {
    // No network: use the plan saved on the phone.
    try { setPlan(JSON.parse(store.get("plan"))); } catch {}
  }
}

async function start() {
  $("startNote").textContent = "";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
  } catch {
    $("startNote").textContent = "📷 ✕";
    return;
  }

  // Unlock sound with this tap.
  if (window.speechSynthesis) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (Ctx) {
    audioCtx ||= new Ctx();
    audioCtx.resume().catch(() => {});
  }

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (p) => { location_ = { lat: p.coords.latitude, lon: p.coords.longitude }; },
      () => {},
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 600000 },
    );
  }

  started = true;
  $("start").hidden = true;
  enablePush();
  if (Recognition) startListening();
  else if (window.MediaRecorder) tapToTalk = true;
  else showTyping(true);
  setInterval(watchCamera, 700);

  if (navigator.onLine) {
    openingWords();
    prepareOffline().then(syncCaptures).then(offerLLM);
  } else {
    loadPack().then(() => {
      const due = plan ? plan.steps.filter((s) => !s.done && s.date <= today()) : [];
      // The phone takes the conversation: tap the orb, speak, tap again.
      tapToTalk = true;
      recWanted = false;
      if (speaksEnglish() && llmDownloaded()) loadLLM();
      if (due.length) openingWords();
      else openSurvey(true);
    });
  }
}

// What the farmer hears on opening costs no AI call: due plan steps are read out, otherwise a saved greeting.
let readAloud = [];
async function openingWords() {
  const due = plan ? plan.steps.filter((s) => !s.done && s.date <= today()).slice(0, 2) : [];
  if (due.length) {
    readAloud = due.map((s) => s.id);
    $("ai").textContent = due.map((s) => s.instruction).join(" ");
    for (const s of due) say(s.instruction);
    return;
  }
  try {
    const { text } = await (await fetch(`/api/greeting?lang=${encodeURIComponent(lang)}`)).json();
    if (text && !turn && !utterance) {
      $("ai").textContent = text;
      say(text);
    }
  } catch {}
}

// ------------------------------------------------------------ wiring

const langSelect = $("lang");
for (const [code, name] of LANGS) langSelect.add(new Option(name, code));
langSelect.value = lang;
langSelect.onchange = () => {
  lang = langSelect.value;
  cloudVoice = true;
  pack = null;
  if (started) loadPack();
  store.set("lang", lang);
  document.documentElement.lang = lang;
  if (started) restartListening();
};
document.documentElement.lang = lang;

$("go").onclick = start;
$("langBtn").onclick = () => {
  bargeIn();
  $("start").hidden = false;
  $("go").onclick = () => {
    $("start").hidden = true;
    if (!started) start();
  };
};
$("planBtn").onclick = () => {
  enablePush();
  $("plan").hidden = false;
  drawPlan();
};
$("planClose").onclick = () => {
  stopSpeaking();
  $("plan").hidden = true;
  render();
};
$("plan").onclick = (e) => { if (e.target === $("plan")) $("planClose").onclick(); };
$("stopBtn").onclick = bargeIn;
$("orb").onclick = toggleRecording;
video.onclick = bargeIn;
$("keyBtn").onclick = () => showTyping($("typeForm").hidden);
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("typeInput").value.trim();
  $("typeInput").value = "";
  if (!text) return;
  $("you").textContent = text;
  if (!navigator.onLine) return offlineAsk({ text });
  sendTurn("say", text);
};

if (!navigator.mediaDevices || !window.isSecureContext) {
  $("startNote").textContent = "🔒 https";
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

loadState();
