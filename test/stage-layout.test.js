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
        sub: { x: sr.left, y: sr.top, w: sr.width, h: sr.height },
        subs: getComputedStyle(document.documentElement).getPropertyValue("--subs").trim(),
        tiles: [...wall.querySelectorAll(".tile")].map((el) => {
          const r = el.getBoundingClientRect();
          return { x: r.left, y: r.top, w: r.width, h: r.height };
        }),
        wall: { x: wr.left, y: wr.top, w: wr.width, h: wr.height },
        subTop: sr.top,
        subSize: parseFloat(getComputedStyle(sub).fontSize),
        subOverflow: Math.max(0, sub.scrollWidth - sub.clientWidth, sub.scrollHeight - sub.clientHeight),
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
    if (mode === "grid") {
      t.check(
        Math.max(...m.tiles.map((x) => x.y + x.h)) <= m.subTop + 1,
        `${mode}: the drawings clear the subtitle`,
        `lowest tile ends at ${Math.round(Math.max(...m.tiles.map((x) => x.y + x.h)))}px, words at ${Math.round(m.subTop)}px`
      );
      continue;
    }
    // a ring keeps its words in its own middle, and needs no strip for them
    const s = m.sub;
    const onTile = m.tiles.filter(
      (x) => Math.min(x.x + x.w, s.x + s.w) - Math.max(x.x, s.x) > 1 && Math.min(x.y + x.h, s.y + s.h) - Math.max(x.y, s.y) > 1
    ).length;
    const mid = { x: s.x + s.w / 2 - (m.wall.x + m.wall.w / 2), y: s.y + s.h / 2 - (m.wall.y + m.wall.h / 2) };
    t.check(onTile === 0 && s.w > 0, "ring: the words sit in the hole, on no tile", `${Math.round(s.w)}x${Math.round(s.h)} box, ${onTile} tiles touched`);
    t.check(Math.hypot(mid.x, mid.y) < 2, "ring: in the middle of it", `${mid.x.toFixed(1)}, ${mid.y.toFixed(1)}px off centre`);
    t.check(m.subs === "0px", "ring: and the wall keeps its full height", `--subs ${m.subs}`);
    t.check(m.subOverflow === 0 && m.subSize >= 30, "ring: the longest phrase fits the hole, still readable", `${m.subSize}px type, ${m.subOverflow}px over`);
  }

  t.section("3 — the subtitle");
  await stage.evaluate(() => window.stage.setLayout("grid"));
  await t.sleep(400);
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

  t.section("3b — phrase 3 breaks where it is written to, and only there");
  // the text as the cue sheet has it, not a copy: the break lives in cues.json
  const written = require("../scan/cues.json").cues.find((c) => c.stage && /burden/.test(c.stage.text || "")).stage.text;
  t.check(written.includes("\n"), "the cue writes its break", JSON.stringify(written));
  await fill(9);
  for (const [w, h] of [[1600, 900], [1024, 768]]) {
    await stage.setViewportSize({ width: w, height: h });
    for (const mode of ["grid", "ring"]) {
      const lines = await stage.evaluate(
        async ([m, text]) => {
          window.stage.setLayout(m);
          window.stage.take({ address: "/stage/set", args: [JSON.stringify({ text: "", fade: 0 })] });
          await new Promise((r) => setTimeout(r, 300));
          window.stage.take({ address: "/stage/set", args: [JSON.stringify({ text, fade: 0 })] });
          await new Promise((r) => setTimeout(r, 700));
          // which rendered line each word landed on, by its top edge
          const el = document.getElementById("subtitle");
          const node = el.firstChild;
          const tops = [];
          const re = /\S+/g;
          let match;
          while ((match = re.exec(node.textContent))) {
            const range = document.createRange();
            range.setStart(node, match.index);
            range.setEnd(node, match.index + match[0].length);
            tops.push([match[0], Math.round(range.getBoundingClientRect().top)]);
          }
          const rows = [];
          tops.forEach(([word, top]) => {
            const row = rows.find((r) => Math.abs(r.top - top) < 4);
            if (row) row.words.push(word);
            else rows.push({ top, words: [word] });
          });
          return {
            rows: rows.sort((a, b) => a.top - b.top).map((r) => r.words.join(" ")),
            over: Math.max(0, el.scrollWidth - el.clientWidth),
            size: parseFloat(getComputedStyle(el).fontSize),
          };
        },
        [mode, written]
      );
      t.check(
        lines.rows.join(" / ") === "and sometimes break / under the burden" && lines.over === 0,
        `${w}x${h} ${mode}: two lines, broken after "break"`,
        `${lines.rows.join(" / ")} at ${lines.size}px, ${lines.over}px over`
      );
    }
  }
  await stage.setViewportSize({ width: 1600, height: 900 });

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
