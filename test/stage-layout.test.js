/*
  The wall: how it arranges whatever number of players turns up, and the
  strip it gives the subtitles.

  Swept across every count from 1 to 20 rather than checked at one number.
  The ring was first written against nine and placed nine perfectly while
  overlapping at three, four and five — the closest pair on a wide ellipse is
  not always the next one round, and two squares whose centres are `s` apart
  still overlap on the diagonal.
*/

const { suite } = require("./lib/harness");

/** a believable tract frame */
const FRAME = (phoneme = "ɑ") => {
  const d = [];
  for (let i = 0; i < 44; i++) d.push(1 + Math.sin(i / 5) * 0.6);
  return { d, lip: 39, a: 0.3, i: 0.9, v: 1, f: 120, p: phoneme };
};

suite("stage layout", async (t) => {
  const stage = await t.stage();

  t.section("1 — the arithmetic, 1 to 20 players, both layouts, two screen shapes");
  for (const [label, W, H] of [["16:9", 1600, 760], ["4:3", 1024, 768]]) {
    for (const mode of ["grid", "ring"]) {
      const bad = await stage.evaluate(
        ([m, w, h]) => {
          const out = [];
          for (let n = 1; n <= 20; n++) {
            const spots = m === "ring" ? window.stage.placeRing(n, w, h) : window.stage.placeGrid(n, w, h);
            const problems = [];
            if (spots.length !== n) problems.push(`placed ${spots.length} of ${n}`);
            spots.forEach((s, i) => {
              if (s.x < -1 || s.y < -1 || s.x + s.w > w + 1 || s.y + s.h > h + 1) problems.push(`#${i + 1} outside`);
              if (s.w < 40 || s.h < 40) problems.push(`#${i + 1} only ${Math.round(s.w)}px`);
            });
            outer: for (let i = 0; i < spots.length; i++) {
              for (let j = i + 1; j < spots.length; j++) {
                const a = spots[i];
                const b = spots[j];
                const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
                const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
                if (ox > 1 && oy > 1) {
                  problems.push(`#${i + 1} and #${j + 1} overlap`);
                  break outer;
                }
              }
            }
            if (problems.length) out.push({ n, problems: problems.slice(0, 2) });
          }
          return out;
        },
        [mode, W, H]
      );
      t.check(
        bad.length === 0,
        `${label} ${mode}: every count places cleanly`,
        bad.length ? JSON.stringify(bad.slice(0, 3)) : ""
      );
    }
  }

  const sizes = await stage.evaluate(() => {
    const out = {};
    [4, 8, 9, 12, 16].forEach((n) => {
      const g = window.stage.placeGrid(n, 1600, 760);
      const r = window.stage.placeRing(n, 1600, 760);
      out[n] = {
        grid: Math.round(Math.min(...g.map((s) => Math.min(s.w, s.h)))),
        ring: Math.round(r[0].w),
      };
    });
    return out;
  });
  t.note("smallest drawing on a 1600x760 wall:");
  Object.entries(sizes).forEach(([n, s]) => t.note(`  ${String(n).padStart(2)} players   grid ${s.grid}px   ring ${s.ring}px`));
  t.check(
    Object.values(sizes).every((s) => s.ring >= 80 && s.grid >= 80),
    "neither layout shrinks a drawing below something you can see"
  );

  t.section("2 — nine on the real wall, in both shapes");
  const fill = (n) =>
    stage.evaluate(
      async ([count, frame]) => {
        window.stage.take({
          address: "/stage/set",
          args: [JSON.stringify({ title: false, tracts: true, text: "and sometimes break under the burden", fade: 0 })],
        });
        for (let r = 0; r < 10; r++) {
          for (let i = 0; i < count; i++) {
            window.stage.take({
              address: "/tract/frame",
              args: [String((i % 4) + 1), `m${i}`, JSON.stringify(frame)],
            });
          }
          await new Promise((x) => setTimeout(x, 60));
        }
        await new Promise((x) => setTimeout(x, 250));
      },
      [n, FRAME()]
    );

  const measure = () =>
    stage.evaluate(() => {
      const wall = document.getElementById("wall");
      const wr = wall.getBoundingClientRect();
      const sub = document.getElementById("subtitle");
      const sr = sub.getBoundingClientRect();
      return {
        tiles: [...wall.querySelectorAll(".tile")].map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }),
        wall: { x: wr.left, y: wr.top, w: wr.width, h: wr.height },
        subTop: sr.top,
        subSize: parseFloat(getComputedStyle(sub).fontSize),
        subOverflow: Math.max(0, sub.scrollWidth - sub.clientWidth),
      };
    });

  await fill(9);
  for (const mode of ["grid", "ring"]) {
    await stage.evaluate((m) => window.stage.setLayout(m), mode);
    await t.sleep(400);
    const m = await measure();
    t.check(m.tiles.length === 9, `${mode}: nine tiles on the wall`, `${m.tiles.length}`);
    const outside = m.tiles.filter(
      (x) =>
        x.x < m.wall.x - 1 ||
        x.y < m.wall.y - 1 ||
        x.x + x.w > m.wall.x + m.wall.w + 1 ||
        x.y + x.h > m.wall.y + m.wall.h + 1
    );
    t.check(outside.length === 0, `${mode}: none hangs out of the wall`, `${outside.length} outside`);
    let clash = 0;
    for (let i = 0; i < m.tiles.length; i++) {
      for (let j = i + 1; j < m.tiles.length; j++) {
        const a = m.tiles[i];
        const b = m.tiles[j];
        if (
          Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 1 &&
          Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 1
        )
          clash++;
      }
    }
    t.check(clash === 0, `${mode}: none overlaps another`, `${clash} pairs`);
    t.check(
      Math.max(...m.tiles.map((x) => x.y + x.h)) <= m.subTop + 1,
      `${mode}: the drawings clear the subtitle`
    );
  }

  t.section("3 — the subtitle");
  const sub = await measure();
  t.check(sub.subSize >= 45, "big enough to read from the back of a room", `${sub.subSize.toFixed(0)}px on a 900px wall`);
  t.check(sub.subOverflow === 0, "the longest phrase fits", `${sub.subOverflow}px over`);
  const strip = await stage.evaluate(async () => {
    const wall = document.getElementById("wall");
    const withText = wall.getBoundingClientRect().height;
    window.stage.take({ address: "/stage/set", args: [JSON.stringify({ text: "", fade: 0 })] });
    await new Promise((r) => setTimeout(r, 400));
    return { withText, without: wall.getBoundingClientRect().height };
  });
  const cost = strip.without - strip.withText;
  t.check(
    cost >= strip.without * 0.1 && cost <= strip.without * 0.2,
    "and the strip it reserves matches the type — neither cropping nor wasting",
    `${Math.round(cost)}px of ${Math.round(strip.without)}px`
  );

  t.section("4 — who is on the wall");
  await fill(5);
  // Checked against what the stage believes rather than against the number
  // sent: a laptop stays known for GONE_AFTER (6s) past its last frame, so
  // "I just sent five" and "five are feeding it" are different claims. The
  // one worth testing is that the readout and the wall agree — the whole
  // point of it is answering "I have nine players and can only see eight".
  const who = await stage.evaluate(async () => {
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 150));
    const el = document.getElementById("who");
    const shown = !el.hidden;
    const text = el.textContent;
    const known = window.stage.players.length;
    const tiles = document.querySelectorAll(".tile").length;
    await new Promise((r) => setTimeout(r, 3000)); // longer than the 2.5s hush
    return { shown, text, known, tiles, afterHush: !document.getElementById("who").hidden };
  });
  const said = Number((who.text.match(/^(\d+) player/) || [])[1]);
  t.check(who.shown, "a nudge of the mouse brings up the count");
  t.check(
    said === who.known && said === who.tiles,
    "and it agrees with both the wall and the feed",
    `says ${said}, knows ${who.known}, draws ${who.tiles}`
  );
  t.check(!who.afterHush, "it goes away again, so it is never in a performance");
});
