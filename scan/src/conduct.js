/*
  scan/src/conduct.js — the conductor's desk.

  It holds no audio and no synthesis: it reads cues.json, keeps a pointer into
  the cue list, and sends three kinds of message over the bridge's WebSocket,
  one per part the cue speaks to:

      /cue/prep  <cue> <partId> <instruction>   arm: the light goes amber and
                                                the player reads what is coming
      /cue/count <beat> <partId>                a visible count-in beat
      /cue/go    <cue> <partId> <instruction>   the downbeat: flash, and the
                                                instruction swaps
      /cue/clear <partId>                       never mind
      /cue/state <cue> <partId> <instruction>   the standing cue, repeated, so a
                                                player who reloads catches up
                                                without being given a downbeat

  A part with nothing to say in a cue is sent nothing at all, so its light stays
  dark. That is the difference between "hold what you are doing" and "there is
  no cue for you here", and it has to survive the wire.
*/

const BUILD = "2026-09-18d";
const $ = (id) => document.getElementById(id);

let cues = [];
let parts = [];
let at = 0; // where the pointer is in the cue list
let armed = null; // the cue index currently prepped, or null
let landed = null; // the last cue actually fired
let ws = null;
let countTimer = null;

/* ================================================================ *
 *  the wire
 * ================================================================ */

function send(address, args) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ address, args }));
}

function connectWS() {
  const pill = $("wsStatus");
  const port = location.port || (location.protocol === "https:" ? 443 : 80);
  const url = `${location.protocol === "https:" ? "wss" : "ws"}://${location.hostname}:${port}/`;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    pill.textContent = "bridge: —";
    return;
  }
  ws.addEventListener("open", () => {
    pill.textContent = `bridge: ${location.hostname}:${port}`;
    pill.className = "pill on";
    send("/cue/ping", []); // anyone out there?
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    (Array.isArray(message) ? message : [message]).forEach((m) => {
      if (m && m.address === "/player/hello") heard(m.args || []);
    });
  });
  ws.addEventListener("close", () => {
    pill.textContent = "bridge: offline";
    pill.className = "pill off";
    ws = null;
    setTimeout(connectWS, 2000);
  });
  ws.addEventListener("error", () => {});
}

/* ================================================================ *
 *  who is out there
 * ================================================================ */

/* Two players on a part is the normal case, so the roster counts machines, not
 * parts: each laptop is remembered separately by the id the page gives itself,
 * and a part shows how many of them are currently answering. */
const seen = new Map(); // machine id -> { at, part, name, cue }

function heard(args) {
  const partId = String(args[0]);
  const machine = args[3] !== undefined ? String(args[3]) : `${partId}:only`;
  seen.set(machine, {
    at: Date.now(),
    part: partId,
    name: String(args[1] || partId),
    cue: Number(args[2]),
  });
  paintRoster();
}

/** the machines on a part that have said anything recently */
function hereFor(partId) {
  const out = [];
  seen.forEach((info) => {
    if (info.part === String(partId) && Date.now() - info.at < 9000) out.push(info);
  });
  return out;
}

function paintRoster() {
  const host = $("roster");
  host.innerHTML = "";
  parts.forEach((p) => {
    const row = document.createElement("div");
    const here = hereFor(p.id);
    row.className = "who" + (here.length ? " here" : "");
    const cues = [...new Set(here.filter((i) => i.cue >= 0).map((i) => i.cue))];
    const where = !here.length
      ? "nobody"
      : cues.length === 0
        ? "no cue yet"
        : cues.length === 1
          ? `cue ${cues[0]}`
          : `cues ${cues.sort((a, b) => a - b).join(", ")}`; // someone is adrift
    row.innerHTML =
      `<span class="dot"></span><span class="name">${p.name}</span>` +
      `<span class="count">${here.length}</span>` +
      `<span class="at">${where}</span>`;
    row.title = here.length
      ? `${here.length} ${here.length === 1 ? "player" : "players"} on ${p.name}`
      : `nobody is on ${p.name}`;
    host.appendChild(row);
  });
  const total = [...seen.values()].filter((i) => Date.now() - i.at < 9000).length;
  const sum = $("rosterTotal");
  if (sum) sum.textContent = `${total} connected`;
}
setInterval(paintRoster, 2000);

/* ================================================================ *
 *  the cues
 * ================================================================ */

