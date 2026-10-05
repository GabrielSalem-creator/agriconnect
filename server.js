import http from "node:http";
import fs from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import webpush from "web-push";
import { SYSTEM_PROMPT, TOOLS } from "./prompt.js";
import { PACK_VERSION, UI, packPrompt, validPack } from "./offline-pack.js";

// Local development reads keys from .env; a hosting platform provides them as environment variables.
try {
  process.loadEnvFile();
} catch {}

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(here, "public");
// Some hosts make the app folder read-only, so use the first folder that can actually be written to.
function pickDataDir() {
  for (const dir of [process.env.AGRI_DATA_DIR, path.join(here, "data"), path.join(os.tmpdir(), "agriconnect-data")]) {
    if (!dir) continue;
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "_writable"), "");
      return dir;
    } catch {}
  }
  throw new Error("No writable folder for data. Set AGRI_DATA_DIR to one.");
}
const DATA = pickDataDir();

const PORT = Number(process.env.PORT || 3000);
const MODEL = process.env.AGRI_MODEL || "claude-opus-5-5";
// Low effort keeps the voice loop fast; raise to "medium" for deeper reasoning per turn.
const EFFORT = process.env.AGRI_EFFORT || "low";
const USE_FALLBACKS = process.env.AGRI_FALLBACKS !== "off";

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY || "";
const VOICE = process.env.AGRI_VOICE || "EXAVITQu4vr4xnSDxMaL";
// Spoken characters allowed per day, so a busy day cannot drain the voice quota.
const TTS_DAILY_CHARS = Number(process.env.AGRI_TTS_DAILY_CHARS || 40000);
// The fast, cheap voice model covers these languages; the wider model covers the rest it can.
const TTS_FAST = new Set("en,ja,zh,de,hi,fr,ko,pt,it,es,ru,id,nl,tr,fil,pl,sv,bg,ro,ar,cs,el,fi,hr,ms,sk,da,ta,uk,hu,no,vi".split(","));
const TTS_WIDE = new Set(
  "af,ar,hy,as,ast,az,be,bn,bs,bg,my,yue,ca,ceb,ny,hr,cs,da,nl,en,et,fil,fi,fr,gl,ka,de,el,gu,ha,he,hi,hu,is,id,ga,it,ja,jv,kn,kk,ky,ko,lv,ln,lt,lb,mk,ms,ml,mt,zh,mi,mr,mn,ne,no,oc,or,ps,fa,pl,pt,pa,ro,ru,sr,sd,sk,sl,so,es,sw,sv,tg,ta,te,th,tr,uk,ur,uz,vi,cy,yo".split(","),
);

const MAX_FRAMES = 2;
const MAX_REPORT_FRAMES = 8;
const MAX_FRAME_B64 = 600_000;
const VISIT_GAP_MS = 3 * 60 * 60 * 1000;
const VISIT_MAX_IMAGES = 40;
const ID_RE = /^[a-z0-9-]{8,40}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{8,24}$/;
const REMINDER_WINDOW_MS = 12 * 60 * 60 * 1000;

let client;
const anthropic = () => (client ??= new Anthropic());

// ---------------------------------------------------------------- storage

const farmerFile = (id) => path.join(DATA, `${id}.json`);

async function loadFarmer(id) {
  try {
    return JSON.parse(await fs.readFile(farmerFile(id), "utf8"));
  } catch {
    return { id, lang: "en-US", location: null, notes: "", plan: null, carry: "", visit: null };
  }
}

async function saveFarmer(farmer) {
  await fs.mkdir(DATA, { recursive: true });
  const tmp = farmerFile(farmer.id) + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(farmer));
  await fs.rename(tmp, farmerFile(farmer.id));
  indexReminders(farmer);
}

// ---------------------------------------------------------------- reminders

// When a plan step is due in the farmer's own timezone (tz = minutes behind UTC, as the browser reports it).
const dueAt = (step, tz) => Date.parse(`${step.date}T${step.time}:00Z`) + (Number(tz) || 0) * 60000;

// farmer id -> time of the next reminder to push, so the scheduler never has to scan the files.
const nextReminder = new Map();
function indexReminders(farmer) {
  let next = Infinity;
  if (farmer.push && farmer.plan) {
    for (const s of farmer.plan.steps) if (!s.done && !s.notified) next = Math.min(next, dueAt(s, farmer.tz));
  }
  if (next === Infinity) nextReminder.delete(farmer.id);
  else nextReminder.set(farmer.id, next);
}

let vapidPublicKey = "";
async function initPush() {
  await fs.mkdir(DATA, { recursive: true });
  const file = path.join(DATA, "_vapid.json");
  let keys;
  try {
    // Fixed keys from the environment survive redeploys, so phones stay subscribed to reminders.
    keys = process.env.VAPID_PUBLIC_KEY
      ? { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }
      : JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    keys = webpush.generateVAPIDKeys();
    await fs.writeFile(file, JSON.stringify(keys));
  }
  webpush.setVapidDetails(process.env.AGRI_CONTACT || "mailto:agriconnect@example.org", keys.publicKey, keys.privateKey);
  vapidPublicKey = keys.publicKey;
  for (const name of await fs.readdir(DATA)) {
    if (name.startsWith("_") || !name.endsWith(".json")) continue;
    indexReminders(await loadFarmer(name.slice(0, -5)));
  }
}

