/*
  scan/src/conduct.js — the conductor's desk.

  It holds no audio and no synthesis: it reads cues.json, keeps a pointer into
  the cue list, and sends three kinds of message over the bridge's WebSocket,
  one per part the cue speaks to:

      /cue/next  <cue> <partId> <instruction>   what is coming, with no light:
                                                sent as soon as the pointer
                                                lands on a cue, and to every
                                                part — an empty instruction
                                                means "nothing for you next"
      /cue/prep  <cue> <partId> <instruction>   arm: the light goes amber. The
                                                text is already on their page
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

  It listens for two things: `/player/hello`, a few seconds apart, which builds
  the roster, and `/player/at`, ten times a second, which draws the strip of
  playheads along the bottom of the screen.
*/

const BUILD = "2026-10-18b";
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
    sendFade();
    sendNext();
  });
  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch (e) {
      return;
    }
    (Array.isArray(message) ? message : [message]).forEach((m) => {
      if (!m) return;
      if (m.address === "/player/hello") heard(m.args || []);
      else if (m.address === "/player/at") moved(m.args || []);
      else if (m.address === "/player/words") laidOut(m.args || []);
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
const seen = new Map(); // machine id -> { at, part, name, cue, phrase }

function heard(args) {
  const partId = String(args[0]);
  const machine = args[3] !== undefined ? String(args[3]) : `${partId}:only`;
  seen.set(machine, {
    at: Date.now(),
    part: partId,
    name: String(args[1] || partId),
    cue: Number(args[2]),
    // 0 is standby, 1-8 the phrases; a page too old to send it says nothing
    phrase: args[4] === undefined ? null : Number(args[4]),
    // what the player typed on their own laptop. Blank until they do.
    who: String(args[5] || ""),
  });
  paintRoster();
}

/**
 * Where a part has got to, in words.
 *
 * Players advance themselves, so a part is only ever *probably* together. One
 * number means they agree; two means somebody has not moved yet, or has moved
 * early, and that is the thing worth seeing before it becomes audible.
 */
function phraseOf(here) {
  const found = [...new Set(here.map((i) => i.phrase).filter((n) => n !== null && isFinite(n)))];
  if (!found.length) return { text: "", split: false };
  found.sort((a, b) => a - b);
  if (found.length === 1) {
    return { text: found[0] === 0 ? "standby" : `phrase ${found[0]}`, split: false };
  }
  return { text: `phrase ${found.join(" / ")}`, split: true };
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
    const ph = phraseOf(here);
    row.innerHTML =
      `<span class="dot"></span><span class="name">${p.name}</span>` +
      `<span class="count">${here.length}</span>` +
      (ph.text
        ? `<span class="ph${ph.split ? " split" : ""}">${ph.text}</span>`
        : "") +
      `<span class="at">${where}</span>`;
    if (here.length > 1) row.title = `${here.length} players on ${p.name}, seats 1–${here.length}`;
    row.title = here.length
      ? `${here.length} ${here.length === 1 ? "player" : "players"} on ${p.name}`
      : `nobody is on ${p.name}`;
    host.appendChild(row);
  });
  const total = [...seen.values()].filter((i) => Date.now() - i.at < 9000).length;
  const sum = $("rosterTotal");
  if (sum) sum.textContent = `${total} connected`;
  paintCoverage();
}
setInterval(paintRoster, 2000);

/* ================================================================ *
 *  everybody's playhead
 *
 *  Four parts sweeping their own phrases at once is a texture, not four
 *  audible lines, and from the desk you cannot hear who is where. So every
 *  laptop sends `/player/at` ten times a second while a desk is listening,
 *  and each one gets a strip along the bottom of the screen: the player's own
 *  name, where they are in the phrase, whether the gate is open, and whether
 *  it is voiced or whispered.
 *
 *  The strips are built once per laptop and then only moved — rebuilding the
 *  row ten times a second would throw away the CSS transition that makes a
 *  playhead read as travelling rather than teleporting.
 * ================================================================ */

