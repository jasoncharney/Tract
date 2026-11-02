/*
  "The score asks for whisper here" — shown, never enforced.

  Several cues tell players to flick whisper on and off by hand, so a page
  that corrected them would be fighting the piece. The only thing this feature
  may do is make a mismatch visible.

  The parts.json path is tested by intercepting that one request and serving a
  doctored copy, so the real score is never edited to make a test pass.
*/

const { suite } = require("./lib/harness");

/** a parts.json with whisper written into phrase 2 of part I */
async function serveParts(page, base, edit) {
  const real = await (await fetch(`${base}/scan/parts.json`)).json();
  edit(real);
  await page.route("**/scan/parts.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(real) })
  );
}

const pill = (page) =>
  page.evaluate(() => {
    const el = document.getElementById("whisperTag");
    const asked = el.querySelector(".asked");
    return {
      on: el.dataset.on,
      want: el.dataset.want,
      wrong: el.dataset.wrong,
      asked: asked.hidden ? null : asked.textContent,
      title: el.title,
    };
  });

const pressZ = (page) =>
  page.evaluate(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "z", code: "KeyZ", bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "z", code: "KeyZ", bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
  });

suite("whisper prescription", async (t) => {
  t.section("1 — with nothing written down, the page says nothing");
  const quiet = await t.player({ audio: true });
  let p = await pill(quiet);
  t.check(p.want === "" && p.wrong === "0", "no prescription, no state", JSON.stringify(p.want));
  t.check(p.asked === null, "and no chip on the pill");
  await pressZ(quiet);
  p = await pill(quiet);
  t.check(p.on === "1" && p.wrong === "0", "turning whisper on is still just whisper on");
  await pressZ(quiet);
  await quiet.close();

  t.section("2 — a cue that asks for it");
  const page = await t.player({ audio: true });
  const ask = (want) =>
    page.evaluate(async (w) => {
      window.scan.applyRemote("/cue/state", ["9", window.scan.part.id, "Press Z for whisper on.", w]);
      await new Promise((r) => setTimeout(r, 200));
    }, want);

  await ask("on");
  p = await pill(page);
  t.check(p.want === "on" && p.wrong === "1", "asked for on while off: the pill says so", `want ${p.want}, wrong ${p.wrong}`);
  t.check(p.asked === "should be on", "in words, not just a colour", `"${p.asked}"`);
  t.check(/Press Z/.test(p.title), "and the tooltip says what to do", p.title.slice(0, 48));

  const still = await page.evaluate(() => document.getElementById("whisperTag").dataset.on);
  t.check(still === "0", "but nothing has been changed for them — whisper is still off");

  await pressZ(page);
  p = await pill(page);
  t.check(p.on === "1" && p.wrong === "0", "once they press Z the warning clears");
  t.check(p.asked === "as written", "and it confirms quietly rather than going blank", `"${p.asked}"`);

  await ask("off");
  p = await pill(page);
  t.check(p.wrong === "1" && p.asked === "should be off", "a cue can ask for it off, too");
  await ask("");
  p = await pill(page);
  t.check(p.want === "" && p.asked === null, "and a cue that says nothing clears the prescription");
  await pressZ(page); // back to off
  await page.close();

  t.section("3 — a phrase that asks for it, from parts.json");
  const fromFile = await t.browser.newPage();
  await serveParts(fromFile, t.base, (doc) => {
    const one = doc.parts.find((x) => x.id === "1");
    one.phrases[1].whisper = "on"; // phrase 2
    one.phrases[2].whisper = "off"; // phrase 3
  });
  await fromFile.goto(`${t.base}/scan/?part=I&seat=1`, { waitUntil: "load" });
  await fromFile.waitForFunction(() => window.scan && window.scan.part, null, { timeout: 30000 });
  await fromFile.evaluate(() => window.scan.enableAudio());
  await fromFile.waitForFunction(() => window.scan.isReady(), null, { timeout: 30000 });

  await fromFile.evaluate(() => window.scan.applyRemote("/scan/phrase", [1]));
  await t.sleep(250);
  p = await pill(fromFile);
  t.check(p.want === "" && p.asked === null, "phrase 1 has nothing written, so nothing shows");

  await fromFile.evaluate(() => window.scan.applyRemote("/scan/phrase", [2]));
  await t.sleep(250);
  p = await pill(fromFile);
  t.check(p.want === "on" && p.wrong === "1", "phrase 2 asks for whisper on and it is not", `want ${p.want}`);

  await pressZ(fromFile);
  p = await pill(fromFile);
  t.check(p.wrong === "0", "pressing Z satisfies it");

  // whisper deliberately survives a phrase change, so the pill has to re-read
  await fromFile.evaluate(() => window.scan.applyRemote("/scan/phrase", [3]));
  await t.sleep(250);
  p = await pill(fromFile);
  t.check(
    p.on === "1" && p.want === "off" && p.wrong === "1",
    "and moving to a phrase that wants it off flags it, without turning it off",
    `on ${p.on}, want ${p.want}`
  );

  t.section("4 — the cue wins over the phrase");
  await fromFile.evaluate(async () => {
    // phrase 3's file entry says off; this cue says on
    window.scan.applyRemote("/cue/state", ["12", window.scan.part.id, "carry on", "on"]);
    await new Promise((r) => setTimeout(r, 200));
  });
  p = await pill(fromFile);
  t.check(
    p.want === "on" && p.wrong === "0",
    "a cue that is explicit overrides the phrase default",
    `want ${p.want}, whisper is ${p.on}`
  );
  await fromFile.close();
});
