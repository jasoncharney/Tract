/*
  The merge, end to end: a real bridge, a real desk, a real wall, real players.

  What has to be true:
    1. By default the wall draws the tract in space, as look.json has it.
    2. The desk can switch it, and the wall actually draws something else.
    3. Angles saved per part per phrase reach the wall, and two players on one
       part do NOT end up identical.
    4. Shuffle moves them, per part; an unsaved phrase shuffles by itself,
       and a saved one takes the shuffle back.
    5. A projector that reloads mid-piece comes back to the right look.
    6. The stage page has no keys left on it.
    7. The tuning page draws, reads look.json back to exactly what is on
       disk, and carries the words cues.json gives the phrase.
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

  t.section("1 — by default the wall draws the tract in space");
  let w = await wall();
  t.check(w.renderer === "wire", "the wire, as look.json has it", `renderer ${w.renderer}`);

  t.section("2 — the desk switches the drawing");
  const pick = (renderer) =>
    desk.evaluate((r) => {
      const sel = document.getElementById("lookRenderer");
      sel.value = r;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, renderer);
  await pick("ribbon");
  await t.sleep(1200);
  w = await wall();
  t.check(w.renderer === "ribbon", "the wall is told", `renderer ${w.renderer}`);
  const ink = await stage.evaluate(() => {
    const c = document.querySelector("#wall canvas");
    if (!c) return -1;
    const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 30) n++;
    return n;
  });
  t.check(ink > 200, "and is drawing something", `${ink} lit pixels`);
  // and back: everything below is about the wire's phoneme and cameras
  await pick("wire");
  await t.sleep(1200);
  w = await wall();
  t.check(w.renderer === "wire", "and back to the wire", `renderer ${w.renderer}`);

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
    window.conduct.setAngle(2, "YAW", -0.9);
    window.conduct.setAngle(2, "PITCH", 0.4);
  });
  await t.sleep(1500);
  w = await wall();
  const two = Object.entries(w.aims || {}).filter(([, v]) => v.part === "2");
  t.check(two.length === 2, "both part II players are on the wall", `${two.length} of them`);
  if (two.length === 2) {
    const [p, q] = two.map(([, v]) => v);
    t.check(
      Math.abs(p.yaw + 0.9) < 0.45 && Math.abs(q.yaw + 0.9) < 0.45,
      "both are aimed near the angle saved for their part",
      `yaws ${p.yaw.toFixed(2)}, ${q.yaw.toFixed(2)} against -0.9`
    );
    t.check(
      Math.abs(p.yaw - q.yaw) > 0.01,
      "but not at the same angle as each other",
      `apart by ${Math.abs(p.yaw - q.yaw).toFixed(3)}`
    );
  }

  /*
    A phrase can carry its own spread beside its parts. The two part II
    seats sit a fixed distance apart across the wall, so their yaws are apart
    by exactly that distance times the spread: tripling it triples the gap.
    Ratios rather than numbers, because the piece's own spread is whatever
    look.json says today. Taken back off afterwards, because everything below
    is measured against the piece's spread.
  */
  if (two.length === 2) {
    const gapAt = async () => {
      const both = Object.values((await wall()).aims || {}).filter((v) => v.part === "2");
      return both.length === 2 ? Math.abs(both[0].yaw - both[1].yaw) : NaN;
    };
    const base = await gapAt();
    const at = async (yaw) => {
      await desk.evaluate((yaw) => {
        window.conduct.look.phrases["1"].spread = { yaw };
        window.conduct.setAngle(2, "YAW", -0.9); // anything that sends the look
      }, yaw);
      await t.sleep(1200);
      return gapAt();
    };
    const narrow = await at(0.1);
    const wide = await at(0.3);
    await desk.evaluate(() => {
      delete window.conduct.look.phrases["1"].spread;
      window.conduct.setAngle(2, "YAW", -0.9);
    });
    await t.sleep(1200);
    const back = await gapAt();
    t.check(
      narrow > 0 && Math.abs(wide / narrow - 3) < 1e-6 && Math.abs(back - base) < 1e-9,
      "a phrase's own spread replaces the piece's, and only while it is there",
      `part II gap ${narrow.toFixed(4)} at the phrase's 0.1, ${wide.toFixed(4)} at 0.3, ` +
        `${base.toFixed(4)} at the piece's before and ${back.toFixed(4)} once removed`
    );
  }

  t.section("4 — shuffle, and the next phrase taking it back");
  // let section 3's swing finish first: from phrase 1's yaw of -1.5 to -0.9 is
  // further than CAMEASE covers in 1.5s, and a camera still on its way there
  // when the shuffle lands is two motions, not one
  await stage.waitForFunction(
    () => {
      const aims = window.stage.aims();
      return window.stage.frames.every((f) => !f.cam || !aims[f.machine] || Math.abs(f.cam.yaw - aims[f.machine].yaw) < 0.01);
    },
    null,
    { timeout: 20000 }
  );
  /*
    The shuffle is per part, so both part II players ride one random draw,
    and a draw near zero moved nothing — about one run in eight. So the seed
    is chosen here, read off look.js, as one that moves part II by at least
    0.5, and the desk's Math.random is held to it for the press.
  */
  const { shuffleOffset, KNOBS, VIEW } = await import(
    require("url").pathToFileURL(require("path").join(__dirname, "../scan/src/look.js")).href
  );
  let r = 0.001;
  while (Math.abs(shuffleOffset("part 2", (r * 0xffffffff) >>> 0).yaw) < 0.5) r += 0.001;
  const nudge = shuffleOffset("part 2", (r * 0xffffffff) >>> 0).yaw;
  const before = (await wall()).aims;
  // watch a part II camera from just before the press: where it is drawn
  // from, not where it is aimed — the aim is meant to jump, the drawing is not
  const watching = stage.evaluate(async () => {
    const out = [];
    const t0 = performance.now();
    while (performance.now() - t0 < 2500) {
      const f = window.stage.frames.find((x) => x.cam && String(x.part) === "2");
      if (f) out.push(f.cam.yaw);
      await new Promise((r) => requestAnimationFrame(r));
    }
    return out;
  });
  await t.sleep(200);
  await desk.evaluate((r) => {
    const was = Math.random;
    Math.random = () => r;
    document.getElementById("shuffleBtn").click();
    Math.random = was;
  }, r);
  const path = await watching;
  const after = (await wall()).aims;
  // "0 of 0" is not a pass — an empty wall would sail through it
  const moved = Object.keys(before)
    .filter((k) => before[k].part === "2" && after[k])
    .map((k) => after[k].yaw - before[k].yaw);
  t.check(
    moved.length === 2 && moved.every((d) => Math.abs(d - nudge) < 1e-9),
    "the cameras moved by the shuffle's nudge",
    `part II moved ${moved.map((d) => d.toFixed(3)).join(", ")}, nudge ${nudge.toFixed(3)}`
  );
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
  /*
    A shuffle is per part: the two part II players move by the same amount,
    so the gap the parallax put between them is the gap that is left.
  */
  const gap = (aims) => {
    const two = Object.values(aims).filter((v) => v.part === "2");
    return two.length === 2 ? two[0].yaw - two[1].yaw : NaN;
  };
  t.check(
    Math.abs(gap(after) - gap(before)) < 1e-9,
    "and one part moves as one",
    `part II gap ${gap(before).toFixed(4)} before, ${gap(after).toFixed(4)} after`
  );

  // a phrase with nothing in look.json shuffles by itself — whichever one
  // that is today, since look.json is being tuned
  const bare = await desk.evaluate(() => {
    const all = window.conduct.look.phrases || {};
    for (let n = 2; n <= 8; n++) {
      const p = all[String(n)] || {};
      if (!["1", "2", "3", "4"].some((k) => p[k])) return n;
    }
    return 0;
  });
  t.check(bare > 0, "there is a phrase with no angles saved to try it on", `phrase ${bare}`);
  await desk.evaluate((n) => window.conduct.lookAtPhrase(n), bare);
  await t.sleep(1200);
  const seedUnsaved = await stage.evaluate(() => window.stage.look.shuffle);
  t.check(
    seedUnsaved !== 0 && seedUnsaved !== seed,
    "a phrase with no saved angles gets a shuffle of its own",
    `seed ${seedUnsaved}, was ${seed}`
  );

  /*
    And with nothing saved to nudge, the shuffle picks the yaw outright,
    from the whole knob — which stops short of the throat end, so it is
    never from behind the tongue. Read off look.js itself, so the wall is
    checked against the formula and the formula against the range.
  */
  const unsavedAims = Object.values((await wall()).aims).filter((v) => v.part === "2");
  const picked = shuffleOffset("part 2", seedUnsaved).anyYaw;
  const wallSpread = await stage.evaluate(() => window.stage.look.spread);
  const off = unsavedAims.map((v) => v.yaw - picked);
  t.check(
    unsavedAims.length === 2 && off.every((d) => Math.abs(d) <= wallSpread.yaw + 1e-9),
    "an unsaved part is aimed at the shuffle's own yaw, give or take its seat",
    `picked ${picked.toFixed(3)}, seats off by ${off.map((d) => d.toFixed(3)).join(", ")}`
  );
  const yaws = [];
  for (let s = 1; s <= 400; s++) yaws.push(shuffleOffset("part 2", s * 2654435761 >>> 0).anyYaw);
  const lo = Math.min(...yaws);
  const hi = Math.max(...yaws);
  const [, , yawLo, yawHi] = KNOBS.find((k) => k[0] === "YAW");
  t.check(
    lo < yawLo + 0.1 && hi > yawHi - 0.1 && lo >= yawLo && hi <= yawHi,
    "and over many shuffles it covers the whole yaw knob and no more",
    `400 seeds: ${lo.toFixed(3)} to ${hi.toFixed(3)}, knob ${yawLo} to ${yawHi}`
  );

  // phrase 1 has angles saved (section 3 put them there), so it lets go
  await desk.evaluate(() => window.conduct.lookAtPhrase(1));
  await t.sleep(1200);
  const seedAfter = await stage.evaluate(() => window.stage.look.shuffle);
  t.check(seedAfter === 0, "and a saved phrase lets it go", `seed ${seedAfter}`);

  /*
    Never from behind the tongue, however the angles are arrived at. Part II
    is saved at the very edge of both knobs and given a shuffle that pushes
    further — toward the throat and from below — which without VIEW would
    aim past both limits. The phrase's spread is set to nothing for it, so
    neither seat's parallax can pull it back inside on its own.
  */
  const [, , pitchLo] = KNOBS.find((k) => k[0] === "PITCH");
  let rb = 0.001;
  const pushes = (x) => {
    const o = shuffleOffset("part 2", (x * 0xffffffff) >>> 0);
    return o.yaw > VIEW.yawMax - yawHi + 0.05 && o.pitch < VIEW.pitchMin - pitchLo - 0.05;
  };
  while (!pushes(rb)) rb += 0.001;
  const push = shuffleOffset("part 2", (rb * 0xffffffff) >>> 0);
  await desk.evaluate(([yaw, pitch]) => {
    window.conduct.look.phrases["1"].spread = { yaw: 0, pitch: 0 };
    window.conduct.setAngle(2, "YAW", yaw);
    window.conduct.setAngle(2, "PITCH", pitch);
  }, [yawHi, pitchLo]);
  await desk.evaluate((r) => {
    const was = Math.random;
    Math.random = () => r;
    document.getElementById("shuffleBtn").click();
    Math.random = was;
  }, rb);
  await t.sleep(1200);
  const pushed = Object.values((await wall()).aims).filter((v) => v.part === "2");
  t.check(
    pushed.length === 2 &&
      pushed.every((v) => Math.abs(v.yaw - VIEW.yawMax) < 1e-9 && Math.abs(v.pitch - VIEW.pitchMin) < 1e-9),
    "a shuffle past the edge of the knobs stops at the limit, not behind the tongue",
    `unclamped would be yaw ${(yawHi + push.yaw).toFixed(3)}, pitch ${(pitchLo + push.pitch).toFixed(3)} before the seat; ` +
      `aimed ${pushed.map((v) => `${v.yaw.toFixed(3)}/${v.pitch.toFixed(3)}`).join(", ")}`
  );

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

  t.section("7 — the tuning page");
  const tune = await t.browser.newPage({ viewport: { width: 1400, height: 800 } });
  const tuneErrors = [];
  tune.on("pageerror", (e) => tuneErrors.push(e.message));
  await tune.goto(`${t.base}/scan/tune.html`, { waitUntil: "load" });
  await tune.waitForFunction(() => window.tune && window.tune.text, null, { timeout: 20000 });
  await t.sleep(1500);
  const seen = await tune.evaluate(() => ({ build: window.tune.BUILD, ink: window.tune.ink(), text: window.tune.text, words: window.tune.words }));
  const stageBuild = await stage.evaluate(() => window.stage.BUILD);
  t.check(tuneErrors.length === 0, "it loads without an error", tuneErrors.join("; "));
  t.check(seen.build === stageBuild, "and is the same build as the stage", `${seen.build} against ${stageBuild}`);
  t.check(
    seen.ink.length === 9 && seen.ink.every((n) => n > 500),
    "all nine seats draw",
    `lit pixels ${seen.ink.join(", ")}`
  );
  /* untouched, what it would write is what is there: a write of an
     unchanged page moves nothing, whatever look.json holds today. Knobs the
     file predates come in at look.js's defaults, so those are the one thing
     allowed to differ. */
  const fs = require("fs");
  const file = (name) => JSON.parse(fs.readFileSync(require("path").join(t.ROOT, "scan", name), "utf8"));
  const onDisk = file("look.json");
  const ours = JSON.parse(seen.text);
  const lookSame = Object.keys(onDisk.look).every((k) => ours.look[k] === onDisk.look[k]);
  t.check(
    lookSame && JSON.stringify(ours.phrases) === JSON.stringify(onDisk.phrases),
    "it reads look.json back as it is on disk",
    `${Object.keys(onDisk.look).length} knobs, ${Object.keys(onDisk.phrases || {}).length} phrases`
  );
  const cues = file("cues.json").cues;
  const first = cues.find((c) => Number(c.phrase) === 1 && c.stage && c.stage.text);
  t.check(
    !!first && seen.words === first.stage.text,
    "and shows phrase 1's words from cues.json",
    `"${seen.words}"`
  );
});