async function sendReminders() {
  const now = Date.now();
  for (const [id, at] of nextReminder) {
    if (at > now) continue;
    await withLock(id, async () => {
      const farmer = await loadFarmer(id);
      for (const s of farmer.plan?.steps || []) {
        const due = dueAt(s, farmer.tz);
        if (s.done || s.notified || due > now || !farmer.push) continue;
        s.notified = true;
        if (now - due > REMINDER_WINDOW_MS) continue;
        try {
          await webpush.sendNotification(
            farmer.push,
            JSON.stringify({ title: (s.check_with_camera ? "📷 " : "🌱 ") + s.title, body: s.instruction, tag: s.id }),
            { TTL: REMINDER_WINDOW_MS / 1000 },
          );
          console.log(`[${id.slice(0, 8)}] reminder sent: ${s.id}`);
        } catch (err) {
          // The phone dropped this subscription; it will re-subscribe next time the app opens.
          if (err.statusCode === 404 || err.statusCode === 410) farmer.push = null;
          else console.error(`[${id.slice(0, 8)}] reminder failed:`, err.statusCode || err.message);
        }
      }
      await saveFarmer(farmer);
    }).catch((err) => console.error(err));
  }
}

// ---------------------------------------------------------------- farm record

const shareFile = (token) => path.join(DATA, `_share-${token}`);
const recordUrl = (farmer) => (farmer.record && farmer.share ? `/r/${farmer.share}` : "");

// How faithfully the farmer has followed the plans so far, counting steps whose day has come.
function adherence(farmer, today) {
  const past = farmer.stats || { due: 0, done: 0, checkins: 0 };
  const steps = (farmer.plan?.steps || []).filter((s) => s.date <= today || s.done);
  return {
    due: past.due + steps.length,
    done: past.done + steps.filter((s) => s.done).length,
    checkins: past.checkins + steps.filter((s) => s.done && s.check_with_camera).length,
  };
}

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const num = (n) => (Number(n) || 0).toLocaleString("en-US", { maximumFractionDigits: 1 });

function recordPage(farmer) {
  const r = farmer.record;
  const a = adherence(farmer, serverDate());
  const inputsTotal = r.inputs.reduce((sum, i) => sum + i.cost, 0);
  const value = (y) => (r.price_per_unit ? `${num(y * r.price_per_unit)} ${esc(r.currency)}` : "—");
  const row = (label, val) => `<tr><th>${label}</th><td>${val}</td></tr>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Farm record</title>
<style>
body{margin:0;background:#f3f6f0;color:#14210f;font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:640px;margin:0 auto;padding:16px}
h1{font-size:22px;margin:8px 0 2px}h2{font-size:15px;text-transform:uppercase;letter-spacing:.6px;color:#55624d;margin:22px 0 8px}
.sub{color:#55624d;font-size:14px;margin:0}.say{background:#1f7a3d;color:#fff;border-radius:14px;padding:14px;font-size:18px;margin:14px 0}
.card{background:#fff;border-radius:14px;padding:6px 14px}table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:9px 0;border-bottom:1px solid #e6ebe1;vertical-align:top}tr:last-child th,tr:last-child td{border:0}
th{font-weight:500;color:#55624d;width:42%;padding-right:10px}td{font-weight:600}.big{font-size:22px}
.note{font-size:13px;color:#55624d;margin:18px 0}button{width:100%;padding:15px;border:0;border-radius:14px;background:#14210f;color:#fff;font-size:17px;margin-top:8px}
@media print{button{display:none}body{background:#fff}}
</style></head><body><main>
<h1>🌱 Farm record</h1>
<p class="sub">Updated ${esc(r.updatedAt)} · AgriConnect field assistant</p>
${r.farmer_summary ? `<p class="say" dir="auto">${esc(r.farmer_summary)}</p>` : ""}
<h2>Crop</h2><div class="card"><table>
${row("Crop", esc(r.crop) || "—")}
${row("Plot", r.plot_area ? `${num(r.plot_area)} ${esc(r.area_unit)}` : "—")}
${row("Growth stage", esc(r.growth_stage) || "—")}
${row("Condition", esc(r.crop_condition) || "—")}
${farmer.location ? row("Location", `${farmer.location.lat}, ${farmer.location.lon}`) : ""}
</table></div>
<h2>Expected harvest</h2><div class="card"><table>
${row("Estimate", `<span class="big">${num(r.yield_expected)} ${esc(r.yield_unit)}</span>`)}
${row("Range", `${num(r.yield_low)} – ${num(r.yield_high)} ${esc(r.yield_unit)}`)}
${row("Expected sale value", value(r.yield_expected))}
${row("Value range", r.price_per_unit ? `${value(r.yield_low)} – ${value(r.yield_high)}` : "—")}
${row("Basis", esc(r.yield_basis) || "—")}
</table></div>
<h2>Inputs needed</h2><div class="card"><table>
${r.inputs.map((i) => row(`${esc(i.item)}<br><small>${esc(i.quantity)}</small>`, `${num(i.cost)} ${esc(r.currency)}`)).join("") || row("None recorded", "—")}
${r.inputs.length ? row("Total financing need", `<span class="big">${num(inputsTotal)} ${esc(r.currency)}</span>`) : ""}
</table></div>
<h2>Track record</h2><div class="card"><table>
${row("Plan steps completed", a.due ? `${a.done} of ${a.due} (${Math.round((a.done / a.due) * 100)}%)` : "No steps due yet")}
${row("Camera check-ins done", a.checkins)}
${farmer.plan ? row("Current diagnosis", `${esc(farmer.plan.diagnosis)} (confidence ${esc(farmer.plan.confidence)})`) : ""}
</table></div>
<p class="note">Figures are estimates made by an AI assistant from phone-camera images and the farmer's own statements. They are not measured or independently verified and are not a credit decision.</p>
<button onclick="navigator.share?navigator.share({title:document.title,url:location.href}):navigator.clipboard.writeText(location.href).then(()=>this.textContent='Link copied')">Share this record</button>
<button onclick="print()">Print</button>
</main></body></html>`;
}

