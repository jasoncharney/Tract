#!/usr/bin/env node
/**
 * The printed materials, made from the piece itself.
 *
 *   node score/make-score.js          just the HTML
 *   node score/make-score.js --pdf    HTML, then PDF through Chrome
 *
 * Three documents come out, into score/out/:
 *
 *   tract-guide   setting up and rehearsing — for whoever is running it
 *   tract-cards   the player card, half a sheet, to sit beside the laptop
 *   tract-score   the cue sheet, phrase by phrase
 *
 * The guide and the cards are hand-written prose in score/text/, copied in
 * verbatim. The score is not written at all: it is printed from cues.json and
 * parts.json, the same files the players are reading live. That is the whole
 * point of doing it this way. A printed instruction that disagrees with the
 * screen is worse than no printed instruction, because the player will believe
 * the paper — so there is only ever one copy of the words, and the paper is a
 * view of it. Change a cue, run this again.
 *
 * No dependencies, deliberately: the bridge has none either, and this has to
 * keep working on a laptop that has just been handed the folder.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

/**
 * Where the piece is. This folder has lived both inside scan/ and beside it,
 * so rather than hard-coding a hop upwards, look for the directory that
 * actually holds the files. TRACT_SCAN=/path overrides if it ever guesses
 * wrong.
 */
function findScan() {
  const tries = [
    process.env.TRACT_SCAN,
    path.join(__dirname, "..", "scan"), // score/ beside scan/
    path.join(__dirname, ".."), // score/ inside scan/
    path.join(__dirname, "scan"),
    path.join(process.cwd(), "scan"),
  ].filter(Boolean);
  for (const dir of tries) {
    if (fs.existsSync(path.join(dir, "cues.json")) && fs.existsSync(path.join(dir, "parts.json"))) {
      return dir;
    }
  }
  throw new Error(
    "could not find cues.json and parts.json — looked in:\n  " + tries.join("\n  ")
  );
}

const SCAN = findScan();
const OUT = path.join(__dirname, "out");
const WANT_PDF = process.argv.includes("--pdf");

const TITLE = "Tract";
const SUBTITLE = "for laptops SATB";
const COMPOSER = "Jason Charney";

/* ------------------------------------------------------------------ *
 *  reading the piece
 * ------------------------------------------------------------------ */

const read = (f) => JSON.parse(fs.readFileSync(path.join(SCAN, f), "utf8"));
const cues = read("cues.json").cues;
const parts = read("parts.json").parts;

/** the phrase texts live in scan.js, so take them from there rather than
    keeping a second copy here that can go stale */
function phraseTexts() {
  const src = fs.readFileSync(path.join(SCAN, "src/scan.js"), "utf8");
  const block = src.match(/const PHRASES = \[([\s\S]*?)\];/);
  if (!block) throw new Error("could not find PHRASES in src/scan.js");
  return block[1]
    .split("\n")
    .map((line) => line.match(/"((?:[^"\\]|\\.)*)"/))
    .filter(Boolean)
    .map((m) => m[1]);
}
const PHRASES = phraseTexts();

/* ------------------------------------------------------------------ *
 *  the small pieces of typesetting
 * ------------------------------------------------------------------ */

const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * {A} becomes a key box and <A4> a pitch chip, exactly as the player's page
 * draws them, so the paper and the screen look like the same instruction.
 * Everything is escaped first, so a cue file stays text and never becomes
 * markup.
 */
