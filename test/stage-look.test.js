/*
  The merge, end to end: a real bridge, a real desk, a real wall, real players.

  What has to be true:
    1. Nothing changed by default — the wall still draws the ribbon until
       somebody asks for otherwise.
    2. The desk can switch it, and the wall actually draws something else.
    3. Angles saved per part per phrase reach the wall, and two players on one
       part do NOT end up identical.
    4. Shuffle moves them, and the next phrase takes the shuffle back.
    5. A projector that reloads mid-piece comes back to the right look.
    6. The stage page has no keys left on it.
*/
const { suite } = require("./lib/harness");

suite("the look, moved to the desk", async (t) => {
  const desk = await t.desk();
  const stage = await t.stage();
  // audio on: a player with no synth has no tract to send, so the wall
  // would be empty and every check below would pass against nothing
  const a = await t.player({ part: "II", seat: 1, audio: true });
  const b = await t.player({ part: "II", seat: 2, audio: true });
  await t.sleep(4000);

  const wall = () =>
    stage.evaluate(() => ({
      renderer: window.stage.look ? window.stage.look.renderer : null,
      surface: window.stage.look ? window.stage.look.surface : null,
      aims: window.stage.aims ? window.stage.aims() : null,
    }));

  t.section("1 — by default the wall draws what it always drew");
  let w = await wall();
  t.check(w.renderer === "ribbon", "the ribbon, as before", `renderer ${w.renderer}`);

  t.section("2 — the desk switches the drawing");
  await desk.evaluate(() => {
    const sel = document.getElementById("lookRenderer");
    sel.value = "wire";
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await t.sleep(1200);
  w = await wall();
  t.check(w.renderer === "wire", "the wall is told", `renderer ${w.renderer}`);
  const ink = await stage.evaluate(() => {
    const c = document.querySelector("#wall canvas");
    if (!c) return -1;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n;
  });
  t.check(ink > 200, "and is drawing something", `${ink} lit pixels`);

  /*
    The desk repeats the whole look on its 2.5s heartbeat. A wall that took
    every repeat for a change of drawing cleared its phoneme state each time,
    and a held /ɚ/ faded out and back into itself every two and a half
    seconds. Fed by hand so the phoneme cannot change underneath the check.
  */
  const presence = await stage.evaluate(async () => {
    const d = [];
    for (let i = 0; i < 44; i++) d.push(1 + Math.sin(i / 5) * 0.6);
    const send = () =>
      window.stage.take({
        address: "/tract/frame",
        args: ["3", "held", JSON.stringify({ d, lip: 39, a: 0.2, i: 1, v: 1, p: "ɚ" })],
      });
    send();
    const feed = setInterval(send, 50);
    await new Promise((r) => setTimeout(r, 1500));
    const seen = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      const me = window.stage.frames.find((f) => f.machine === "held");
      seen.push(me ? me.glyph : -1);
      await new Promise((r) => setTimeout(r, 40));
    }
    clearInterval(feed);
    return { min: Math.min(...seen), n: seen.length };
  });
  t.check(
    presence.min > 0.9,
    "a held phoneme stays put through the desk's heartbeats",
    `presence never below ${presence.min.toFixed(3)} over ${presence.n} samples, 6s`
  );

  t.section("3 — angles are per part, seats are not identical");
  await desk.evaluate(() => {
    window.conduct.setAngle(2, "YAW", 0.9);
    window.conduct.setAngle(2, "PITCH", -0.4);
  });
  await t.sleep(1500);
  w = await wall();
  const two = Object.entries(w.aims || {}).filter(([, v]) => v.part === "2");
  t.check(two.length === 2, "both part II players are on the wall", `${two.length} of them`);
  if (two.length === 2) {
    const [p, q] = two.map(([, v]) => v);
    t.check(
      Math.abs(p.yaw - 0.9) < 0.45 && Math.abs(q.yaw - 0.9) < 0.45,
      "both are aimed near the angle saved for their part",
      `yaws ${p.yaw.toFixed(2)}, ${q.yaw.toFixed(2)} against 0.9`
    );
    t.check(
      Math.abs(p.yaw - q.yaw) > 0.01,
      "but not at the same angle as each other",
      `apart by ${Math.abs(p.yaw - q.yaw).toFixed(3)}`
    );
  }

  t.section("4 — shuffle, and the next phrase taking it back");
  const before = (await wall()).aims;
  // watch one camera from just before the press: where it is drawn from, not
  // where it is aimed — the aim is meant to jump, the drawing is not
  const watching = stage.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      const f = window.stage.frames.find((x) => x.cam);
      if (f) out.push(f.cam.yaw);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  });
  await t.sleep(200);
  await desk.click("#shuffleBtn");
  const path = await watching;
  const after = (await wall()).aims;
  const n = Object.keys(before).length;
  /*
    Not "every camera moved by at least x": the offsets are drawn at random,
    so one of them being near zero is the shuffle working, not failing, and a
    per-camera threshold makes this flaky about one run in eight. The total
    movement across the wall is the thing that cannot happen by chance.
    "0 of 0" is not a pass either — an empty wall would sail through it.
  */
  const total = Object.keys(before).reduce(
    (sum, k) => sum + (after[k] ? Math.abs(after[k].yaw - before[k].yaw) : 0),
    0
  );
  t.check(n > 0 && total > 0.2, "the cameras scattered", `${total.toFixed(2)} of yaw across ${n} of them`);
  /*
    Eased, not cut. Before the wall stopped resetting on every look, the
    shuffle's own message threw each camera away and the next frame drew it
    straight at the new angle: one frame carried the whole move.
  */
  let biggest = 0;
  for (let i = 1; i < path.length; i++) biggest = Math.max(biggest, Math.abs(path[i] - path[i - 1]));
  const travel = path.length ? Math.abs(path[path.length - 1] - path[0]) : 0;
  t.check(
    travel > 0.02 && biggest < travel * 0.15,
    "and each one swings there rather than cutting",
    `moved ${travel.toFixed(3)} over ${path.length} frames, largest single step ${biggest.toFixed(3)}`
  );
  const seed = await stage.evaluate(() => window.stage.look.shuffle);
  t.check(seed !== 0, "the wall is holding a shuffle", `seed ${seed}`);

  await desk.evaluate(() => window.conduct.lookAtPhrase(3));
  await t.sleep(1200);
  const seedAfter = await stage.evaluate(() => window.stage.look.shuffle);
  t.check(seedAfter === 0, "and the next phrase lets it go", `seed ${seedAfter}`);

  t.section("5 — a projector that reloads comes back right");
  await stage.reload({ waitUntil: "load" });
  await stage.waitForFunction(() => window.stage && window.stage.take, null, { timeout: 20000 });
  await t.sleep(1000);
  const straightAway = await stage.evaluate(() => window.stage.look.renderer);
  t.check(straightAway === "wire", "it remembers before the desk says anything", `renderer ${straightAway}`);
  await t.sleep(3000); // and a heartbeat confirms it
  const afterBeat = await wall();
  t.check(afterBeat.renderer === "wire", "and the heartbeat agrees", `renderer ${afterBeat.renderer}`);

  t.section("6 — nothing to press on the projector");
  const keys = await stage.evaluate(() => {
    const before = document.body.innerHTML.length;
    for (const k of ["l", "L", "f"]) document.dispatchEvent(new KeyboardEvent("keydown", { key: k }));
    return { changed: document.body.innerHTML.length !== before };
  });
  t.check(!keys.changed, "the old keys do nothing", `changed: ${keys.changed}`);
});