const moving = new Map(); // machine -> the last frame it sent
const stripEls = new Map(); // machine -> the elements drawn for it
const STRIP_GONE = 4000; // quiet this long and the strip goes away

/* Where the words fall along a phrase, and where the cells divide. It arrives
 * on its own slow message rather than on every frame, because it only changes
 * when the phrase does.
 *
 * Kept per laptop, not per phrase, because it is not quite the same for
 * everybody: a part set to re-roll its pronunciations draws a different number
 * of cells for the same words, so the divisions move. `byPhrase` is only a
 * stand-in, so a strip has words on it from its first frame instead of waiting
 * for its own laptop to say. */
const layouts = new Map(); // machine -> { phrase, words, edges }
const layoutByPhrase = new Map(); // phrase -> the same, from whoever said it last

function laidOut(args) {
  const machine = String(args[1] || "");
  if (!machine) return;
  let doc;
  try {
    doc = JSON.parse(String(args[3] || ""));
  } catch (e) {
    return;
  }
  if (!doc || !Array.isArray(doc.w)) return;
  const entry = {
    phrase: Number(args[2]),
    words: doc.w,
    edges: Array.isArray(doc.c) ? doc.c : [],
  };
  layouts.set(machine, entry);
  layoutByPhrase.set(entry.phrase, entry);
}

/** the layout to draw under a laptop: its own, or anybody's for that phrase */
function layoutFor(machine, phrase) {
  const mine = layouts.get(machine);
  if (mine && mine.phrase === phrase) return mine;
  const other = layoutByPhrase.get(phrase);
  return other && other.phrase === phrase ? other : null;
}

function moved(args) {
  const machine = String(args[1] || "");
  if (!machine) return;
  moving.set(machine, {
    at: Date.now(),
    part: String(args[0]),
    who: String(args[2] || ""),
    phrase: Number(args[3]),
    pos: Math.max(0, Math.min(1, Number(args[4]) || 0)),
    cells: Math.max(1, Number(args[5]) || 1),
    ipa: String(args[6] || ""),
    whisper: Number(args[7]) ? 1 : 0,
    gate: Number(args[8]) ? 1 : 0,
  });
}

/** a laptop's label: what its player typed, or which seat it is on the part */
function labelFor(machine, info, nth) {
  // the part is already on the strip in its own chip, so repeating it here
  // just reads as "I  I 2". Seats are what the parts share their pitches out
  // by, so an unnamed laptop is named by the thing it already is.
  return info.who || `seat ${nth}`;
}

function buildStrip() {
  const root = document.createElement("div");
  root.className = "pstrip";
  root.innerHTML =
    '<div class="pstrip-head"><span class="pstrip-part"></span>' +
    '<span class="pstrip-name"></span><span class="pstrip-ph"></span></div>' +
    '<div class="pstrip-words"></div>' +
    '<div class="pstrip-bar"><div class="pstrip-ticks"></div>' +
    '<div class="pstrip-cursor"></div></div>' +
    '<div class="pstrip-foot"><span class="pstrip-ipa"></span>' +
    '<span class="pstrip-mode">whisper</span></div>';
  return {
    root,
    part: root.querySelector(".pstrip-part"),
    name: root.querySelector(".pstrip-name"),
    ph: root.querySelector(".pstrip-ph"),
    words: root.querySelector(".pstrip-words"),
    ticks: root.querySelector(".pstrip-ticks"),
    cursor: root.querySelector(".pstrip-cursor"),
    ipa: root.querySelector(".pstrip-ipa"),
    laidOut: "",
  };
}

/**
 * The words of the phrase, written along the strip where they are spoken.
 *
 * Small enough to be a texture rather than something to read word by word —
 * but "she is on *burden*" is a different thing to know than "she is four
 * fifths of the way along", and it is the one a conductor asks for. Each word
 * is boxed against the next, and the cell divisions are drawn inside the bar
 * beneath them, so the two line up.
 */
