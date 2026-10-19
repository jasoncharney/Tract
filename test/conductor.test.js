/*
  The desk: names, the strip of playheads, what was last sent, and what is
  coming next.

  Most of this runs without starting the synth. A player's page reports its
  name, its phrase, its position and its words whether or not audio is
  running, and nine Chromium contexts with AudioWorklets is a test of the
  machine rather than of the piece — the first version of this suite died at
  the seventh player.
*/

const { suite } = require("./lib/harness");

suite("conductor", async (t) => {
  /* ---------------------------------------------------------------- *
   *  the name
   * ---------------------------------------------------------------- */
  t.section("1 — a player types their name once, on this laptop");
  const { page: first, context: firstCtx } = await t.freshPlayer();
  await first.waitForSelector("#partModal:not([hidden])", { timeout: 10000 });
  t.check(await first.isVisible("#nameInput"), "the part panel asks for a name");

  await first.fill("#nameInput", "  Ana  Ruiz ");
  await first.click(".partchoice >> nth=0");
  await first.waitForFunction(() => document.getElementById("partModal").hidden, null, { timeout: 5000 });
  const kept = await first.evaluate(() => ({
    memory: window.scan.name,
    stored: localStorage.getItem("tract.name"),
    chip: document.getElementById("nameChip").textContent,
  }));
  t.check(kept.memory === "Ana Ruiz", "it is tidied, not stored raw", `"${kept.memory}"`);
  t.check(kept.stored === "Ana Ruiz" && kept.chip === "Ana Ruiz", "written to this browser and shown in the header");

  await first.reload({ waitUntil: "load" });
  await first.waitForFunction(() => window.scan && window.scan.part, null, { timeout: 30000 });
  await first.waitForSelector("#partModal:not([hidden])", { timeout: 10000 });
  t.check((await first.inputValue("#nameInput")) === "Ana Ruiz", "a reload finds it again, already filled in");
  await first.click(".partchoice >> nth=0");
  await first.waitForFunction(() => document.getElementById("partModal").hidden, null, { timeout: 5000 });

  const stranger = await t.freshPlayer();
  await stranger.page.waitForSelector("#partModal:not([hidden])", { timeout: 10000 });
  t.check((await stranger.page.inputValue("#nameInput")) === "", "another laptop's box is its own, and empty");
  await stranger.context.close();

  // the header chip, and the hazard it was shaped around
  await first.click("#nameChip");
  await first.fill("#nameEdit", "Ana");
  await first.press("#nameEdit", "Enter");
  await t.sleep(200);
  const edited = await first.evaluate(() => ({
    chip: document.getElementById("nameChip").textContent,
    hidden: document.getElementById("nameEdit").hidden,
  }));
  t.check(edited.chip === "Ana" && edited.hidden, "the header chip edits it, then goes back to being a button");

  await first.click("#nameChip");
  await first.type("#nameEdit", "asd");
  const typing = await first.evaluate(() => ({
    value: document.getElementById("nameEdit").value,
    pressed: window.scan.pressed,
  }));
  t.check(typing.value.endsWith("asd") && !typing.pressed, "and typing in it does not play the piece");
  await first.press("#nameEdit", "Escape");
  await t.sleep(150);

  /* ---------------------------------------------------------------- *
   *  the rest of the ensemble
   * ---------------------------------------------------------------- */
  const players = [first];
  for (const [part, name] of [
    ["II", "Bo Hall"],
    ["III", "Cy Okafor"],
    ["IV", ""], // never typed one
  ]) {
    const page = await t.player({ part, seat: 1 });
    if (name) await page.evaluate((n) => (window.scan.name = n), name);
    players.push(page);
  }
  await players[0].evaluate(() => window.scan.enableAudio());
  await players[0].waitForFunction(() => window.scan.isReady(), null, { timeout: 30000 });

  const desk = await t.desk();
  await t.sleep(3200); // one heartbeat, so the desk's ping reaches the players

  /* ---------------------------------------------------------------- *
   *  the strips
   * ---------------------------------------------------------------- */
  t.section("2 — every laptop's playhead reaches the desk");
  for (let i = 0; i < players.length; i++) {
    await players[i].evaluate((pos) => {
      window.scan.applyRemote("/scan/phrase", [3]);
      window.scan.applyRemote("/scan/norm", [pos]);
    }, 0.1 + i * 0.25);
  }
  await players[0].evaluate(() => window.scan.applyRemote("/scan/gate", [1]));
  await players[1].evaluate(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true }));
  });
  await t.sleep(1200);

  const strips = await desk.evaluate(() => {
    const host = document.getElementById("strips");
    return {
      padded: parseFloat(getComputedStyle(document.body).paddingBottom),
      onScreen: host.getBoundingClientRect().bottom <= window.innerHeight + 1,
      rows: [...host.children].map((el) => {
        const bar = el.querySelector(".pstrip-bar").getBoundingClientRect();
        const cur = el.querySelector(".pstrip-cursor").getBoundingClientRect();
        return {
          name: el.querySelector(".pstrip-name").textContent,
          part: el.querySelector(".pstrip-part").textContent,
          phrase: el.querySelector(".pstrip-ph").textContent,
          ipa: el.querySelector(".pstrip-ipa").textContent,
          gate: el.dataset.gate,
          whisper: el.dataset.whisper,
          at: Math.round(((cur.left + cur.width / 2 - bar.left) / bar.width) * 100) / 100,
          colour: getComputedStyle(el.querySelector(".pstrip-cursor")).backgroundColor,
          words: [...el.querySelectorAll(".pstrip-word")].map((w) => w.textContent),
        };
      }),
    };
  });

  t.check(strips.rows.length === 4, "one strip per laptop", `${strips.rows.length}`);
  t.check(strips.onScreen && strips.padded > 100, "pinned to the bottom, and the page is padded so it covers nothing");
  t.check(
    strips.rows[0].name === "Ana" && strips.rows[1].name === "Bo Hall",
    "labelled with what each player typed",
    strips.rows.map((r) => r.name).join(", ")
  );
  t.check(strips.rows[3].name === "seat 1", "and a laptop with no name falls back to its seat", strips.rows[3].name);
  t.check(strips.rows.map((r) => r.part).join(",") === "I,II,III,IV", "in score order");

  const drift = strips.rows.map((r, i) => Math.abs(r.at - (0.1 + i * 0.25)));
  t.check(Math.max(...drift) < 0.06, "each cursor is drawn where that player is", `worst ${Math.max(...drift).toFixed(3)}`);
  t.check(
    strips.rows[0].gate === "1" && strips.rows[2].gate === "0",
    "gate open or shut travels",
    strips.rows.map((r) => r.gate).join("")
  );
  t.check(strips.rows[1].whisper === "1" && strips.rows[0].whisper === "0", "so does voiced against whispered");
  t.check(strips.rows[0].colour !== strips.rows[1].colour, "and the two are drawn differently");

  const said = await players[0].evaluate(() => document.getElementById("phraseText").textContent.trim().split(/\s+/));
  t.check(
    strips.rows[0].words.join(" ") === said.join(" "),
    "the words of the phrase are written along the strip",
    strips.rows[0].words.join(" ")
  );
  t.check(
    strips.rows.every((r) => r.words.length === said.length),
    "on every strip, not just the first"
  );

  // it has to follow them, not just be right once
  await players[0].evaluate(() => window.scan.applyRemote("/scan/norm", [0.85]));
  await t.sleep(700);
  const moved = await desk.evaluate(() => {
    const el = document.getElementById("strips").children[0];
    const bar = el.querySelector(".pstrip-bar").getBoundingClientRect();
    const cur = el.querySelector(".pstrip-cursor").getBoundingClientRect();
    return Math.round(((cur.left + cur.width / 2 - bar.left) / bar.width) * 100) / 100;
  });
  t.check(moved > 0.7, "and follows them when they move", `${strips.rows[0].at} → ${moved}`);

  await players[3].close();
  await t.sleep(5000);
  t.check(
    (await desk.evaluate(() => document.getElementById("strips").children.length)) === 3,
    "a laptop that leaves loses its strip"
  );

  /* ---------------------------------------------------------------- *
   *  what is coming, and what went out
   * ---------------------------------------------------------------- */
  t.section("3 — the next instruction arrives before the light does");
  await desk.evaluate(() => window.conduct.goTo(0));
  await t.sleep(500);
  const speaksToI = await desk.evaluate(() => window.conduct.speaksTo(0).some((r) => r.id === "1"));

  const beforePrep = await players[0].evaluate(() => ({
    next: document.getElementById("oncomingText").textContent,
    shown: !document.getElementById("oncoming").hidden,
    armed: document.getElementById("oncoming").dataset.armed,
    lamp: document.getElementById("cueLight").dataset.state,
  }));
  t.check(!speaksToI || beforePrep.shown, "the next instruction is on the page before any prep");
  t.check(beforePrep.lamp === "idle", "with the light still dark", beforePrep.lamp);
  t.check(beforePrep.armed === "0", "and marked as not yet armed");

  await desk.evaluate(() => window.conduct.prep());
  await t.sleep(400);
  const onPrep = await players[0].evaluate(() => ({
    next: document.getElementById("oncomingText").textContent,
    armed: document.getElementById("oncoming").dataset.armed,
    lamp: document.getElementById("cueLight").dataset.state,
  }));
  t.check(onPrep.lamp === "prep", "PREP lights the lamp amber", onPrep.lamp);
  t.check(onPrep.next === beforePrep.next, "and does not change a word of the text");
  t.check(onPrep.armed === "1", "the only visible change is that it is now armed");

  await desk.evaluate(() => window.conduct.go());
  await t.sleep(700);
  const afterGo = await players[0].evaluate(() => ({
    now: document.getElementById("instruction").textContent.trim(),
    next: document.getElementById("oncomingText").textContent,
    shown: !document.getElementById("oncoming").hidden,
    armed: document.getElementById("oncoming").dataset.armed,
  }));
  const nextSpeaks = await desk.evaluate(() => window.conduct.speaksTo(window.conduct.at).some((r) => r.id === "1"));
  t.check(afterGo.now.length > 0, "the downbeat swaps the standing instruction in");
  t.check(
    nextSpeaks ? afterGo.shown && afterGo.next !== beforePrep.next : !afterGo.shown,
    "and the FOLLOWING cue's text is already underneath it",
    nextSpeaks ? `"${afterGo.next.slice(0, 40)}…"` : "next cue says nothing to part I — line hidden"
  );
  t.check(afterGo.armed === "0", "with the light back down: the text is early, the light is not");

  t.section("4 — the desk keeps what it last sent");
  const sent = await desk.evaluate(() => ({
    shown: !document.getElementById("lastSent").hidden,
    num: document.getElementById("lastNum").textContent,
    ago: document.getElementById("lastAgo").textContent,
    rows: document.getElementById("lastGoes").children.length,
    stand: document.getElementById("cueNum").textContent,
  }));
  t.check(sent.shown, "the last cue sent stays on screen");
  t.check(sent.num !== sent.stand, "and is not the cue on the stand", `sent ${sent.num}, standing on ${sent.stand}`);
  t.check(sent.rows > 0 && /\d:\d\d/.test(sent.ago), "with its parts and how long ago", `${sent.rows} rows, ${sent.ago}`);

  t.section("5 — a laptop that joins late is told what is coming");
  const late = await t.player({ part: "I" });
  await t.sleep(3400); // one desk heartbeat
  const lateSees = await late.evaluate(() => ({
    now: document.getElementById("instruction").textContent.trim(),
    next: document.getElementById("oncomingText").textContent.trim(),
  }));
  t.check(lateSees.now.length > 0, "it picks up the standing instruction", `"${lateSees.now.slice(0, 40)}"`);
  t.check(!nextSpeaks || lateSees.next.length > 0, "and what is coming after it");
  await late.close();
  await firstCtx.close();
});
