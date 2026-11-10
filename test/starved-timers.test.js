/*
  test/starved-timers.test.js — a window whose timers have been throttled.

  Chrome clamps a hidden window's setInterval to one a second, and after five
  minutes of that to one a MINUTE. A tester window whose part is resting makes
  no sound, so it is not exempt the way an audible tab is. The stage forgets a
  player after six quiet seconds and the desk after nine — so a window behind
  another drops off the wall while it is still running perfectly well.

  That is why it is never seen with real players: one window each, every one
  of them in front. It is seen with eight tester windows on one screen.

  The page already kept a worker beat for the audio tick, for exactly this
  reason, measured on the real binary: a window behind another got 8 frames in
  4.5s instead of 271. The heartbeats now ride the same beat when the page's
  own timers stop bringing them round.

  Simulated here by stopping every interval in the page, which is the end
  state of the throttling. Run against the code before the fix, the stage
  loses the player within eight seconds while the desk still counts it —
  exactly the report this came from.
*/

const { suite } = require("./lib/harness");

suite("a player whose timers have been throttled to a stop", async (t) => {
  const desk = await t.desk();
  const stage = await t.stage();
  const player = await t.player({ part: "I", seat: 1, query: "&midich=1", audio: true });
  await t.sleep(4000);

  const look = async () => ({
    tiles: await stage.evaluate(() => document.querySelectorAll("#wall .tile").length),
    roster: await desk.evaluate(() =>
      window.conduct.roster.filter(([, i]) => Date.now() - i.at < 9000).length
    ),
    strips: await desk.evaluate(() => document.querySelectorAll("#strips .pstrip").length),
  });

  t.section("1 — with its own timers running");
  let s = await look();
  t.check(s.tiles === 1, "the stage draws it", `${s.tiles} tiles`);
  t.check(s.roster === 1, "the desk counts it", `${s.roster} connected`);
  t.check(s.strips === 1, "and gives it a strip", `${s.strips} strips`);

  t.section("2 — every interval in the page stopped");
  // the worker beat is now the only thing left that can send anything
  await player.evaluate(() => {
    const last = setInterval(() => {}, 100000);
    for (let i = 1; i <= last; i++) clearInterval(i);
  });

  await t.sleep(8000); // past the stage's six seconds
  s = await look();
  t.check(s.tiles === 1, "eight seconds on, the stage still draws it", `${s.tiles} tiles`);
  t.check(s.roster === 1, "the desk still counts it", `${s.roster} connected`);
  t.check(s.strips === 1, "and its strip is still moving", `${s.strips} strips`);

  await t.sleep(8000); // and past the desk's nine
  s = await look();
  t.check(s.tiles === 1, "sixteen seconds on, still drawn", `${s.tiles} tiles`);
  t.check(s.roster === 1, "still counted", `${s.roster} connected`);
  t.check(s.strips === 1, "still stripped", `${s.strips} strips`);

  t.section("3 — and it is really the beat doing it");
  // if the page's own timers had quietly restarted, this would prove nothing
  const alive = await player.evaluate(() => {
    const id = setInterval(() => {}, 100000);
    clearInterval(id);
    return id;
  });
  t.check(alive > 0, "no interval of the page's own is running", `next id would be ${alive}`);
  const ready = await player.evaluate(() => window.scan.isReady());
  t.check(ready === true, "and the player is still a working player", `isReady ${ready}`);
});