function drawLayout(el, layout) {
  const key = layout ? `${layout.phrase}|${layout.words.map((x) => x.w).join(" ")}|${layout.edges.length}` : "";
  if (el.laidOut === key) return;
  el.laidOut = key;
  el.words.innerHTML = "";
  if (!layout) {
    el.ticks.style.background = "";
    return;
  }
  layout.words.forEach((word) => {
    const span = document.createElement("span");
    span.className = "pstrip-word";
    span.style.left = `${(word.a * 100).toFixed(2)}%`;
    span.style.width = `${Math.max(0, (word.b - word.a) * 100).toFixed(2)}%`;
    span.textContent = word.w;
    span.title = word.w; // the narrow ones are clipped, not lost
    el.words.appendChild(span);
  });
  // one hairline per cell edge, at the widths this player's strip actually
  // uses — a held stop is wider than a pass-through one, and evenly spaced
  // ticks would put every division in slightly the wrong place
  const stops = layout.edges
    .slice(0, -1)
    .map((x) => {
      const at = (x * 100).toFixed(3);
      return `transparent ${at}%, var(--line) ${at}%, var(--line) calc(${at}% + 1px), transparent calc(${at}% + 1px)`;
    })
    .join(", ");
  el.ticks.style.background = stops ? `linear-gradient(to right, ${stops})` : "";
}

function paintStrips() {
  const host = $("strips");
  if (!host) return;
  const now = Date.now();

  // in the order the parts are written, so the bottom of the screen reads the
  // way the score does rather than the way the wi-fi happened to connect
  const order = new Map(parts.map((p, i) => [String(p.id), i]));
  const live = [...moving.entries()]
    .filter(([, info]) => now - info.at < STRIP_GONE)
    .sort((a, b) => {
      const pa = order.has(a[1].part) ? order.get(a[1].part) : 99;
      const pb = order.has(b[1].part) ? order.get(b[1].part) : 99;
      if (pa !== pb) return pa - pb;
      return (a[1].who || a[0]).localeCompare(b[1].who || b[0]);
    });

  stripEls.forEach((el, machine) => {
    if (!moving.has(machine) || now - moving.get(machine).at >= STRIP_GONE) {
      el.root.remove();
      stripEls.delete(machine);
      moving.delete(machine);
      layouts.delete(machine); // but layoutByPhrase stays: it is the stand-in
    }
  });

  const nth = new Map(); // how many laptops on this part so far, for unnamed ones
  live.forEach(([machine, info], index) => {
    const count = (nth.get(info.part) || 0) + 1;
    nth.set(info.part, count);
    let el = stripEls.get(machine);
    if (!el) {
      el = buildStrip();
      stripEls.set(machine, el);
    }
    if (el.root.parentNode !== host || host.children[index] !== el.root) {
      host.insertBefore(el.root, host.children[index] || null);
    }
    const label = labelFor(machine, info, count);
    if (el.name.textContent !== label) el.name.textContent = label;
    const pname = partName(info.part);
    if (el.part.textContent !== pname) el.part.textContent = pname;
    const where = info.phrase === 0 ? "standby" : `ph ${info.phrase}`;
    if (el.ph.textContent !== where) el.ph.textContent = where;
    drawLayout(el, layoutFor(machine, info.phrase));
    el.cursor.style.left = `${(info.pos * 100).toFixed(2)}%`;
    if (el.ipa.textContent !== info.ipa) el.ipa.textContent = info.ipa;
    const gate = String(info.gate);
    const whisper = String(info.whisper);
    if (el.root.dataset.gate !== gate) el.root.dataset.gate = gate;
    if (el.root.dataset.whisper !== whisper) el.root.dataset.whisper = whisper;
  });

  document.body.classList.toggle("hasstrips", live.length > 0);
}
setInterval(paintStrips, 60);

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
  paintLastSent();
  sendNext(); // a freshly loaded cue file changes what is coming
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

  // what this cue does to the projection, in the conductor's own words
  const stage = $("stageLine");
  if (stage) {
    const block = c && c.stage;
    const says = [];
    if (block) {
      if ("title" in block) says.push(block.title ? "title card up" : "title card away");
      if (!("title" in block) && !("tracts" in block) && !("text" in block)) says.push("nothing");
      if ("tracts" in block) says.push(block.tracts ? "tracts in" : "tracts out");
      if ("text" in block) says.push(block.text ? `subtitle "${block.text}"` : "subtitle away");
      if (block.fade !== undefined) says.push(`over ${block.fade}s`);
    }
    stage.textContent = says.length ? `stage — ${says.join(", ")}` : "";
    stage.hidden = !says.length;
  }

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

  paintCoverage();

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

