/*
  test/back-to-top.test.js — the desk's reset, between takes.

  What this replaces: after a diminuendo, every player sits at zero, and the
  only way back up was for each of them to press escape on their own laptop.
  The desk could not do it for the room. (`fading` stays true once the curve
  has landed, which is how the tag knows to read "silent", so escape does
  still work; it is the eight-laptops-one-at-a-time part that was the
  problem, between takes, with people waiting.)

  The rest is the state a rehearsal wants between takes: anything held is let
  go, the projection is back to the title card over a dark wall, and the
  pointer is on cue 1 so one GO starts the piece.
*/

const { suite } = require("./lib/harness");

suite("back to the top", async (t) => {
  const desk = await t.desk();
  const stage = await t.stage();
  const one = await t.player({ part: "I", seat: 1, audio: true });
  const two = await t.player({ part: "II", seat: 1, audio: true });
  await t.sleep(3500);

  const gains = () =>
    Promise.all([one, two].map((p) => p.evaluate(() => window.scan.fade.gain)));
  const held = (p) =>
    p.evaluate(() => ({
      fading: window.scan.fade.running,
      gate: !!(window.scan.voice && window.scan.voice.gate > 0),
    }));
  const wall = () =>
    stage.evaluate(() => ({
      card: Number(getComputedStyle(document.getElementById("titleCard")).opacity),
      tracts: Number(getComputedStyle(document.getElementById("wall")).opacity),
      words: document.getElementById("subtitle").textContent,
    }));

  t.section("1 — a run: the wall up, then everyone fades to nothing");
  await stage.evaluate(() =>
    window.stage.take({
      address: "/stage/set",
      args: [JSON.stringify({ title: false, tracts: true, text: "will not stay still", fade: 0 })],
    })
  );
  // the desk owns the length of the diminuendo; make it short
  for (const p of [one, two]) await p.evaluate(() => window.scan.applyRemote("/cue/fade", [1]));
  // move the pointer somewhere late, as a finished run leaves it
  await desk.evaluate(() => window.conduct.goTo(30));
  await t.sleep(600);

  for (const p of [one, two]) {
    await p.keyboard.press("ArrowDown"); // the diminuendo
  }
  await t.sleep(2200); // past the end of a one-second fade

  let g = await gains();
  t.check(
    g.every((x) => x < 0.02),
    "both players are at nothing",
    `gains ${g.map((x) => x.toFixed(3)).join(", ")}`
  );
  const stillFading = await Promise.all([one, two].map(held));
  // the curve has landed, and the page still regards the diminuendo as the
  // state it is in, which is what makes the tag read "silent"
  t.check(
    stillFading.every((h) => h.fading === true),
    "the diminuendo is still the state they are in",
    `fading ${stillFading.map((h) => h.fading).join(", ")}`
  );
  const at = await desk.evaluate(() => window.conduct.at);
  t.check(at === 30, "the pointer is where the run left it", `cue index ${at}`);

  t.section("2 — one press of back to top");
  await desk.click("#resetBtn");
  await t.sleep(1500);

  g = await gains();
  t.check(
    g.every((x) => x > 0.98),
    "every player's level is back up",
    `gains ${g.map((x) => x.toFixed(3)).join(", ")}`
  );
  const after = await Promise.all([one, two].map(held));
  t.check(after.every((h) => !h.gate), "nothing is sounding", `gates ${after.map((h) => h.gate).join(", ")}`);

  const w = await wall();
  t.check(w.card === 1, "the title card is up", `card opacity ${w.card}`);
  t.check(w.tracts === 0, "over a dark wall", `wall opacity ${w.tracts}`);

  const back = await desk.evaluate(() => ({ at: window.conduct.at, armed: window.conduct.armed, landed: window.conduct.landed }));
  t.check(back.at === 0, "the pointer is on cue 1", `cue index ${back.at}`);
  t.check(back.armed === null, "with nothing armed", `armed ${back.armed}`);
  t.check(back.landed === null, "and nothing sent yet this run", `landed ${back.landed}`);

  t.section("3 — and it is ready to play again");
  const phrase = await one.evaluate(() => window.scan.phrase);
  t.check(phrase !== undefined, "the phrase was left where it was, for cue 1 to set", `phrase ${JSON.stringify(phrase)}`);
  await one.keyboard.down("a");
  await t.sleep(900);
  const sounding = await one.evaluate(() => ({
    gate: window.scan.voice.gate,
    fade: window.scan.fade.gain,
  }));
  await one.keyboard.up("a");
  t.check(sounding.gate > 0, "a key opens the gate again", `gate ${sounding.gate}`);
  t.check(sounding.fade > 0.98, "and it is audible, not still faded out", `fade gain ${sounding.fade.toFixed(3)}`);

  t.section("4 — pressing it again from a clean desk changes nothing");
  await desk.click("#resetBtn");
  await t.sleep(1200);
  const twice = await wall();
  const deskTwice = await desk.evaluate(() => window.conduct.at);
  t.check(twice.card === 1 && twice.tracts === 0, "the wall is where it was", `card ${twice.card}, wall ${twice.tracts}`);
  t.check(deskTwice === 0, "the pointer is still on cue 1", `cue index ${deskTwice}`);
});
