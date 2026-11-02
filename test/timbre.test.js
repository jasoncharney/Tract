/*
  Two voices on the same written note should not be quite the same voice.

  The difference is the length of the throat, not the pitch — measured on a
  held A3 with the vibrato genuinely off, the four parts' tract lengths move
  the spectral centroid by 25% and F2 by 520 cents while every one of them
  sounds 218.3 Hz. Doing it with vibrato instead would decorrelate the pitch,
  which on a written unison is just out of tune, and would fight the passages
  written for straight tone.

  The thing most likely to break quietly here is the preset round-trip: a
  preset must store the WRITTEN tract length, with neither the part's body nor
  the seat's share of it baked in, or every save would drift the voice one
  seat further along.
*/

const { suite } = require("./lib/harness");

// the live value, after the part and the seat have been added to the preset
const tractOf = (page) => page.evaluate(() => window.scan.tractLength);

suite("timbre", async (t) => {
  t.section("1 — the parts are different bodies");
  const pages = {};
  for (const part of ["I", "II", "III", "IV"]) {
    pages[part] = await t.player({ part, seat: 1, audio: true });
    await pages[part].evaluate(() => window.scan.applyRemote("/scan/phrase", [3]));
  }
  await t.sleep(400);
  const lengths = {};
  for (const part of ["I", "II", "III", "IV"]) lengths[part] = await tractOf(pages[part]);
  t.note(`tract length by part: ${Object.entries(lengths).map(([k, v]) => `${k} ${v}`).join("   ")}`);
  const values = Object.values(lengths);
  t.check(new Set(values).size === 4, "all four differ", values.join(", "));
  t.check(
    values[0] < values[1] && values[1] < values[2] && values[2] < values[3],
    "and they run shortest to longest, I through IV — the SATB conceit"
  );
  t.check(
    Math.max(...values) - Math.min(...values) >= 10,
    "by enough to hear",
    `${Math.max(...values) - Math.min(...values)} units apart end to end`
  );

  t.section("2 — and the two players on a part are not identical either");
  const seat1 = pages.II;
  const seat2 = await t.player({ part: "II", seat: 2, audio: true });
  await seat2.evaluate(() => window.scan.applyRemote("/scan/phrase", [3]));
  await t.sleep(400);
  const a = await tractOf(seat1);
  const b = await tractOf(seat2);
  t.check(a !== b, "seats 1 and 2 on the same part have different throats", `${a} vs ${b}`);
  t.check(
    Math.abs(a - b) >= 2 && Math.abs(a - b) <= 5,
    "by less than the gap between parts — a difference, not a transposition",
    `${Math.abs(a - b)} units`
  );

  t.section("3 — the pitch is left completely alone");
  for (const [name, page] of [["I", pages.I], ["IV", pages.IV]]) {
    const note = await page.evaluate(() => {
      window.scan.applyRemote("/scan/note", [57]);
      return window.scan.note;
    });
    t.check(Math.abs(note - 57) < 0.001, `part ${name} still sings exactly the note it was given`, `${note}`);
  }

  t.section("4 — a saved preset stores the written value, not this seat's");
  const written = await seat1.evaluate(() => window.scan.capturePreset().tractLength);
  const written2 = await seat2.evaluate(() => window.scan.capturePreset().tractLength);
  t.check(
    Math.abs(written - written2) < 0.001,
    "two seats on a part capture the same written tract length",
    `${written} vs ${written2}`
  );
  const partI = await pages.I.evaluate(() => window.scan.capturePreset().tractLength);
  t.check(
    Math.abs(written - partI) < 0.001,
    "and so do two different parts — the body is added on playback, not saved",
    `II ${written} vs I ${partI}`
  );

  // and saving then re-applying must not drift the voice
  const before = await seat2.evaluate(() => window.scan.tractLength);
  const after = await seat2.evaluate(async () => {
    const p = window.scan.capturePreset();
    window.scan.applyPreset(window.scan.phrase - 1, p);
    await new Promise((r) => setTimeout(r, 200));
    return window.scan.tractLength;
  });
  t.check(
    Math.abs(before - after) < 0.001,
    "capturing and re-applying a preset leaves the voice where it was",
    `${before} → ${after}`
  );
});
