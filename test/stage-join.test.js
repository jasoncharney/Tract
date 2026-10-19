/*
  ?IP — the join address instead of the title, and the network name with it.

  The second half of this file matters more than the first: without the flag
  NOTHING may differ, because the next time the stage is opened without it
  there is an audience in the room.
*/

const { suite } = require("./lib/harness");

const read = (page) =>
  page.evaluate(() => {
    const el = (id) => document.getElementById(id);
    const main = el("titleMain");
    const sub = el("titleSub");
    const cs = getComputedStyle(main);
    const ss = getComputedStyle(sub);
    const r = main.getBoundingClientRect();
    const sr = sub.getBoundingClientRect();
    return {
      main: main.textContent,
      sub: sub.textContent,
      subShown: sub.innerText, // what the CSS actually renders
      by: el("titleBy").textContent,
      join: el("titleCard").classList.contains("join"),
      hidden: el("titleCard").classList.contains("gone"),
      font: cs.fontFamily,
      transform: cs.textTransform,
      spacing: cs.letterSpacing,
      subTransform: ss.textTransform,
      subSize: Math.round(parseFloat(ss.fontSize)),
      subOverflow: Math.max(0, sub.scrollWidth - sub.clientWidth),
      left: Math.min(r.left, sr.left),
      right: Math.max(r.right, sr.right),
      viewport: window.innerWidth,
    };
  });