// One turn at a time per farmer, so an interrupted turn settles before the next starts.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => locks.get(id) === tail && locks.delete(id));
  return run;
}

// ---------------------------------------------------------------- helpers

const clean = (s, max) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

function addDays(date, n) {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const serverDate = () => new Date().toISOString().slice(0, 10);

function parseLocation(loc) {
  const lat = Number(loc?.lat);
  const lon = Number(loc?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat: Math.round(lat * 1000) / 1000, lon: Math.round(lon * 1000) / 1000 };
}

// Altitude and recent/forecast weather for the field, from Open-Meteo (no key needed).
async function fetchWeather({ lat, lon }) {
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}` +
      `&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&past_days=7&forecast_days=16&timezone=auto`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return "";
    const w = await res.json();
    const days = w.daily.time.map(
      (t, i) =>
        `${t}: ${w.daily.temperature_2m_min[i]}–${w.daily.temperature_2m_max[i]}°C, rain ${w.daily.precipitation_sum[i]} mm`,
    );
    return `Altitude about ${Math.round(w.elevation)} m. Daily weather, past week then the forecast for the next two weeks:\n${days.join("\n")}`;
  } catch {
    return "";
  }
}

function planForModel(plan, today) {
  if (!plan) return "No plan saved yet.";
  const steps = plan.steps.map((s) => {
    const status = s.done ? "done" : s.date < today ? "OVERDUE" : s.date === today ? "DUE TODAY" : "upcoming";
    return `- ${s.id} [${status}] ${s.date} ${s.time}${s.check_with_camera ? " (camera check-in)" : ""}: ${s.instruction}${s.expect ? ` | expected if diagnosis is right: ${s.expect}` : ""}`;
  });
  const outlook = (plan.outlook || []).map(
    (o) => `- around ${o.date}: expect ${o.expect_en} | watch for: ${o.watch_for} | then: ${o.then_do}`,
  );
  return `Diagnosis: ${plan.diagnosis} (confidence ${plan.confidence}). Plan saved on ${plan.createdAt}.\n${steps.join("\n")}${
    outlook.length ? `\nOutlook you gave for the weeks ahead:\n${outlook.join("\n")}` : ""
  }`;
}

// The last few spoken exchanges of the previous visit, text only.
function excerpt(visit) {
  if (!visit) return "";
  const lines = [];
  for (const m of visit.messages) {
    const blocks = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of blocks) {
      if (m.role === "assistant" && b.type === "tool_use" && b.name === "reply" && b.input?.speech) {
        lines.push(`You: ${String(b.input.speech).slice(0, 300)}`);
      }
      if (b.type !== "text" || !b.text) continue;
      if (m.role === "assistant") lines.push(`You: ${b.text.slice(0, 300)}`);
      else {
        const said = b.text.match(/Farmer says: "([\s\S]*)"/);
        if (said) lines.push(`Farmer: ${said[1].slice(0, 300)}`);
      }
    }
  }
  return lines.slice(-8).join("\n");
}

async function startVisit(farmer, today) {
  const previous = excerpt(farmer.visit);
  const where = farmer.location
    ? `Field location: latitude ${farmer.location.lat}, longitude ${farmer.location.lon}. ${await fetchWeather(farmer.location)}`
    : "Field location: unknown. Ask the farmer where they are when it matters.";
  const header = [
    "[App context for this visit]",
    `Farmer's language code: ${farmer.lang}.`,
    where,
    `Case notes from earlier visits: ${farmer.notes || "none, this is a new farmer."}`,
    `Plan: ${planForModel(farmer.plan, today)}`,
    farmer.record ? `Saved farm record: ${JSON.stringify(farmer.record)}` : "",
    previous ? `End of the previous conversation:\n${previous}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  farmer.visit = { header, messages: [], pending: [], images: 0, lastAt: Date.now() };
  return farmer.visit;
}

// ---------------------------------------------------------------- tools

function runTool(farmer, name, input, today, out) {
  switch (name) {
    case "reply": {
      out.ask = clean(input.show, 80);
      if (input.save === true) out.wantSave = true;
      const ids = new Set(Array.isArray(input.done_step_ids) ? input.done_step_ids : []);
      for (const step of farmer.plan?.steps || []) if (ids.has(step.id)) step.done = true;
      return "Delivered to the farmer.";
    }
    case "update_notes":
      farmer.notes = String(input.notes || "").slice(0, 6000);
      return "Notes saved.";
    case "save_plan": {
      const steps = (input.steps || [])
        .map((s) => ({
          date: addDays(today, Math.max(0, Math.min(365, Math.trunc(Number(s.day)) || 0))),
          time: /^([01]\d|2[0-3]):[0-5]\d$/.test(s.time) ? s.time : "07:00",
          title: clean(s.title, 80),
          instruction: clean(s.instruction, 600),
          check_with_camera: Boolean(s.check_with_camera),
          expect: clean(s.expect, 400),
          done: false,
        }))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))
        .map((s, i) => ({ id: `s${i + 1}`, ...s }));
      // Keep the track record of the plan being replaced.
      farmer.stats = adherence(farmer, today);
      farmer.plan = {
        diagnosis: clean(input.diagnosis, 400),
        confidence: input.confidence,
        summary: clean(input.summary, 400),
        createdAt: today,
        steps,
        // What is likely to come later in the season, and what to do if it does. Usable with no network.
        outlook: (Array.isArray(input.outlook) ? input.outlook : []).slice(0, 12).map((o) => ({
          date: addDays(today, Math.max(0, Math.min(365, Math.trunc(Number(o.day)) || 0))),
          when: clean(o.when, 120),
          expect: clean(o.expect, 400),
          expect_en: clean(o.expect_en, 300),
          watch_for: clean(o.watch_for, 300),
          then_do: clean(o.then_do, 500),
        })),
      };
      out.planChanged = true;
      return `Plan saved and added to the farmer's reminders. Step ids: ${steps.map((s) => `${s.id} (${s.date} ${s.time})`).join(", ")}.`;
    }
    case "save_farm_record": {
      farmer.record = {
        crop: clean(input.crop, 120),
        plot_area: Number(input.plot_area) || 0,
        area_unit: clean(input.area_unit, 30),
        growth_stage: clean(input.growth_stage, 120),
        crop_condition: clean(input.crop_condition, 500),
        yield_low: Number(input.yield_low) || 0,
        yield_expected: Number(input.yield_expected) || 0,
        yield_high: Number(input.yield_high) || 0,
        yield_unit: clean(input.yield_unit, 30),
        yield_basis: clean(input.yield_basis, 600),
        price_per_unit: Number(input.price_per_unit) || 0,
        currency: clean(input.currency, 20),
        inputs: (input.inputs || []).slice(0, 20).map((i) => ({
          item: clean(i.item, 120),
          quantity: clean(i.quantity, 80),
          cost: Number(i.cost) || 0,
        })),
        farmer_summary: clean(input.farmer_summary, 400),
        updatedAt: today,
      };
      farmer.share ||= randomBytes(9).toString("base64url");
      return "Farm record saved. The farmer can open and share it from the money button on screen.";
    }
    default:
      return "Unknown tool.";
  }
}

