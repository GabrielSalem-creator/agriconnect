// Everything the phone needs to help a farmer with no network: the words of the guided field
// survey and first-aid advice for every condition the on-device models can recognise.
// The English source lives here; each language's pack is written once and then cached.

export const PACK_VERSION = 1;

export const UI = {
  offline_intro:
    "There is no network. I will guide you to collect what I need and give you a first opinion now. The full analysis comes when the network is back.",
  survey_intro: "I will guide you step by step. Do what I say, then press the big button.",
  pick_crop: "Which crop has the problem?",
  crop_tomato: "Tomato",
  crop_potato: "Potato",
  crop_maize: "Maize",
  crop_rice: "Rice",
  crop_wheat: "Wheat",
  crop_pepper: "Pepper",
  crop_grape: "Grape",
  crop_apple: "Apple",
  crop_citrus: "Citrus",
  crop_other: "Another crop",
  p_field: "Step back and take a photo of the whole field.",
  p_plant: "Take a photo of one whole sick plant, from the soil to the top.",
  p_leaf: "Hold one sick leaf a hand's width from the camera, in good light, and take a photo.",
  p_under: "Turn that leaf over and take a photo of the underside.",
  p_stem: "Take a photo of the bottom of the stem, where it meets the soil.",
  p_roots: "Pull one sick plant out gently and take a photo of its roots.",
  p_soil: "Dig a hole as deep as your hand next to a sick plant and take a photo of the soil inside.",
  skip: "Skip",
  q_when: "When did the problem start?",
  "q_when.0": "A few days ago",
  "q_when.1": "About a week ago",
  "q_when.2": "More than two weeks ago",
  q_pattern: "Where in the field is the problem?",
  "q_pattern.0": "A few plants here and there",
  "q_pattern.1": "In patches",
  "q_pattern.2": "The whole field",
  "q_pattern.3": "Along the edges or in low spots",
  q_leaves: "Which leaves got sick first?",
  "q_leaves.0": "The bottom leaves",
  "q_leaves.1": "The top leaves",
  "q_leaves.2": "All at the same time",
  q_water: "How does the crop get water?",
  "q_water.0": "Rain only",
  "q_water.1": "Furrows or flooding",
  "q_water.2": "By hand or drip",
  "q_water.3": "Sprinkler",
  q_weather: "How was the weather these past days?",
  "q_weather.0": "Dry and hot",
  "q_weather.1": "Normal",
  "q_weather.2": "A lot of rain",
  "q_weather.3": "Cold",
  q_applied: "What have you put on the crop recently?",
  "q_applied.0": "Nothing",
  "q_applied.1": "Fertiliser",
  "q_applied.2": "A spray against pests or disease",
  "q_applied.3": "Both",
  q_size: "How big is the plot?",
  "q_size.0": "A small garden",
  "q_size.1": "About a quarter of a hectare",
  "q_size.2": "About half a hectare",
  "q_size.3": "A hectare or more",
  voice_note: "If you want, press the button and tell me anything else about the problem. Press again when you finish.",
  looks_like: "From the photo, this looks like",
  fairly_sure: "I am fairly sure.",
  not_very_sure: "I am not very sure.",
  not_sure: "I cannot tell from this photo alone.",
  healthy: "This leaf looks healthy to me.",
  do_now: "What you can do now:",
  saved_wait: "I have saved everything. When the network is back I will analyse it fully and prepare your plan.",
  syncing: "The network is back. I am analysing what you collected.",
  watch_title: "What may come next",
  if_you_see: "If you see this:",
  then_do: "Do this:",
};

// id, and the plain English name the advice is written for.
export const CONDITIONS = [
  ["apple.scab", "apple scab"],
  ["apple.black_rot", "apple black rot"],
  ["apple.cedar_rust", "cedar apple rust"],
  ["cherry.powdery_mildew", "cherry powdery mildew"],
  ["maize.gray_leaf_spot", "maize gray leaf spot (Cercospora)"],
  ["maize.common_rust", "maize common rust"],
  ["maize.northern_leaf_blight", "maize northern leaf blight"],
  ["grape.black_rot", "grape black rot"],
  ["grape.esca", "grape esca (black measles)"],
  ["grape.leaf_blight", "grape Isariopsis leaf spot"],
  ["citrus.greening", "citrus greening (huanglongbing)"],
  ["peach.bacterial_spot", "peach bacterial spot"],
  ["pepper.bacterial_spot", "pepper bacterial spot"],
  ["potato.early_blight", "potato early blight"],
  ["potato.late_blight", "potato late blight"],
  ["squash.powdery_mildew", "squash powdery mildew"],
  ["strawberry.leaf_scorch", "strawberry leaf scorch"],
  ["tomato.bacterial_spot", "tomato bacterial spot"],
  ["tomato.early_blight", "tomato early blight"],
  ["tomato.late_blight", "tomato late blight"],
  ["tomato.leaf_mold", "tomato leaf mold"],
  ["tomato.septoria", "tomato Septoria leaf spot"],
  ["tomato.spider_mites", "spider mites on tomato"],
  ["tomato.target_spot", "tomato target spot"],
  ["tomato.yellow_leaf_curl", "tomato yellow leaf curl virus"],
  ["tomato.mosaic", "tomato mosaic virus"],
  ["rice.brown_spot", "rice brown spot"],
  ["rice.leaf_blast", "rice leaf blast"],
  ["wheat.brown_rust", "wheat brown (leaf) rust"],
  ["wheat.yellow_rust", "wheat yellow (stripe) rust"],
];

export function packPrompt(lang) {
  return `You are preparing the offline help of a farming app for smallholder farmers. It is read aloud by a phone to farmers who may not read, when they have no network. Write in the language with BCP-47 code ${lang}, in the plain everyday spoken words a farmer there uses. No markdown, no symbols, no lists inside strings.

Return one JSON object and nothing else, with exactly two keys:

"ui": an object with the same keys as the UI object below, each value translated into ${lang}. Keep them short and natural to say aloud.

"conditions": an object with one entry per condition id below. Each entry has:
- "name": the common name of the problem in ${lang}, as a farmer would say it, in a few words.
- "what": one sentence on how to recognise it.
- "now": an array of exactly three short sentences, each one thing the farmer can do today with low-cost means. If a purchased product is the right answer, name the kind of product and its active ingredient, and say to follow the dose on the label and protect skin, mouth and eyes. Never give a dose.
- "later": one sentence on how to stop it coming back next season.

UI:
${JSON.stringify(UI)}

Conditions (id: English name):
${CONDITIONS.map(([id, name]) => `${id}: ${name}`).join("\n")}`;
}

// Accept a generated pack only if it is complete.
export function validPack(pack) {
  if (!pack || typeof pack.ui !== "object" || typeof pack.conditions !== "object") return false;
  if (Object.keys(UI).some((k) => typeof pack.ui[k] !== "string" || !pack.ui[k])) return false;
  return CONDITIONS.every(([id]) => {
    const c = pack.conditions[id];
    return c && typeof c.name === "string" && typeof c.what === "string" && Array.isArray(c.now) && c.now.length > 0;
  });
}