async function loadAll() {
  try {
    const response = await fetch("/scan/parts.json", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      if (data && Array.isArray(data.parts)) parts = data.parts;
    }
  } catch (e) {
    /* fall through */
  }
  if (!parts.length) {
    parts = [
      { id: "1", name: "I" },
      { id: "2", name: "II" },
      { id: "3", name: "III" },
      { id: "4", name: "IV" },
    ];
  }
  try {
    const response = await fetch("/scan/cues.json", { cache: "no-store" });
    if (response.ok) {
      const data = await response.json();
      cues = (data && data.cues) || [];
    }
  } catch (e) {
    cues = [];
  }
  at = Math.min(at, Math.max(0, cues.length - 1));
  // A cue's id is what the players are told and what you call out in rehearsal,
  // so two cues answering to the same number is worth catching before a
  // performance rather than during one.
  const counts = new Map();
  cues.forEach((c, i) => {
    const id = String(c.id || i + 1);
    counts.set(id, (counts.get(id) || 0) + 1);
  });
  const dupes = [...counts.entries()].filter(([, n]) => n > 1).map(([id]) => id);
  const warn = $("cueWarn");
  if (warn) {
    warn.hidden = dupes.length === 0;
    warn.textContent = dupes.length
      ? `duplicate cue ${dupes.length === 1 ? "id" : "ids"}: ${dupes.join(", ")}`
      : "";
  }
  if (dupes.length) console.warn(`Tract conductor: duplicate cue ids in cues.json — ${dupes.join(", ")}`);
  paintRoster();
  paintList();
  paintStand();
  console.log(`Tract conductor build ${BUILD} · ${cues.length} cues · ${parts.length} parts`);
}

const cue = (index) => cues[index] || null;
const partName = (id) => (parts.find((p) => String(p.id) === String(id)) || { name: id }).name;

/** the parts this cue speaks to, in the order the parts are written */
function speaksTo(index) {
  const c = cue(index);
  if (!c || !c.parts) return [];
  return parts
    .filter((p) => c.parts[String(p.id)] && c.parts[String(p.id)].instruction)
    .map((p) => ({ id: String(p.id), name: p.name, instruction: c.parts[String(p.id)].instruction }));
}

/* ================================================================ *
 *  painting
 * ================================================================ */

function paintStand() {
  const c = cue(at);
  $("cueNum").textContent = c ? c.id || at + 1 : "—";
  $("cueLabel").textContent = c && c.label ? c.label : "";
  $("cuePhrase").textContent = c && c.phrase ? `phrase ${c.phrase}` : "";
  const note = $("cueNote");
  note.textContent = c && c.note ? c.note : "";
  note.hidden = !(c && c.note);

  const goes = $("goes");
  goes.innerHTML = "";
  const speaking = speaksTo(at);
  speaking.forEach((row) => {
    const el = document.createElement("div");
    el.className =
      "goes-row" + (armed === at ? " armed" : "") + (landed === at && armed === null ? " landed" : "");
    el.innerHTML =
      `<span class="goes-part">${row.name}</span>` +
      `<span class="goes-text">${instructionHTML(row.instruction)}</span>`;
    goes.appendChild(el);
  });

  const quiet = parts.filter((p) => !speaking.some((s) => s.id === String(p.id)));
  $("silent").textContent = speaking.length
    ? quiet.length
      ? `${quiet.map((p) => p.name).join(", ")} — nothing sent, no flash`
      : "all four parts"
    : "this cue speaks to nobody";

  $("prep").classList.toggle("armed", armed === at);
  $("go").disabled = armed === null;
  $("go").classList.toggle("ready", armed !== null);
  paintList();
}

function paintList() {
  const host = $("list");
  host.innerHTML = "";
  let phrase = null;
  cues.forEach((c, index) => {
    if (c.phrase !== phrase) {
      phrase = c.phrase;
      const head = document.createElement("div");
      head.className = "phrasehead";
      head.textContent = phrase ? `phrase ${phrase}` : "cues";
      host.appendChild(head);
    }
    const row = document.createElement("button");
    row.className =
      "cuerow" + (index === at ? " at" : "") + (landed !== null && index < landed ? " done" : "");
    const chips = parts
      .map((p) => {
        const on = c.parts && c.parts[String(p.id)] && c.parts[String(p.id)].instruction;
        return `<span class="chip${on ? " on" : ""}">${p.name}</span>`;
      })
      .join("");
    row.innerHTML =
      `<span class="n">${c.id || index + 1}</span>` +
      `<span>${escapeHTML(c.label || "")}</span>` +
      `<span class="who-chips">${chips}</span>`;
    row.addEventListener("click", () => goTo(index));
    host.appendChild(row);
  });
}

