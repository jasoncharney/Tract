/*
  test/stage-blank.test.js — the projector's blank.

  A toggle on the desk, not a cue: the piece never reaches this state on its
  own. It is for putting the title card up and leaving it waiting behind a
  dark screen, so the room is given it at the moment the conductor chooses
  rather than at the moment he sets it up.

  Two things have to be true for that to be usable. Nothing underneath may be
  disturbed — take the blank off and the card is there, where it was put. And
  the desk has to say so, because a blanked projector and a broken one look
  the same from the podium.
*/

const { suite } = require("./lib/harness");

suite("the projector's blank", async (t) => {
  const desk = await t.desk();
  const stage = await t.stage();
  await t.sleep(1500);

  const look = () =>
    stage.evaluate(() => ({
      blanked: window.stage.blanked,
      sheet: Number(getComputedStyle(document.getElementById("blankout")).opacity),
      card: Number(getComputedStyle(document.getElementById("titleCard")).opacity),
      wall: Number(getComputedStyle(document.getElementById("wall")).opacity),
      words: document.getElementById("subtitle").textContent,
    }));
  const readout = () =>
    desk.evaluate(() => ({
      on: window.conduct.blanked,
      label: document.getElementById("blankBtn").textContent.trim(),
      lit: document.getElementById("blankBtn").classList.contains("on"),
      line: document.getElementById("blankLine").hidden
        ? ""
        : document.getElementById("blankLine").textContent,
    }));

  t.section("1 — off to begin with");
  let d = await readout();
  t.check(d.on === false, "the desk says not blanked", `blanked ${d.on}`);
  t.check(d.label === "blank", "the button offers it", `"${d.label}"`);
  t.check(d.line === "", "and says nothing about it", `"${d.line}"`);
  let s = await look();
  t.check(s.sheet === 0, "no sheet over the projection", `opacity ${s.sheet}`);

  t.section("2 — blank, then prime the title card behind it");
  await desk.click("#blankBtn");
  await t.sleep(1400);
  s = await look();
  t.check(s.blanked === true, "the stage knows it is blanked", `blanked ${s.blanked}`);
  t.check(s.sheet === 1, "the sheet is over everything", `opacity ${s.sheet}`);

  await desk.click("#titleCardBtn");
  await t.sleep(2200);
  s = await look();
  t.check(s.sheet === 1, "still blank while the card goes up behind it", `sheet ${s.sheet}`);
  t.check(s.card === 1, "and the card IS up, under the sheet", `card opacity ${s.card}`);

  d = await readout();
  t.check(d.lit === true, "the button reads as on", `class on: ${d.lit}`);
  t.check(d.label === "blanked", "and says which way it is", `"${d.label}"`);
  t.check(
    d.line.includes("title card"),
    "the desk says what is waiting behind it",
    `"${d.line}"`
  );

  t.section("3 — unblank, and there it is");
  await desk.click("#blankBtn");
  await t.sleep(1400);
  s = await look();
  t.check(s.sheet === 0, "the sheet is gone", `opacity ${s.sheet}`);
  t.check(s.card === 1, "and the title card was there all along", `card opacity ${s.card}`);
  d = await readout();
  t.check(d.on === false && d.label === "blank", "the desk agrees", `"${d.label}"`);
  t.check(d.line === "", "and stops saying it", `"${d.line}"`);

  t.section("4 — a projector that reloads while blanked comes back blanked");
  // the desk repeats the standing stage on its heartbeat, and the blank rides
  // with it: a plug pulled mid-rehearsal must not reveal a primed card
  await desk.click("#blankBtn");
  await t.sleep(1200);
  await stage.reload({ waitUntil: "load" });
  await stage.waitForFunction(() => window.stage && window.stage.take, null, { timeout: 20000 });
  await t.sleep(4000); // a heartbeat or two
  s = await look();
  t.check(s.blanked === true, "it is blanked again without being told twice", `blanked ${s.blanked}`);
  t.check(s.sheet === 1, "with the sheet back over it", `opacity ${s.sheet}`);

  t.section("5 — back to top leaves the blank where it is");
  await desk.click("#resetBtn");
  await t.sleep(2200);
  s = await look();
  t.check(s.sheet === 1, "still blank", `opacity ${s.sheet}`);
  t.check(s.card === 1, "with the card primed behind it", `card opacity ${s.card}`);
  d = await readout();
  t.check(d.on === true, "and the desk still says so", `blanked ${d.on}`);

  t.section("6 — no cue in the sheet ever sets it");
  const fromCues = await desk.evaluate(() =>
    window.conduct.cues.filter((c) => c.stage && "blank" in c.stage).length
  );
  t.check(fromCues === 0, "blank is the desk's alone", `${fromCues} cues mention it`);
});
