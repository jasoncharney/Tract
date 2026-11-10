/*
  test/stage-ending.test.js — the last cue, and what the room sees.

  The piece ends on a cue that takes the tracts down over eight seconds and
  clears the caption in the same breath. Two things went wrong with that.

  The caption left on its own half second while the drawings took eight, so
  "will not stay still" was gone long before the thing it names. And clearing
  the text gave the strip of wall back at once, which re-lays the wall: every
  tract jumped a size larger in the middle of the diminuendo.

  So the words now fade on the wall's clock, and the strip is reclaimed only
  once the wall is at nothing. The check that matters is geometric — the
  tiles must not move while anyone can still see them.
*/

const { suite } = require("./lib/harness");

const FADE = 4; // seconds; the real cue says 8, this says the same thing sooner

suite("the last cue takes the words with it", async (t) => {
  const stage = await t.stage();
  const players = [];
  for (const [part, seat] of [["I", 1], ["II", 1], ["III", 1]]) {
    players.push(await t.player({ part, seat, audio: true }));
  }
  await t.sleep(4000);

  const send = (block) =>
    stage.evaluate(
      (block) => window.stage.take({ address: "/stage/set", args: [JSON.stringify(block)] }),
      block
    );

  const look = () =>
    stage.evaluate(() => ({
      words: document.getElementById("subtitle").textContent,
      wordsOpacity: Number(getComputedStyle(document.getElementById("subtitle")).opacity),
      wall: Number(getComputedStyle(document.getElementById("wall")).opacity),
      subs: getComputedStyle(document.documentElement).getPropertyValue("--subs").trim(),
      tiles: [...document.querySelectorAll("#wall .tile")].map((el) => {
        const r = el.getBoundingClientRect();
        return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
      }),
    }));

  t.section("1 — the piece running, words up");
  await send({ title: false, tracts: true, text: "will not stay still", fade: 0 });
  await t.sleep(1200);
  const before = await look();
  t.check(before.wall === 1, "the wall is lit", `opacity ${before.wall}`);
  t.check(before.words === "will not stay still", "the caption is up", `"${before.words}"`);
  t.check(before.tiles.length === 3, "three tracts on it", `${before.tiles.length} tiles`);
  t.check(before.subs === "15vh", "and the wall has given up its strip", `--subs ${before.subs}`);

  t.section("2 — the last cue, a quarter of the way through the fade");
  await send({ tracts: false, text: "", fade: FADE });
  await t.sleep(FADE * 250);
  const during = await look();
  t.check(
    during.wordsOpacity > 0.05 && during.wordsOpacity < 0.95,
    "the caption is fading, not gone",
    `opacity ${during.wordsOpacity.toFixed(2)}`
  );
  t.check(
    during.wall > 0.05 && during.wall < 0.95,
    "and so is the wall",
    `opacity ${during.wall.toFixed(2)}`
  );
  t.check(
    during.words === "will not stay still",
    "the words are still the words",
    `"${during.words}"`
  );
  t.check(
    JSON.stringify(during.tiles) === JSON.stringify(before.tiles),
    "and not one tract has moved or resized",
    `${during.tiles[0]} vs ${before.tiles[0]}`
  );

  t.section("3 — halfway, still nothing jumping");
  await t.sleep(FADE * 300);
  const half = await look();
  t.check(
    JSON.stringify(half.tiles) === JSON.stringify(before.tiles),
    "the tracts are where they were",
    `${half.tiles[0]} vs ${before.tiles[0]}`
  );
  t.check(half.wordsOpacity < during.wordsOpacity, "the caption is further out", `opacity ${half.wordsOpacity.toFixed(2)}`);

  t.section("4 — after it, with the wall at nothing");
  await t.sleep(FADE * 600 + 600);
  const after = await look();
  t.check(after.wall === 0, "the wall is dark", `opacity ${after.wall}`);
  t.check(after.wordsOpacity === 0, "the caption is out", `opacity ${after.wordsOpacity}`);
  t.check(after.words === "", "and cleared", `"${after.words}"`);
  t.check(after.subs === "0px", "the strip is given back, where nobody can see it", `--subs ${after.subs}`);

  t.section("5 — an ordinary change of words still changes them");
  await send({ tracts: true, text: "words strain", fade: 0 });
  await t.sleep(1400);
  const back = await look();
  t.check(back.words === "words strain", "the next run's caption arrives", `"${back.words}"`);
  t.check(back.wordsOpacity === 1, "at full strength", `opacity ${back.wordsOpacity}`);
  t.check(back.subs === "15vh", "and the strip is given up again", `--subs ${back.subs}`);
});