/**
 * For the phrase this cue belongs to: are there enough players on each part to
 * sound all the pitches written for it? Parts share their pitches out by seat,
 * so three players on two pitches is fine and one player on two pitches means
 * one of them is never heard. Better to see that at the stand than afterwards.
 */
function paintCoverage() {
  const el = $("coverage");
  if (!el) return;
  const c = cue(at);
  const phrase = c && Number(c.phrase);
  if (!phrase) {
    el.hidden = true;
    return;
  }
  const short = [];
  parts.forEach((p) => {
    const entry = (p.phrases && p.phrases[phrase - 1]) || {};
    const mode = String(entry.pitch || "choose").toLowerCase();
    const notes = Array.isArray(entry.notes) ? entry.notes : [];
    if (mode !== "assign" || notes.length < 2) return;
    const here = hereFor(p.id).length;
    if (here === 0) return; // "nobody on this part" is already said elsewhere
    if (here < notes.length) {
      const unheard = notes.slice(here).join(", ");
      short.push(`${p.name}: ${here} ${here === 1 ? "player" : "players"} for ${notes.length} pitches — ${unheard} unheard`);
    }
  });
  el.hidden = short.length === 0;
  el.textContent = short.join("  ·  ");
}

/**
 * What actually went out, kept on screen after the pointer has moved on.
 *
 * The stand always shows the cue you are about to send; the moment you send
 * it, it is replaced by the next one. Mid-phrase, "what did I just tell the
 * basses" is a question with no answer anywhere on the desk — so this is it,
 * word for word, until the next downbeat replaces it.
 */