// ---------------------------------------------------------------- the turn

// A survey the farmer collected with the app's step-by-step guide, possibly hours ago with no network.
function surveyText(survey) {
  const sv = survey && typeof survey === "object" ? survey : {};
  const answers = Object.entries(sv.answers && typeof sv.answers === "object" ? sv.answers : {})
    .slice(0, 12)
    .map(([q, a]) => `- ${clean(q, 60)}: ${clean(a, 120)}`);
  const opinion = (Array.isArray(sv.opinion) ? sv.opinion : [])
    .slice(0, 3)
    .map((o) => `${clean(o.id, 40)} ${Math.round((Number(o.prob) || 0) * 100)}%`);
  return [
    `[Field survey the farmer collected with the app's guided survey at ${clean(sv.capturedAt, 60) || "an unknown time"}${sv.offline ? ", while there was no network" : ""}. The labelled photos above belong to it.]`,
    `Crop chosen by the farmer: ${clean(sv.crop, 40) || "not given"}`,
    answers.length ? `Answers:\n${answers.join("\n")}` : "",
    sv.note ? `Farmer's spoken note: "${clean(sv.note, 1500)}"` : "",
    sv.phoneSaid
      ? `With no network, the small language model on the phone already answered the farmer: "${clean(sv.phoneSaid, 800)}". It is weak; confirm or correct it plainly.`
      : "",
    opinion.length
      ? `First opinion of the small model on the phone, already told to the farmer: ${opinion.join(", ")}. It was trained mostly on clean laboratory photos and is often wrong in the field; treat it as a weak hint and correct it plainly if you disagree.`
      : "The model on the phone could not give an opinion.",
    "[Analyse all of it now. Tell the farmer what the problem is and the first thing to do, then save a full plan with an outlook, the farm record and notes. If something essential is missing, say what to show you next.]",
  ]
    .filter(Boolean)
    .join("\n");
}

// Tools whose arguments take many seconds to write.
const SLOW_TOOLS = new Set(["save_plan", "save_farm_record"]);
const SPEAK_FIRST =
  "[App: say your reply to the farmer now as plain text, in one to three short sentences. The app will ask you to save right after you have spoken.]";
const SAVE_NOW =
  "[App: the farmer has heard you. Now save: call save_plan, save_farm_record and update_notes, whichever apply. Write no text.]";
const SPEAK_NOW =
  "[App: the farmer has heard nothing from you this turn. Say your reply to them now as plain text, in their language, in one to three short sentences.]";