suite("stage join card", async (t) => {
  const look = async (query, viewport) => {
    const page = await t.stage({ query, viewport });
    await page
      .waitForFunction(() => document.getElementById("titleMain").textContent !== "…", null, { timeout: 10000 })
      .catch(() => {});
    await t.sleep(400);
    const out = await read(page);
    await page.close();
    return out;
  };

  t.section("1 — the bridge says where it is");
  const info = await (await fetch(`${t.base}/bridge-info`)).json();
  t.check(Array.isArray(info.addresses), "bridge-info carries a list of addresses", JSON.stringify(info.addresses));
  t.check(
    info.addresses.every((a) => /^https?:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(a)),
    "each one complete, with its scheme and port"
  );
  t.check(info.ok === true && info.write === true, "and what bridge-info already answered is unchanged");

  t.section("2 — no flag: the card is the piece");
  const plain = await t.stage();
  const asked = [];
  plain.on("request", (r) => {
    if (r.url().includes("bridge-info")) asked.push(r.url());
  });
  await t.sleep(600);
  const off = await read(plain);
  t.check(off.main === "Tract", "the title is the title", `"${off.main}"`);
  t.check(!off.join, "no rehearsal styling");
  t.check(off.transform === "uppercase", "still set as a title", off.transform);
  t.check(off.subTransform === "lowercase", "and the card still lowercases its own subtitle", off.subTransform);
  t.check(asked.length === 0, "the bridge is never asked anything", `${asked.length} request(s)`);
  await plain.close();

  const noFlagWifi = await look("?wifi=peabody");
  t.check(
    noFlagWifi.main === "Tract",
    "wifi= on its own does nothing without ?IP",
    `"${noFlagWifi.main}" / "${noFlagWifi.sub}"`
  );

  t.section("3 — ?IP puts the address up instead");
  for (const flag of ["?IP", "?ip", "?Ip"]) {
    const c = await look(flag);
    t.check(/^https?:\/\/\d+\.\d+\.\d+\.\d+:\d+$/.test(c.main), `${flag} shows a usable address`, `"${c.main}"`);
  }
  const on = await look("?IP");
  t.check(!/Tract/.test(on.main), "instead of the title, not beside it");
  t.check(on.join, "the card is restyled for reading an address");
  t.check(on.transform === "none", "not uppercased — an address is typed, not read aloud", on.transform);
  t.check(/mono|Courier|Consolas|Andale/i.test(on.font), "and monospaced", on.font.split(",")[0]);
  t.check(on.main.startsWith("http"), "it carries the scheme, which has to be typed", on.main.slice(0, 8));
  t.check(on.left >= -1 && on.right <= on.viewport + 1, "and fits across the screen");

  t.section("4 — the network name");
  t.check((await look("?IP")).sub === "wi-fi: hopkins", "?IP alone uses the usual network");
  t.check((await look("?IP?peabody")).sub === "wi-fi: peabody", "a second ? overrides it");
  t.check((await look("?IP?Fine%20Arts")).sub === "wi-fi: Fine Arts", "including one with a space in it");
  t.check((await look("?IP&wifi=Fine%20Arts")).sub === "wi-fi: Fine Arts", "?IP&wifi=... works too");
  t.check((await look("?IP?ignored&wifi=wins")).sub === "wi-fi: wins", "an explicit wifi= beats the shorthand");
  t.check((await look("?IP?")).sub === "wi-fi: hopkins", "a trailing ? with nothing after it falls back");

  const pinned = await look("?IP=192.168.1.42:8080?peabody");
  t.check(
    pinned.main === "http://192.168.1.42:8080" && pinned.sub === "wi-fi: peabody",
    "an address and a network can be pinned together",
    `"${pinned.main}" / "${pinned.sub}"`
  );

  const capital = await look("?IP?Hopkins");
  t.check(
    capital.subShown.includes("Hopkins"),
    "a capital survives — an SSID is case-sensitive and is being read to be typed",
    `renders "${capital.subShown}"`
  );
  t.check(capital.subTransform === "none", "because the join card stops lowercasing that line");

  t.section("5 — the longest things that can land here");
  for (const [label, addr, w, h] of [
    ["every octet and port digit, over https", "https://255.255.255.255:65535", 1600, 900],
    ["...on a 4:3 projector", "https://255.255.255.255:65535", 1024, 768],
    ["...on a 1280x720 beamer", "https://192.168.100.100:8080", 1280, 720],
  ]) {
    const c = await look(`?IP=${encodeURIComponent(addr)}`, { width: w, height: h });
    t.check(c.left >= -1 && c.right <= c.viewport + 1, `${label}: fits`, `${c.viewport}px screen`);
  }
  const longSsid = await look("?IP?Fine%20Arts%20Building%20Guest%20Network%20-%205GHz", { width: 1280, height: 720 });
  t.check(
    longSsid.subOverflow === 0 && longSsid.left >= -1 && longSsid.right <= longSsid.viewport + 1,
    "a very long SSID shrinks instead of running off",
    `${longSsid.subOverflow}px over at ${longSsid.subSize}px`
  );

  t.section("6 — a cue cannot take the address off the wall");
  const live = await t.stage({ query: "?IP" });
  await live.waitForFunction(() => document.getElementById("titleMain").textContent !== "…", null, { timeout: 10000 });
  const before = (await read(live)).main;
  await live.evaluate(() =>
    window.stage.take({
      address: "/stage/set",
      args: [JSON.stringify({ title: { main: "Tract", sub: "for SATB choir" }, fade: 0 })],
    })
  );
  await t.sleep(300);
  t.check((await read(live)).main === before, "a cue that rewrites the title leaves the address", `"${before}"`);

  await live.evaluate(() => window.stage.take({ address: "/stage/set", args: [JSON.stringify({ title: false, fade: 0 })] }));
  await t.sleep(300);
  t.check((await read(live)).hidden, "cue 1 still takes the card away");
  await live.evaluate(() => window.stage.take({ address: "/stage/set", args: [JSON.stringify({ title: true, fade: 0 })] }));
  await t.sleep(300);
  const back = await read(live);
  t.check(!back.hidden && back.main === before, "and the desk's title-card button brings it back");
  await live.close();

  t.section("7 — a bridge that cannot answer");
  const blind = await t.browser.newPage({ viewport: { width: 1600, height: 900 } });
  await blind.route("**/bridge-info", (route) => route.fulfill({ status: 404, body: "no" }));
  await blind.goto(`${t.base}/scan/stage.html?IP`, { waitUntil: "load" });
  await blind.waitForFunction(() => window.stage, null, { timeout: 20000 });
  await t.sleep(900);
  const b = await read(blind);
  t.check(b.main === "?" && /did not say/.test(b.sub), "says so rather than lying", `"${b.sub}"`);
  await blind.close();
});