function paintLastSent() {
  const panel = $("lastSent");
  if (!panel) return;
  if (landed === null) {
    panel.hidden = true;
    return;
  }
  const c = cue(landed);
  if (!c) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  $("lastNum").textContent = String(c.id || landed + 1);
  $("lastLabel").textContent = c.label || "";
  const host = $("lastGoes");
  const rows = speaksTo(landed);
  const signature = rows.map((r) => `${r.id}\u0000${r.instruction}`).join("\u0001");
  if (host.dataset.sig !== signature) {
    host.dataset.sig = signature;
    host.innerHTML = "";
    rows.forEach((row) => {
      const el = document.createElement("div");
      el.className = "goes-row";
      el.innerHTML =
        `<span class="goes-part">${row.name}</span>` +
        `<span class="goes-text">${instructionHTML(row.instruction)}</span>`;
      host.appendChild(el);
    });
  }
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
    const chips =
      parts
        .map((p) => {
          const on = c.parts && c.parts[String(p.id)] && c.parts[String(p.id)].instruction;
          return `<span class="chip${on ? " on" : ""}">${p.name}</span>`;
        })
        .join("") +
      // the stage is not a part, but a cue that speaks to it should say so
      `<span class="chip stage${speaksToStage(index) ? " on" : ""}">▣</span>`;
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

/** {A} in a cue's text is a key the player presses and <A4> is a pitch they
 *  sing; draw both the way the player will see them, so the desk is reading the
 *  same score they are */
function keysHTML(text) {
  const withKeys = escapeHTML(text).replace(/\{([^{}]{1,12})\}/g, (whole, key) => {
    const label = key.trim();
    if (!label) return whole;
    return `<span class="keycap${label.length > 2 ? " wide" : ""}">${label}</span>`;
  });
  return withKeys.replace(/&lt;([^&]{1,12}?)&gt;/g, (whole, pitch) => {
    const label = pitch.trim();
    if (!label) return whole;
    return `<span class="pitchcap">${label}</span>`;
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

/**
 * What is coming, sent ahead of the light.
 *
 * A player used to see their next instruction and the amber light at the same
 * moment, which gave them four seconds to read two sentences and be ready. So
 * the text now goes out as soon as the pointer sits on a cue — in practice,
 * the instant the previous downbeat lands — and the light means only "soon".
 *
 * Sent to every part, not just the ones this cue speaks to: an empty
 * instruction is how a part is told that the next cue has nothing for them,
 * and that their line should go away rather than stay from two cues ago.
 */
function sendNext() {
  if (!parts.length) return;
  const c = cue(at);
  const id = c ? c.id || at + 1 : "";
  const byPart = new Map(speaksTo(at).map((row) => [row.id, row.instruction]));
  parts.forEach((p) => send("/cue/next", [id, String(p.id), byPart.get(String(p.id)) || ""]));
}

function goTo(index) {
  if (index < 0 || index >= cues.length) return;
  if (armed !== null) cancel(); // moving the pointer drops an unfired prep
  at = index;
  paintStand();
  sendNext();
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
  sendStage(c);
  markCue(index);
  landed = index;
  armed = null;
  // and step the pointer on, so the next press is the next cue
  at = Math.min(cues.length - 1, index + 1);
  paintStand();
  paintLastSent();
  // behind the downbeat, and in the same breath: the players' "next" line
  // refills the moment the old one clears
  sendNext();
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
 * How long the diminuendo at the end should take. The players hold ↓ to start
 * it; this is the only thing that decides how long it lasts, so that the four
 * parts decay together instead of at four guesses. Sent on every heartbeat as
 * well as on change, so a laptop that joins late is not the one that stops
 * five seconds after everybody else.
 */
/* ================================================================ *
 *  the stage
 *
 *  A cue may carry a "stage" block beside its "parts" block — the title card,
 *  the wall of tracts, the subtitle. It is a sibling of "parts" rather than a
 *  part of its own because the stage is not a player: it has no pitches, no
 *  seat, and no instruction to read.
 *
 *  Whatever the last fired cue said stands, and is repeated on the heartbeat,
 *  so a projector plugged in halfway through catches up instead of showing a
 *  title card over the middle of the piece.
 * ================================================================ */

// the ACCUMULATED state, not the last block: a cue that only changes the
// subtitle must not make a late projector forget that the title card went away
const standingStage = {};
let stageEverSet = false;

function sendStage(c) {
  if (!c || !c.stage || typeof c.stage !== "object") return;
  Object.assign(standingStage, c.stage);
  stageEverSet = true;
  send("/stage/set", [JSON.stringify(c.stage)]);
}

/**
 * Put the title card back up, from the desk rather than from a cue — before a
 * run, or between takes in a rehearsal. `"title": true` means "show the card as
 * it is", so this does not need to know what it says.
 */
function showTitleCard() {
  const block = { title: true, tracts: false, text: "", fade: 1.5 };
  Object.assign(standingStage, block);
  stageEverSet = true;
  send("/stage/set", [JSON.stringify(block)]);
}

/** does this cue say anything to the stage? */
function speaksToStage(index) {
  const c = cue(index);
  return !!(c && c.stage && typeof c.stage === "object");
}

function fadeLength() {
  return Math.max(1, Math.min(300, Number($("fadeSecs").value) || 5));
}
function sendFade() {
  send("/cue/fade", [fadeLength()]);
}

/**
 * The standing cue, repeated quietly. Nothing here flashes anything: it is how
 * a player who reloads mid-piece, or joins late, finds out what they are
 * supposed to be reading.
 */
setInterval(() => {
  if (!ws || ws.readyState !== 1) return;
  sendFade();
  // "a desk is listening" — players only send their playhead while this keeps
  // arriving, so nobody is talking ten times a second to an empty room
  send("/cue/ping", []);
  // and what is coming, for anyone who joined or reloaded since the last one
  sendNext();
  // the heartbeat catches a projector up with no fade — it should arrive at
  // the state the piece is in, not fade into it from the title card
  if (stageEverSet) send("/stage/set", [JSON.stringify({ ...standingStage, fade: 0 })]);
  if (landed === null) return;
  const c = cue(landed);
  if (!c) return;
  speaksTo(landed).forEach((row) =>
    send("/cue/state", [c.id || landed + 1, row.id, row.instruction])
  );
}, 2500);

/* ================================================================ *
 *  the clocks
 *
 *  Three, because three different questions get asked in a performance.
 *  How far into the piece are we — which starts when the piece does, at the
 *  first cue of phrase 1, not when the page was opened. How long since the
 *  last thing I did — the one that tells you whether a section has run long.
 *  And how long this phrase has been going, which is the lap.
 * ================================================================ */

// Cue 1 is the one you give while the room settles; the piece starts at cue 2.
// Timing from cue 1 would make every run look a minute longer than it was.
const START_CUE = "2";

let pieceStartedAt = null;
let cueFiredAt = null;
let phraseStartedAt = null;
let phraseRunning = null; // which phrase the lap belongs to

function clock(since) {
  if (since === null) return "—";
  const total = Math.max(0, (performance.now() - since) / 1000);
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  return `${m}:${s < 10 ? "0" : ""}${s.toFixed(1)}`;
}

function paintClocks() {
  $("clockPiece").textContent = clock(pieceStartedAt);
  $("clockCue").textContent = clock(cueFiredAt);
  $("clockPhrase").textContent = clock(phraseStartedAt);
  const label = $("clockPhraseLabel");
  if (label) label.textContent = phraseRunning === null ? "phrase" : `phrase ${phraseRunning}`;
  const ago = $("lastAgo");
  if (ago) ago.textContent = landed === null ? "" : `${clock(cueFiredAt)} ago`;
}
setInterval(paintClocks, 100);

/** a cue has just gone out: move whichever clocks that cue moves */
function markCue(index) {
  const c = cue(index);
  const now = performance.now();
  cueFiredAt = now;
  const id = String((c && c.id) || index + 1);
  const phrase = c && c.phrase ? Number(c.phrase) : null;
  if (id === START_CUE) {
    // the downbeat of the piece: both the piece clock and phrase 1's lap
    pieceStartedAt = now;
    phraseRunning = phrase;
    phraseStartedAt = now;
  } else if (pieceStartedAt !== null && phrase !== null && phrase !== phraseRunning) {
    phraseRunning = phrase;
    phraseStartedAt = now;
  }
  paintClocks();
}

function resetClocks() {
  pieceStartedAt = null;
  cueFiredAt = null;
  phraseStartedAt = null;
  phraseRunning = null;
  paintClocks();
}

/* ================================================================ *
 *  wiring
 * ================================================================ */

$("titleCardBtn").addEventListener("click", showTitleCard);
$("fadeSecs").addEventListener("change", sendFade);
$("resetClocks").addEventListener("click", resetClocks);
paintClocks();

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
  get moving() {
    return [...moving.entries()];
  },
  speaksTo,
  sendNext,
  moved,
};

connectWS();
loadAll();
