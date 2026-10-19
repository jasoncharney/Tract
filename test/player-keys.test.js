/*
  The player's keyboard: the rates, the one-shots, and the ways out.

  The rate bands are read out of scan.js rather than written down here. They
  get tuned by ear, and a hard-coded expectation would report every tuning
  decision as a regression — which it did, once.
*/

const fs = require("fs");
const path = require("path");
const { suite, ROOT } = require("./lib/harness");

const source = fs.readFileSync(path.join(ROOT, "scan", "src", "scan.js"), "utf8");
function band(table, name) {
  const block = source.match(new RegExp(`const ${table} = \\{([\\s\\S]{0,400}?)\\};`));
  const m = block[1].match(new RegExp(`${name}:\\s*\\[\\s*([\\d.]+)\\s*,\\s*([\\d.]+)`));
  return [Number(m[1]), Number(m[2])];
}

suite("player keys", async (t) => {
  const page = await t.player({ audio: true });
  const readout = () =>
    page.evaluate(() => ({
      mode: window.scan.transport.mode,
      pos: window.scan.position,
      phrase: window.scan.phrase,
      gate: /gate <b>on/.test(document.getElementById("readout").innerHTML),
    }));

  /* ---- held scans ---- */
  t.section("1 — the held keys run at the rates scan.js says");
  const want = { a: band("RATES", "slow"), s: band("RATES", "mid"), d: band("RATES", "fast") };
  t.note(`scan.js: slow ${want.a.join("–")}  mid ${want.s.join("–")}  fast ${want.d.join("–")} s per phoneme`);

  const held = (key, secs) =>
    page.evaluate(
      async ([k, s]) => {
        window.scan.applyRemote("/scan/phrase", [3]);
        window.scan.applyRemote("/scan/position", [0]);
        await new Promise((r) => setTimeout(r, 200));
        const from = window.scan.position;
        const t0 = performance.now();
        const ev = (type) =>
          document.dispatchEvent(new KeyboardEvent(type, { key: k, code: `Key${k.toUpperCase()}`, bubbles: true }));
        ev("keydown");
        await new Promise((r) => setTimeout(r, s * 1000));
        ev("keyup");
        const travelled = window.scan.position - from;
        window.scan.applyRemote("/scan/gate", [0]);
        return (performance.now() - t0) / 1000 / Math.max(0.001, travelled);
      },
      [key, secs]
    );

  for (const [key, [lo, hi]] of Object.entries(want)) {
    const runs = [];
    for (let i = 0; i < 3; i++) runs.push(await held(key, key === "a" ? 5 : 2));
    const mean = runs.reduce((x, y) => x + y, 0) / runs.length;
    // a fresh value is drawn per cell, so a few cells average inside the band
    // with a little slack for the part-cell at each end
    t.check(
      mean > lo * 0.7 && mean < hi * 1.3,
      `${key.toUpperCase()} scans at its written rate`,
      `${mean.toFixed(2)} s per phoneme, want ${lo}–${hi}`
    );
  }

  /* ---- one-shot words ---- */
  t.section("2 — one press of W / E / R plays one word and stops");
  const oneShot = (key, phrase) =>
    page.evaluate(
      async ([k, ph]) => {
        window.scan.applyRemote("/scan/phrase", [ph]);
        window.scan.applyRemote("/scan/gate", [0]);
        await new Promise((r) => setTimeout(r, 200));
        const t0 = performance.now();
        const ev = (type) =>
          document.dispatchEvent(new KeyboardEvent(type, { key: k, code: `Key${k.toUpperCase()}`, bubbles: true }));
        ev("keydown");
        ev("keyup");
        while (window.scan.transport.mode && performance.now() - t0 < 40000) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return (performance.now() - t0) / 1000;
      },
      [key, phrase]
    );

  // phrase 2 is "CRACK" — one word, two cells, so this is the shortest the
  // piece ever asks for and the place the old bug was loudest
  const w = await oneShot("w", 2);
  const e = await oneShot("e", 2);
  const r = await oneShot("r", 2);
  t.note(`"CRACK": W ${w.toFixed(1)}s  E ${e.toFixed(1)}s  R ${r.toFixed(1)}s`);
  t.check(w < 6, "W is a word you can pulse, not a drone", `${w.toFixed(1)} s`);
  t.check(w > e && e > r, "and the three are still slow, middle, fast", `${w.toFixed(1)} > ${e.toFixed(1)} > ${r.toFixed(1)}`);
  t.check(
    Math.abs(w - (band("SHOT_RATES", "slow").reduce((a, b) => a + b) / 2) * 2) < 3,
    "W's length follows SHOT_RATES, not the hold rates",
    `two cells at ${band("SHOT_RATES", "slow").join("–")} s`
  );

  /* ---- the ways out ---- */
  t.section("3 — a running one-shot can be stopped");
  const start = async (phrase = 3) => {
    await page.evaluate(async (ph) => {
      window.scan.applyRemote("/scan/phrase", [ph]);
      await new Promise((r) => setTimeout(r, 200));
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true }));
      await new Promise((r) => setTimeout(r, 400));
    }, phrase);
  };

  await start();
  t.check((await readout()).mode === "word", "a word is running");
  await page.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
  });
  let state = await readout();
  t.check(state.mode === null && !state.gate, "esc stops it dead", `mode ${state.mode}, gate ${state.gate}`);

  await start();
  await page.evaluate(async () => {
    window.scan.applyRemote("/scan/phrase", [5]);
    await new Promise((r) => setTimeout(r, 300));
  });
  state = await readout();
  t.check(
    state.mode === null && state.phrase === 5,
    "changing phrase cancels it instead of carrying it over",
    `mode ${state.mode}, phrase ${state.phrase}`
  );

  // Pressing a one-shot again never stops it — but what it plays depends on
  // the phrase. The key takes the NEXT word each time, so on a six-word phrase
  // a second press moves on, and only where the phrase is a single word does
  // it come back to the beginning. Cue 10 is phrase 2 — "CRACK", one word —
  // which is why "press again before the word finishes, so it starts over" is
  // literally true there and would not be on phrase 3.
  await start(2);
  const again = await page.evaluate(async () => {
    const before = window.scan.position;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { before, after: window.scan.position, mode: window.scan.transport.mode };
  });
  t.check(
    again.mode === "word" && again.after < again.before,
    "on a one-word phrase, pressing again starts it over — what cue 10 asks",
    `${again.before.toFixed(2)} → ${again.after.toFixed(2)}`
  );

  await start(3);
  const onward = await page.evaluate(async () => {
    const before = window.scan.position;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "w", code: "KeyW", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "w", code: "KeyW", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    return { before, after: window.scan.position, mode: window.scan.transport.mode };
  });
  t.check(
    onward.mode === "word" && onward.after > onward.before,
    "on a longer phrase it takes the next word instead",
    `${onward.before.toFixed(2)} → ${onward.after.toFixed(2)}`
  );
  await page.evaluate(() => window.scan.applyRemote("/scan/gate", [0]));

  /* ---- whisper ---- */
  t.section("4 — whisper latches");
  const z = async () =>
    page.evaluate(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", bubbles: true }));
      document.dispatchEvent(new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true }));
      await new Promise((r) => setTimeout(r, 200));
      return document.getElementById("whisperTag").dataset.on === "1";
    });
  t.check((await z()) === true, "Z turns whisper on");
  t.check((await z()) === false, "and off again");
});