function escapeHTML(text) {
  return String(text).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

/** {A} in a cue's text is a key the player presses; draw it as one here too, so
 *  the desk shows what the player will actually be reading */
function keysHTML(text) {
  return escapeHTML(text).replace(/\{([^{}]{1,12})\}/g, (whole, key) => {
    const label = key.trim();
    if (!label) return whole;
    return `<span class="keycap${label.length > 2 ? " wide" : ""}">${label}</span>`;
  });
}

/** the player reads one sentence per line, so the desk shows it that way too */
function instructionHTML(text) {
  const lines = String(text)
    .split(/(?<=[.!?]["'”’)\]]?)\s+(?=\S)/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return keysHTML(text);
  return lines.map((line) => `<span class="sentence">${keysHTML(line)}</span>`).join("");
}

/* ================================================================ *
 *  the transport
 * ================================================================ */

function goTo(index) {
  if (index < 0 || index >= cues.length) return;
  if (armed !== null) cancel(); // moving the pointer drops an unfired prep
  at = index;
  paintStand();
  $("list").querySelector(".cuerow.at")?.scrollIntoView({ block: "nearest" });
}

function prep() {
  const speaking = speaksTo(at);
  if (!speaking.length) return;
  stopCount();
  armed = at;
  const c = cue(at);
  speaking.forEach((row) => send("/cue/prep", [c.id || at + 1, row.id, row.instruction]));
  paintStand();
  if ($("useCount").checked) startCount();
  else $("countdown").textContent = "—";
}

function startCount() {
  const beats = Math.max(1, Math.min(8, Number($("countBeats").value) || 4));
  const bpm = Math.max(20, Math.min(240, Number($("countBpm").value) || 60));
  const interval = 60000 / bpm;
  let beat = beats;
  const speaking = speaksTo(at);
  const c = cue(at);
  const tick = () => {
    if (beat <= 0) {
      stopCount();
      go(); // the count-in is the prep; the downbeat lands at the end of it
      return;
    }
    $("countdown").textContent = String(beat);
    speaking.forEach((row) => send("/cue/count", [beat, row.id]));
    beat -= 1;
    countTimer = setTimeout(tick, interval);
  };
  void c;
  tick();
}

function stopCount() {
  clearTimeout(countTimer);
  countTimer = null;
  $("countdown").textContent = "—";
}

function go() {
  if (armed === null) return;
  stopCount();
  const index = armed;
  const c = cue(index);
  speaksTo(index).forEach((row) => send("/cue/go", [c.id || index + 1, row.id, row.instruction]));
  landed = index;
  armed = null;
  // and step the pointer on, so the next press is the next cue
  at = Math.min(cues.length - 1, index + 1);
  paintStand();
  $("list").querySelector(".cuerow.at")?.scrollIntoView({ block: "nearest" });
}

function cancel() {
  if (armed === null) return;
  stopCount();
  speaksTo(armed).forEach((row) => send("/cue/clear", [row.id]));
  armed = null;
  paintStand();
}

/**
 * The standing cue, repeated quietly. Nothing here flashes anything: it is how
 * a player who reloads mid-piece, or joins late, finds out what they are
 * supposed to be reading.
 */
setInterval(() => {
  if (landed === null || !ws || ws.readyState !== 1) return;
  const c = cue(landed);
  if (!c) return;
  speaksTo(landed).forEach((row) =>
    send("/cue/state", [c.id || landed + 1, row.id, row.instruction])
  );
}, 2500);

/* ================================================================ *
 *  wiring
 * ================================================================ */

$("prep").addEventListener("click", () => (armed === at ? cancel() : prep()));
$("go").addEventListener("click", go);
$("nextCue").addEventListener("click", () => goTo(at + 1));
$("prevCue").addEventListener("click", () => goTo(at - 1));
$("reloadCues").addEventListener("click", () => loadAll());

document.addEventListener("keydown", (event) => {
  const tag = event.target && event.target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  switch (event.key) {
    case " ":
      event.preventDefault();
      if (armed === null) prep();
      else go();
      break;
    case "ArrowRight":
      event.preventDefault();
      goTo(at + 1);
      break;
    case "ArrowLeft":
      event.preventDefault();
      goTo(at - 1);
      break;
    case "Escape":
      event.preventDefault();
      cancel();
      break;
    default:
      break;
  }
});

window.conduct = {
  BUILD,
  prep,
  go,
  cancel,
  goTo,
  get at() {
    return at;
  },
  get armed() {
    return armed;
  },
  get landed() {
    return landed;
  },
  get cues() {
    return cues;
  },
  get roster() {
    return [...seen.entries()];
  },
  speaksTo,
};

connectWS();
loadAll();