function chips(text) {
  return esc(text)
    .replace(/\{([^{}]{1,12})\}/g, (_, k) => `<span class="keycap">${k}</span>`)
    .replace(/&lt;([A-Ga-g][#b♯♭]?-?\d)&gt;/g, (_, p) => `<span class="pitchcap">${pretty(p)}</span>`);
}

/** Ab3 reads better as A♭3 on paper; the piano still spells everything sharp */
const pretty = (n) => String(n).replace(/^([A-Ga-g])b/, "$1♭").replace(/^([A-Ga-g])#/, "$1♯");

const MODE_WORDS = {
  fixed: "this pitch",
  assign: "yours by seat",
  choose: "your choice",
  drift: "anywhere between",
};
const modeOf = (ph) => {
  const w = typeof ph.pitch === "string" ? ph.pitch.toLowerCase() : "";
  return MODE_WORDS[w] ? w : "choose";
};
const notesOf = (ph) => (Array.isArray(ph.notes) ? ph.notes : []).map(pretty);

/** what a part may use here, in one line. A drifting phrase is a band, and a
    band reads low to high however the file happens to write it. */
function band(mode, ph) {
  const notes = Array.isArray(ph.notes) ? ph.notes : [];
  if (mode === "drift" && notes.length >= 2) {
    const sorted = notes.slice().sort((a, b) => midi(a) - midi(b));
    return `${pretty(sorted[0])} \u2013 ${pretty(sorted[sorted.length - 1])}`;
  }
  return notes.map(pretty).join("  ") || "any";
}

const SEMI = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
function midi(name) {
  const m = String(name).trim().match(/^([A-Ga-g])([#b\u266f\u266d]*)(-?\d+)$/);
  if (!m) return Number(name) || 0;
  let n = SEMI[m[1].toLowerCase()];
  for (const ch of m[2]) n += ch === "#" || ch === "\u266f" ? 1 : -1;
  return n + (Number(m[3]) + 1) * 12;
}

/** the whole document, around a body */
function page(docLabel, body, extraCss) {
  const css = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(TITLE)} — ${esc(docLabel)}</title>
<style>
${css}
${extraCss || ""}
</style>
</head>
<body>
${body}
</body>
</html>
`;
}

/** title, subtitle, composer and what the document is — all on one line */
const masthead = (docLabel) => `<div class="masthead">
  <h1 class="work">${esc(TITLE)}</h1>
  <div class="sub">${esc(SUBTITLE)} · ${esc(COMPOSER)}</div>
  <div class="doc">${esc(docLabel)}</div>
</div>`;

const colophon = () =>
  `<p class="colophon">The cue sheet in these pages is printed from <code>cues.json</code> and
   <code>parts.json</code> — the files the players read live. Change a cue and run
   <code>node score/make-score.js</code> again rather than editing this document.</p>`;

/* ------------------------------------------------------------------ *
 *  A — setting up and rehearsing
 * ------------------------------------------------------------------ */

function buildGuide() {
  const prose = fs.readFileSync(path.join(__dirname, "text/guide.html"), "utf8");
  return page(
    "Setting up & rehearsing",
    `<div class="guide">${masthead("Setting up & rehearsing")}${prose}${colophon()}</div>`
  );
}

/* ------------------------------------------------------------------ *
 *  B — the player card
 * ------------------------------------------------------------------ */

/**
 * One card, not one per part. The pitches a player may use arrive on their
 * screen, phrase by phrase, so there is nothing on paper that differs between
 * parts — and four near-identical cards is four chances to hand someone the
 * wrong one.
 *
 * Half a letter sheet, two sides. Print double-sided, cut across the middle,
 * and one sheet makes two cards.
 */
function buildCards() {
  const prose = fs
    .readFileSync(path.join(__dirname, "text/card.html"), "utf8")
    .split("{{masthead}}")
    .join(masthead("Player card"));
  return page("Player card", prose, "@page { size: 8.5in 5.5in; margin: 11mm 12mm; }");
}

/* ------------------------------------------------------------------ *
 *  C — the cue sheet, printed from the piece
 * ------------------------------------------------------------------ */

function buildScore() {
  const byPhrase = new Map();
  cues.forEach((c) => {
    const n = Number(c.phrase) || 0;
    if (!byPhrase.has(n)) byPhrase.set(n, []);
    byPhrase.get(n).push(c);
  });

  const nameOf = {};
  parts.forEach((p) => (nameOf[p.id] = p.name));

  const blocks = [...byPhrase.keys()]
    .sort((a, b) => a - b)
    .map((n) => {
      const pitchRow = parts
        .map((p) => {
          const ph = p.phrases[n - 1] || {};
          const mode = modeOf(ph);
          const notes = notesOf(ph);
          const shown = band(mode, ph);
          return `<div class="p"><b>${esc(p.name)}</b>${esc(shown)}
            <span class="mode">${MODE_WORDS[mode]}</span></div>`;
        })
        .join("");

      const cueBlocks = byPhrase
        .get(n)
        .map((c) => {
          const named = Object.keys(c.parts || {}).sort();
          const silent = parts.map((p) => p.id).filter((id) => !named.includes(id));
          const rows = named
            .map(
              (id) => `<tr>
                <td class="part">${esc(nameOf[id] || id)}</td>
                <td class="instr">${chips(c.parts[id].instruction || "")}</td>
              </tr>`
            )
            .join("\n");
          return `<div class="cue">
  <div class="cue-head">
    <span class="id">${esc(c.id)}</span>
    <span class="label">${esc(c.label || "")}</span>
    ${silent.length ? `<span class="silent">nothing sent to ${silent.map((id) => esc(nameOf[id] || id)).join(", ")}</span>` : ""}
  </div>
  ${c.note ? `<p class="note">${esc(c.note)}</p>` : ""}
  <table>${rows}</table>
</div>`;
        })
        .join("\n");

      return `<section class="phrase">
  <div class="phrase-head">
    <span class="n">${n}</span>
    <span class="text">${esc(PHRASES[n - 1] || "")}</span>
  </div>
  <div class="pitchrow">${pitchRow}</div>
  ${cueBlocks}
</section>`;
    });

  // the whole compass of each part, for the front page
  const compass = parts
    .map((p) => {
      const all = p.phrases.flatMap((ph) => (Array.isArray(ph.notes) ? ph.notes : []));
      if (!all.length) return `<tr><td class="part">${esc(p.name)}</td><td>free</td></tr>`;
      const sorted = all.slice().sort((a, b) => midi(a) - midi(b));
      return `<tr>
        <td class="part">${esc(p.name)}</td>
        <td>${esc(pretty(sorted[0]))} \u2013 ${esc(pretty(sorted[sorted.length - 1]))}</td>
      </tr>`;
    })
    .join("\n");

  const front = `<section class="front">
${masthead("Cue sheet")}
<h2>How to read this</h2>
<p>One page per phrase, cues in the order they are given. Each cue names the parts it
speaks to; <strong>a part not named is sent nothing at all</strong> — no instruction and
no light — and carries on with what it is already doing. The line at the right of a cue
says who those silent parts are, so you can see at a glance that leaving them out was
meant.</p>
<p>Under each phrase heading are the pitches that phrase gives each part, and how the
pitch is decided there: <em>this pitch</em>, <em>yours by seat</em>, <em>your choice</em>,
or a band to move about inside.</p>
<p><strong>Nothing here is timed.</strong> When a cue lands is the conductor's decision,
and the piece has no fixed length.</p>

<h2>The four parts, over the whole piece</h2>
<table class="compass">${compass}</table>
<p class="rule-note">Two players to a part at least. Extra players spread across the
written pitches rather than doubling, so a part with three notes wants three players.</p>
${colophon()}
</section>`;

  return page("Cue sheet", front + blocks.join("\n"));
}

/* ------------------------------------------------------------------ *
 *  printing
 * ------------------------------------------------------------------ */

const CHROMES = [
  process.env.CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/opt/pw-browsers/chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter(Boolean);

function findChrome() {
  for (const c of CHROMES) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* keep looking */
    }
  }
  const which = spawnSync("which", ["google-chrome", "chromium", "chromium-browser"], {
    encoding: "utf8",
  });
  const first = (which.stdout || "").split("\n").filter(Boolean)[0];
  return first || null;
}

function toPdf(htmlFile, pdfFile) {
  const chrome = findChrome();
  if (!chrome) {
    console.log("  no Chrome found — open the HTML and print to PDF, or set CHROME=/path/to/chrome");
    return false;
  }
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    "--virtual-time-budget=3000",
    `--print-to-pdf=${pdfFile}`,
    "file://" + htmlFile,
  ];
  const r = spawnSync(chrome, args, { encoding: "utf8", timeout: 120000 });
  if (!fs.existsSync(pdfFile)) {
    console.log("  Chrome did not produce a PDF:", (r.stderr || "").split("\n")[0]);
    return false;
  }
  return true;
}

/* ------------------------------------------------------------------ */

fs.mkdirSync(OUT, { recursive: true });
const docs = [
  ["tract-guide", buildGuide()],
  ["tract-cards", buildCards()],
  ["tract-score", buildScore()],
];

console.log(`reading ${path.relative(process.cwd(), SCAN) || SCAN}`);
console.log(`${cues.length} cues · ${parts.length} parts · ${PHRASES.length} phrases`);
docs.forEach(([name, html]) => {
  const htmlFile = path.join(OUT, name + ".html");
  fs.writeFileSync(htmlFile, html);
  console.log(`  ${name}.html  ${(html.length / 1024).toFixed(0)} kB`);
  if (WANT_PDF) {
    const pdfFile = path.join(OUT, name + ".pdf");
    fs.rmSync(pdfFile, { force: true });
    if (toPdf(htmlFile, pdfFile)) {
      console.log(`  ${name}.pdf   ${(fs.statSync(pdfFile).size / 1024).toFixed(0)} kB`);
    }
  }
});
