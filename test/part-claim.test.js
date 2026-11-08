/*
  test/part-claim.test.js — a laptop that has not chosen a part claims none.

  Why this exists: the desk reported "7 connected" in rehearsal while the wall
  drew 6. The wall was right — the seventh had not started its audio, so it had
  no tract to draw — but chasing that turned up something worse. partIndex
  starts at 0 so the page has something to draw before anyone picks, and the
  page used to say "part I" on the wire from its first heartbeat. So a laptop
  sitting on the open part-picker

    - added itself to part I's count on the roster,
    - fed the per-part coverage warning a number that was wrong, and
    - took a seat on part I, which changed `of` for the players really on it,
      and `of` is what a phrase divides its pitches by.

  The last one is the reason this is a test and not a note: it moves pitches
  under players who did nothing wrong. Run against the old code, the four
  checks that matter here fail, with `of` reading 3 where it should read 2.

  The laptop still appears in the desk's total, because it is in the room and
  the conductor needs to know it is there.
*/

const { suite } = require("./lib/harness");

/** a laptop on the open part-picker, nobody having clicked yet */
async function joiner(t) {
  const { page, context } = await t.freshPlayer();
  await page.waitForSelector("#partChoices .partchoice", { timeout: 20000 });
  return { page, context };
}

/** ...and one that has clicked the nth part, with its audio running */
async function chooser(t, nth) {
  const { page, context } = await joiner(t);
  await page.locator("#partChoices .partchoice").nth(nth).click();
  await page.waitForFunction(() => window.scan.isReady(), null, { timeout: 30000 });
  return { page, context };
}

const deskState = (desk) =>
  desk.evaluate(() => {
    const row = (name) => {
      const found = [...document.querySelectorAll("#roster .who")].find(
        (r) => r.querySelector(".name").textContent === name
      );
      return found ? Number(found.querySelector(".count").textContent) : null;
    };
    return {
      I: row("I"),
      III: row("III"),
      IV: row("IV"),
      total: Number(String((document.getElementById("rosterTotal") || {}).textContent || "").split(" ")[0]),
      strips: document.querySelectorAll("#strips .pstrip").length,
      claimed: window.conduct.roster.filter(([, i]) => Date.now() - i.at < 9000).map(([, i]) => i.part),
    };
  });

suite("a laptop with no part chosen claims no part", async (t) => {
  const desk = await t.desk();

  t.section("two laptops that really are on part I");
  const one = await chooser(t, 0);
  const two = await chooser(t, 0);
  await t.sleep(3500);

  const seatsBefore = await Promise.all([one, two].map((p) => p.page.evaluate(() => window.scan.seating)));
  let d = await deskState(desk);
  t.check(d.total === 2, "the desk counts two", `total ${d.total}`);
  t.check(d.I === 2, "part I's row counts both", `I = ${d.I}`);
  t.check(
    seatsBefore.every((s) => s.of === 2),
    "part I divides its pitches two ways",
    `of = ${seatsBefore.map((s) => s.of).join(", ")}`
  );
  t.check(d.strips === 2, "two strips along the bottom", `${d.strips} strips`);

  t.section("a third, open on the picker, nobody having clicked");
  const third = await joiner(t);
  await t.sleep(5000);

  const state = await third.page.evaluate(() => ({
    chosen: window.scan.partChosen,
    part: window.scan.part.id,
  }));
  t.check(!state.chosen, "it knows it has not chosen", `partChosen = ${state.chosen}`);
  t.check(
    state.part === "1",
    "while still defaulting to part I in itself, so there is something to draw",
    `part.id = ${state.part}`
  );

  const seatsAfter = await Promise.all([one, two].map((p) => p.page.evaluate(() => window.scan.seating)));
  d = await deskState(desk);
  t.check(d.total === 3, "the desk still counts it — it is in the room", `total ${d.total}`);
  t.check(d.I === 2, "but part I's row is still two", `I = ${d.I}`);
  t.check(
    d.claimed.filter((x) => x === "1").length === 2,
    "and only two machines claim part 1 on the wire",
    `claimed: [${d.claimed.map((x) => `"${x}"`).join(", ")}]`
  );
  t.check(
    seatsAfter.every((s) => s.of === 2),
    "part I still divides its pitches two ways",
    `of = ${seatsAfter.map((s) => s.of).join(", ")}`
  );
  t.check(d.strips === 2, "no strip for a laptop with no part", `${d.strips} strips`);

  t.section("then they click part III");
  await third.page.locator("#partChoices .partchoice").nth(2).click();
  await third.page.waitForFunction(() => window.scan.isReady(), null, { timeout: 30000 });
  await t.sleep(3000);
  d = await deskState(desk);
  const seatsEnd = await Promise.all([one, two].map((p) => p.page.evaluate(() => window.scan.seating)));
  t.check(d.I === 2 && d.III === 1, "the choice lands on III and leaves I alone", `I = ${d.I}, III = ${d.III}`);
  t.check(d.strips === 3, "and its strip appears", `${d.strips} strips`);
  t.check(
    seatsEnd.every((s) => s.of === 2),
    "part I's seating was never disturbed",
    `of = ${seatsEnd.map((s) => s.of).join(", ")}`
  );

  t.section("?part= in the URL is itself a choice");
  // it skips the picker, and so skips the click that starts audio: this page
  // is counted and placed on its part while making no sound at all
  const fourth = await t.player({ part: "IV", seat: 1 });
  await t.sleep(4000);
  const chosen = await fourth.evaluate(() => window.scan.partChosen);
  const ready = await fourth.evaluate(() => window.scan.isReady());
  d = await deskState(desk);
  t.check(chosen, "?part= counts as choosing", `partChosen = ${chosen}`);
  t.check(!ready, "its audio is not running, because nothing was clicked", `isReady = ${ready}`);
  t.check(d.IV === 1, "and it is on part IV regardless", `IV = ${d.IV}`);

  await Promise.all([one, two, third].map((p) => p.context.close()));
});