// The words written so far inside a half-streamed reply tool call.
function speechSoFar(raw) {
  const m = raw.match(/"speech"\s*:\s*"/);
  if (!m) return "";
  let body = raw.slice(m.index + m[0].length);
  let end = -1;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\\") i++;
    else if (body[i] === '"') {
      end = i;
      break;
    }
  }
  // Still being written: drop a half-finished escape at the end.
  body = end >= 0 ? body.slice(0, end) : body.replace(/\\(u[0-9a-fA-F]{0,3})?$/, "");
  try {
    return JSON.parse('"' + body + '"');
  } catch {
    return "";
  }
}

function startStream(messages, textOnly) {
  const params = {
    // In the fallback rounds the model may only speak, so the farmer is guaranteed to hear something.
    ...(textOnly ? { tool_choice: { type: "none" } } : {}),
    model: MODEL,
    max_tokens: 16000,
    output_config: { effort: EFFORT },
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    tools: TOOLS,
    messages,
  };
  if (!USE_FALLBACKS) return anthropic().messages.stream(params);
  // If a safety classifier declines a turn, the API re-runs it on a fallback model in the same call.
  return anthropic().beta.messages.stream({
    ...params,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });
}

async function runTurn(id, body, res, send) {
  const farmer = await loadFarmer(id);
  const kind = ["say", "open", "look", "report"].includes(body.kind) ? body.kind : "say";
  const text = clean(body.text, 2000);
  const today = DATE_RE.test(body.localDate) ? body.localDate : serverDate();

  // The farmer already moved on before this turn started: keep their words for the next one.
  if (res.destroyed) {
    if (text) {
      farmer.carry = [farmer.carry, text].filter(Boolean).join(" ");
      await saveFarmer(farmer);
    }
    return;
  }

  farmer.lang = clean(body.lang, 20) || farmer.lang;
  farmer.location = parseLocation(body.location) || farmer.location;
  if (Number.isFinite(body.tz)) farmer.tz = Math.max(-900, Math.min(900, body.tz));

  let visit = farmer.visit;
  if (!visit || Date.now() - visit.lastAt > VISIT_GAP_MS || visit.images > VISIT_MAX_IMAGES) {
    visit = await startVisit(farmer, today);
  }

  const frames = (Array.isArray(body.frames) ? body.frames : [])
    .filter((f) => typeof f === "string" && f.length > 100 && f.length < MAX_FRAME_B64 && /^[A-Za-z0-9+/=]+$/.test(f))
    .slice(kind === "report" ? -MAX_REPORT_FRAMES : -MAX_FRAMES);
  const frameLabels = Array.isArray(body.frameLabels) ? body.frameLabels.map((l) => clean(l, 60)) : [];

  const said = [farmer.carry, text].filter(Boolean).join(" ");
  const lines = [`[Local time: ${clean(body.clientTime, 80) || today}]`];
  if (body.interrupted) lines.push("[The farmer interrupted you; they did not hear the end of your last reply.]");
  if (kind === "report") lines.push(surveyText(body.survey));
  else if (frames.length) lines.push(`[${frames.length} camera frame(s) attached, oldest first; the last is the live view.]`);
  else if (kind === "say") lines.push("[No new frame: the camera view has not changed since the last one you saw.]");
  if (kind === "open") {
    lines.push(
      "[The farmer just opened the app. Greet them in one short sentence. If plan steps are due or overdue, tell them what to do now; otherwise ask what is wrong with their crop.]",
    );
  } else if (kind === "look" && !said) {
    lines.push("[The farmer is holding the camera on something without speaking. Look at it and continue.]");
  }
  const readAloud = (Array.isArray(body.readAloud) ? body.readAloud : []).map((s) => clean(s, 8)).filter(Boolean);
  if (readAloud.length) {
    lines.push(`[On opening, the app already read these due plan steps aloud to the farmer: ${readAloud.join(", ")}.]`);
  }
  if (said) lines.push(`Farmer says: "${said}"`);

  const content = [...visit.pending];
  if (!visit.messages.length) content.push({ type: "text", text: visit.header });
  frames.forEach((data, i) => {
    if (kind === "report" && frameLabels[i]) content.push({ type: "text", text: `Photo: ${frameLabels[i]}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } });
  });
  content.push({ type: "text", text: lines.join("\n") });
  const userMsg = { role: "user", content };

  // The farmer must hear the answer before anything slow happens. Writing a plan takes many seconds, so:
  //  - if the model starts a big save before speaking, that attempt is stopped and it is told to speak first,
  //    then asked to save once the words are out ("speakOnly" then "save");
  //  - if it makes only small tool calls and says nothing, the results go straight back so it speaks.
  const added = [userMsg];
  const out = { ask: "", planChanged: false };
  let partial = "";
  let pending = [];
  let mode = "normal";
  let saved = false;
  const commit = async () => {
    visit.messages.push(...added);
    visit.pending = pending;
    visit.images += frames.length;
    visit.lastAt = Date.now();
    farmer.carry = "";
    await saveFarmer(farmer);
    if (farmer.share) await fs.writeFile(shareFile(farmer.share), id);
  };

  for (;;) {
    const quiet = mode === "save";
    let roundText = "";
    let redo = false;
    const stream = startStream([...visit.messages, ...added], mode === "speakOnly" || mode === "speakAfterSilence");
    const replies = new Map(); // content block index -> reply call being streamed
    const onClose = () => stream.abort();
    res.on("close", onClose);
    stream.on("text", (delta) => {
      if (quiet) return;
      roundText += delta;
      partial += delta;
      send({ t: "delta", text: delta });
    });
    stream.on("streamEvent", (ev) => {
      if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta" && replies.has(ev.index) && !quiet) {
        const r = replies.get(ev.index);
        r.raw += ev.delta.partial_json;
        const speech = speechSoFar(r.raw);
        if (speech.length > r.sent) {
          const delta = speech.slice(r.sent);
          r.sent = speech.length;
          roundText += delta;
          partial += delta;
          send({ t: "delta", text: delta });
        }
        return;
      }
      if (ev.type !== "content_block_start" || ev.content_block.type !== "tool_use") return;
      if (ev.content_block.name === "reply") replies.set(ev.index, { raw: "", sent: 0 });
      if (!SLOW_TOOLS.has(ev.content_block.name)) return;
      if (mode === "normal" && !partial.trim()) {
        redo = true;
        stream.abort();
      } else if (!quiet) {
        send({ t: "saving" });
      }
    });

    let final;
    try {
      final = await stream.finalMessage();
    } catch (err) {
      if (!(err instanceof Anthropic.APIUserAbortError)) throw err;
      if (redo) {
        mode = "speakOnly";
        out.wantSave = true;
        userMsg.content.push({ type: "text", text: SPEAK_FIRST });
        continue;
      }
      // Interrupted by the farmer: keep what was said so far, or carry their words into the next turn.
      if (roundText.trim()) {
        added.push({ role: "assistant", content: [{ type: "text", text: roundText.trim() }] });
        pending = [];
        await commit();
      } else if (added.length > 1) {
        added.pop();
        await commit();
      } else {
        farmer.carry = said;
        visit.lastAt = Date.now();
        await saveFarmer(farmer);
      }
      return;
    } finally {
      res.off("close", onClose);
    }

    const u = final.usage;
    console.log(
      `[${id.slice(0, 8)}] ${kind}/${mode} in=${u.input_tokens} cached=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens} stop=${final.stop_reason}`,
    );

    if (final.stop_reason === "refusal") {
      if (added.length === 1) {
        send({ t: "error", message: "The assistant could not answer that. Please say it another way." });
        return;
      }
      added.pop();
      break;
    }
    if (final.stop_reason === "max_tokens") {
      // A cut-off turn may hold a truncated tool call; keep only the words.
      added.push({ role: "assistant", content: [{ type: "text", text: roundText.trim() || "…" }] });
      pending = [];
      break;
    }

    added.push({ role: "assistant", content: final.content });
    const calls = final.content.filter((block) => block.type === "tool_use");
    pending = calls.map((block) => ({
      type: "tool_result",
      tool_use_id: block.id,
      content: runTool(farmer, block.name, block.input || {}, today, out),
    }));

    if (calls.some((block) => SLOW_TOOLS.has(block.name))) saved = true;
    if (mode === "save") break;
    if (mode === "normal" && final.stop_reason === "tool_use" && !partial.trim()) {
      mode = "speakAfterSilence";
      added.push({ role: "user", content: [...pending, { type: "text", text: SPEAK_NOW }] });
      continue;
    }
    if (out.wantSave && !saved) {
      mode = "save";
      added.push({ role: "user", content: [...pending, { type: "text", text: SAVE_NOW }] });
      send({ t: "saving" });
      continue;
    }
    break;
  }

  await commit();
  send({ t: "done", ask: out.ask, plan: farmer.plan, record: recordUrl(farmer) });
}

function describe(err) {
  if (err instanceof Anthropic.AuthenticationError || /authentication|apiKey|api key/i.test(err?.message || "")) {
    return "Server has no valid Anthropic API key. Put ANTHROPIC_API_KEY in a .env file and restart.";
  }
  if (err instanceof Anthropic.RateLimitError) return "Too many requests right now. Try again in a moment.";
  if (err instanceof Anthropic.APIConnectionError) return "The server cannot reach the AI service.";
  if (err instanceof Anthropic.APIError) return `AI service error ${err.status}: ${err.message}`;
  return "Something went wrong on the server.";
}

// ---------------------------------------------------------------- http

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const readBody = async (req, limit) => (await readBuffer(req, limit)).toString("utf8");

function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleTurn(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 4_000_000));
  } catch {
    return json(res, 400, { error: "bad request" });
  }
  const id = String(body.farmer || "");
  if (!ID_RE.test(id)) return json(res, 400, { error: "bad farmer id" });

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Accel-Buffering": "no",
  });
  const send = (obj) => {
    if (!res.writableEnded && !res.destroyed) res.write(JSON.stringify(obj) + "\n");
  };
  try {
    await withLock(id, () => runTurn(id, body, res, send));
  } catch (err) {
    console.error(err);
    send({ t: "error", message: describe(err) });
  }
  res.end();
}

async function handleSubscribe(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 10_000));
  } catch {
    return json(res, 400, { error: "bad request" });
  }
  const id = String(body.farmer || "");
  const sub = body.subscription;
  if (!ID_RE.test(id) || typeof sub?.endpoint !== "string" || !sub.endpoint.startsWith("https://") || !sub.keys) {
    return json(res, 400, { error: "bad subscription" });
  }
  await withLock(id, async () => {
    const farmer = await loadFarmer(id);
    farmer.push = { endpoint: sub.endpoint, keys: { p256dh: String(sub.keys.p256dh), auth: String(sub.keys.auth) } };
    if (Number.isFinite(body.tz)) farmer.tz = Math.max(-900, Math.min(900, body.tz));
    await saveFarmer(farmer);
  });
  json(res, 200, { ok: true });
}

// ---------------------------------------------------------------- voice (ElevenLabs)

const TTS_CACHE = path.join(DATA, "_tts");
const ttsSpend = { day: "", chars: 0 };

async function handleTts(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req, 10_000));
  } catch {
    return json(res, 400, { error: "bad request" });
  }
  const text = clean(body.text, 600);
  const base = clean(body.lang, 20).split("-")[0].toLowerCase();
  const model = TTS_FAST.has(base) ? "eleven_flash_v2_5" : TTS_WIDE.has(base) ? "eleven_v4_turbo" : "";
  // 501 tells the app to use the phone's own voice for this language.
  if (!ELEVEN_KEY || !model) return json(res, 501, { error: "no cloud voice" });
  if (!text) return json(res, 400, { error: "no text" });

  const audio = (data) => {
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store" });
    res.end(data);
  };
  // The same sentence is never paid for twice.
  const file = path.join(TTS_CACHE, createHash("sha1").update(`${model}|${VOICE}|${base}|${text}`).digest("hex") + ".mp3");
  const cached = await fs.readFile(file).catch(() => null);
  if (cached) return audio(cached);

  const day = serverDate();
  if (ttsSpend.day !== day) Object.assign(ttsSpend, { day, chars: 0 });
  if (ttsSpend.chars + text.length > TTS_DAILY_CHARS) return json(res, 429, { error: "voice budget used" });

  const upstream = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}/stream?output_format=mp3_22050_32`,
    {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, language_code: base }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!upstream.ok) {
    console.error(`voice error ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
    // Out of quota or bad key: the app stops asking and uses the phone's voice.
    return json(res, [401, 402, 429].includes(upstream.status) ? 429 : 502, { error: "voice failed" });
  }
  const data = Buffer.from(await upstream.arrayBuffer());
  ttsSpend.chars += text.length;
  await fs.mkdir(TTS_CACHE, { recursive: true });
  await fs.writeFile(file, data);
  audio(data);
}

// The opening words, translated once per language and then reused for every farmer at no cost.
const GREETING = "Hello. Tell me what is wrong with your crop, and show it to me with the camera.";
const GREETINGS_FILE = path.join(DATA, "_greetings.json");
let greetings = null;

async function handleGreeting(res, lang) {
  lang = /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : "en-US";
  greetings ??= await fs.readFile(GREETINGS_FILE, "utf8").then(JSON.parse).catch(() => ({ "en-US": GREETING }));
  if (!greetings[lang]) {
    const msg = await anthropic().messages.create({
      model: MODEL,
      max_tokens: 2000,
      output_config: { effort: "low" },
      messages: [
        {
          role: "user",
          content: `Translate this into the language with BCP-47 code ${lang}, in the simple everyday spoken words a farmer there would use. Reply with the translation only.\n\n${GREETING}`,
        },
      ],
    });
    const text = clean(msg.content.find((b) => b.type === "text")?.text, 300);
    if (!text) return json(res, 200, { text: "" });
    greetings[lang] = text;
    await fs.writeFile(GREETINGS_FILE, JSON.stringify(greetings));
  }
  json(res, 200, { text: greetings[lang] });
}

// The offline pack for one language: bundled with the code if present, otherwise written once and cached.
const packs = new Map();
async function handlePack(res, lang) {
  lang = /^[A-Za-z]{2,3}(-[A-Za-z]{2,4})?$/.test(lang) ? lang : "en-US";
  if (!packs.has(lang)) {
    packs.set(
      lang,
      (async () => {
        const name = `${lang}.json`;
        for (const file of [path.join(here, "packs", name), path.join(DATA, "_packs", name)]) {
          const saved = await fs.readFile(file, "utf8").then(JSON.parse).catch(() => null);
          if (saved?.version === PACK_VERSION && validPack(saved)) return saved;
        }
        // Long structured output occasionally comes back incomplete; try a few times before giving up.
        let pack = null;
        for (let attempt = 0; attempt < 3 && !pack; attempt++) {
          const msg = await anthropic()
            .messages.stream({
              model: MODEL,
              max_tokens: 32000,
              output_config: { effort: "low" },
              messages: [{ role: "user", content: packPrompt(lang) }],
            })
            .finalMessage();
          const text = msg.content.find((b) => b.type === "text")?.text || "";
          try {
            const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
            if (validPack(parsed)) pack = parsed;
          } catch {}
        }
        if (!pack) throw new Error("incomplete offline pack");
        if (lang.toLowerCase().startsWith("en")) pack.ui = UI;
        pack.version = PACK_VERSION;
        pack.lang = lang;
        await fs.mkdir(path.join(DATA, "_packs"), { recursive: true });
        await fs.writeFile(path.join(DATA, "_packs", name), JSON.stringify(pack));
        return pack;
      })(),
    );
  }
  try {
    json(res, 200, await packs.get(lang));
  } catch (err) {
    packs.delete(lang);
    console.error("offline pack failed:", err.message);
    // English words are better than none.
    json(res, 503, { version: 0, lang: "en-US", ui: UI, conditions: {} });
  }
}

// The in-browser model runtime, served from the installed package so the phone can keep it for offline use.
const ORT_DIR = path.join(here, "node_modules", "onnxruntime-web", "dist");
const ORT_FILES = new Set(["ort.wasm.min.js", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"]);
async function serveRuntime(name, res) {
  if (!ORT_FILES.has(name)) return json(res, 404, { error: "not found" });
  const data = await fs.readFile(path.join(ORT_DIR, name));
  res.writeHead(200, {
    "Content-Type": name.endsWith(".wasm") ? "application/wasm" : "text/javascript; charset=utf-8",
    "Cache-Control": "public, max-age=604800",
  });
  res.end(data);
}

// Speech recognition for phones whose browser has none built in.
async function handleStt(req, res) {
  if (!ELEVEN_KEY) return json(res, 501, { error: "no cloud speech recognition" });
  const audio = await readBuffer(req, 3_000_000);
  if (audio.length < 1000) return json(res, 200, { text: "" });
  const form = new FormData();
  form.append("file", new Blob([audio], { type: req.headers["content-type"] || "audio/webm" }), "speech");
  form.append("model_id", "scribe_v1");
  form.append("tag_audio_events", "false");
  const upstream = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": ELEVEN_KEY },
    body: form,
    signal: AbortSignal.timeout(30000),
  });
  if (!upstream.ok) {
    console.error(`speech recognition error ${upstream.status}: ${(await upstream.text()).slice(0, 300)}`);
    return json(res, 502, { error: "speech recognition failed" });
  }
  json(res, 200, { text: clean((await upstream.json()).text, 2000) });
}

const icsEscape = (s) => String(s).replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/([,;])/g, "\\$1");

function planToIcs(farmer) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//AgriConnect//Plan//EN", "CALSCALE:GREGORIAN"];
  for (const s of farmer.plan?.steps || []) {
    if (s.done) continue;
    // Floating local time: the phone's calendar reads it in the farmer's own timezone.
    const start = `${s.date.replace(/-/g, "")}T${s.time.replace(":", "")}00`;
    out.push(
      "BEGIN:VEVENT",
      `UID:${farmer.id}-${farmer.plan.createdAt}-${s.id}@agriconnect`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${start}`,
      "DURATION:PT15M",
      `SUMMARY:${icsEscape((s.check_with_camera ? "📷 " : "🌱 ") + s.title)}`,
      `DESCRIPTION:${icsEscape(s.instruction)}`,
      "BEGIN:VALARM",
      "ACTION:DISPLAY",
      `DESCRIPTION:${icsEscape(s.title)}`,
      "TRIGGER:PT0M",
      "END:VALARM",
      "END:VEVENT",
    );
  }
  out.push("END:VCALENDAR");
  return out.join("\r\n") + "\r\n";
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res, 404, { error: "not found" });
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

await initPush();
setInterval(() => sendReminders().catch((err) => console.error(err)), 30_000);

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "POST" && url.pathname === "/api/turn") return await handleTurn(req, res);
      if (req.method === "POST" && url.pathname === "/api/subscribe") return await handleSubscribe(req, res);
      if (req.method === "POST" && url.pathname === "/api/tts") return await handleTts(req, res);
      if (req.method === "POST" && url.pathname === "/api/stt") return await handleStt(req, res);
      if (req.method === "GET" && url.pathname === "/api/greeting") {
        return await handleGreeting(res, url.searchParams.get("lang") || "").catch(() => json(res, 200, { text: "" }));
      }
      if (req.method === "GET" && url.pathname === "/api/pack") return await handlePack(res, url.searchParams.get("lang") || "");
      if (req.method === "GET" && url.pathname.startsWith("/vendor/ort/")) return await serveRuntime(url.pathname.slice(12), res);
      if (req.method === "GET" && url.pathname === "/api/push-key") return json(res, 200, { key: vapidPublicKey });
      if (req.method === "GET" && url.pathname.startsWith("/r/")) {
        const token = url.pathname.slice(3);
        const id = TOKEN_RE.test(token) ? await fs.readFile(shareFile(token), "utf8").catch(() => "") : "";
        const farmer = ID_RE.test(id) ? await loadFarmer(id) : null;
        if (!farmer?.record) return json(res, 404, { error: "not found" });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(recordPage(farmer));
      }
      if (req.method === "GET" && (url.pathname === "/api/state" || url.pathname === "/api/plan.ics")) {
        const id = url.searchParams.get("f") || "";
        if (!ID_RE.test(id)) return json(res, 400, { error: "bad farmer id" });
        const farmer = await loadFarmer(id);
        if (url.pathname === "/api/state") return json(res, 200, { plan: farmer.plan, record: recordUrl(farmer) });
        res.writeHead(200, {
          "Content-Type": "text/calendar; charset=utf-8",
          "Content-Disposition": 'attachment; filename="farm-plan.ics"',
        });
        return res.end(planToIcs(farmer));
      }
      if (req.method === "GET") return await serveStatic(url.pathname, res);
      json(res, 405, { error: "method not allowed" });
    } catch (err) {
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: "server error" });
      else res.end();
    }
  })
  // Bind every interface so the host's proxy can reach the app inside its container.
  .listen(PORT, "0.0.0.0", () => {
    console.log(`AgriConnect running on http://localhost:${PORT}  (model ${MODEL}, effort ${EFFORT}, data in ${DATA})`);
  });
