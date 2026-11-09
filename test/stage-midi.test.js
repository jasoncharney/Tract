/*
  test/stage-midi.test.js — the wall, sequenced from a track.

  Why this exists: a simulation with eight tester windows and a stage looked
  like nothing had connected. Everything had. The drawings were built and
  updating the whole time, but #wall sits at opacity 0 behind the title card
  until a cue says "tracts": true, and the only thing that ever said it was
  the conductor's page — which a simulation does not have. So the first thing
  this checks is the symptom itself: players feeding a stage, and a wall you
  cannot see. Then it plays the stage track and checks you can.

  The waits are long on purpose. cues.json asks for a three-second fade and
  three seconds is three seconds; reading the opacity any sooner reads a
  number from the middle of a crossfade, which is how the first version of
  this test failed on working code.
*/

const { suite } = require("./lib/harness");

const STAGE_CH = 9;
const NOTE_FROM = 24;
const FADE = 3600; // past the longest fade in cues.json's opening cues

suite("the wall, sequenced from a MIDI track", async (t) => {
  const stage = await t.stage({ query: `?midich=${STAGE_CH}` });
  await stage.waitForFunction(() => window.stage.midi && window.stage.midi.cues.length > 0, null, { timeout: 20000 });

  const look = () =>
    stage.evaluate(() => ({
      tiles: document.querySelectorAll("#wall .tile").length,
      wall: Number(getComputedStyle(document.getElementById("wall")).opacity),
      card: Number(getComputedStyle(document.getElementById("titleCard")).opacity),
      title: document.getElementById("titleMain").textContent,
      words: document.getElementById("subtitle").textContent,
      wordsShown: !document.getElementById("subtitle").classList.contains("gone"),
    }));

  const note = (n, channel = STAGE_CH) =>
    stage.evaluate(
      ({ n, channel }) => window.stage.midi.feed([0x90 | (channel - 1), n, 100]),
      { n, channel }
    );

  t.section("1 — the page has read the cue sheet");
  const midi = await stage.evaluate(() => ({
    mode: window.stage.midi.mode,
    channel: window.stage.midi.channel,
    notes: window.stage.midi.cues.map((c) => c.note),
  }));
  t.check(midi.mode === true, "MIDI mode is on", `?midich=${STAGE_CH}`);
  t.check(midi.channel === STAGE_CH, "on the channel asked for", `channel ${midi.channel}`);
  t.check(midi.notes.length > 0, "the cues that carry a stage block have notes", `${midi.notes.length} of them`);
  t.check(midi.notes[0] === NOTE_FROM, "the first cue is note 24", `note ${midi.notes[0]}`);
  t.check(
    midi.notes.every((n, i) => i === 0 || n > midi.notes[i - 1]),
    "and they climb with the cue list",
    `notes ${midi.notes.join(", ")}`
  );

  t.section("2 — the symptom: players feeding a wall nobody can see");
  const players = [];
  for (const [part, seat, ch] of [["I", 1, 1], ["I", 2, 2], ["II", 1, 3]]) {
    players.push(await t.player({ part, seat, query: `&midich=${ch}`, audio: true }));
  }
  await t.sleep(4000);
  let s = await look();
  t.check(s.tiles === 3, "their drawings are built", `${s.tiles} tiles`);
  t.check(s.wall === 0, "and the wall is still dark", `opacity ${s.wall}`);
  t.check(s.card === 1, "behind the title card", `opacity ${s.card}`);

  t.section("3 — the track plays the opening");
  await note(NOTE_FROM); // cue 1: the title card away
  await t.sleep(FADE);
  s = await look();
  t.check(s.card === 0, "cue 1 takes the title card away", `card opacity ${s.card}`);

  await note(NOTE_FROM + 1); // cue 2: the wall up, with the first words
  await t.sleep(FADE);
  s = await look();
  t.check(s.wall === 1, "cue 2 lights the wall", `wall opacity ${s.wall}`);
  t.check(s.tiles === 3, "with the drawings that were there all along", `${s.tiles} tiles`);
  t.check(s.wordsShown && s.words.length > 0, "and the words underneath", `"${s.words}"`);

  t.section("4 — a later cue, and the wall stays up through it");
  const later = await stage.evaluate(() => {
    const c = window.stage.midi.cues[3];
    return { note: c.note, text: c.block.text };
  });
  await note(later.note);
  await t.sleep(FADE);
  s = await look();
  t.check(s.words === later.text, "the subtitle follows the track", `"${s.words}"`);
  t.check(s.wall === 1, "and the wall is still lit", `opacity ${s.wall}`);

  t.section("5 — other channels belong to the players");
  const before = (await look()).words;
  await note(NOTE_FROM, 3);
  await t.sleep(800);
  s = await look();
  t.check(s.words === before, "a note on a player's channel is ignored", `still "${s.words}"`);

  t.section("6 — the host presses stop, and the wall stays where it is");
  // Stop used to put the title card back, which took the whole wall down
  // every time the transport stopped to talk to the room, with nothing to
  // bring it back until the next stage cue. Stop is not "go home".
  const lit = await look();
  await stage.evaluate(() => window.stage.midi.feed([0xfc]));
  await t.sleep(1500);
  s = await look();
  t.check(s.wall === 1, "stop leaves the wall lit", `opacity ${s.wall}`);
  t.check(s.card === 0, "and the title card down", `card opacity ${s.card}`);
  t.check(s.words === lit.words, "and the words where they were", `"${s.words}"`);

  t.section("7 — continue is not a reset either");
  await stage.evaluate(() => window.stage.midi.feed([0xfb]));
  await t.sleep(1000);
  s = await look();
  t.check(s.wall === 1, "continue changes nothing", `opacity ${s.wall}`);

  t.section("8 — refreshing the page picks up where the wall was");
  // A cue's block is a change, not a picture — cue 8 is only its text — so a
  // reloaded page has to restore the accumulated state, the way the
  // conductor's heartbeat does for a projector that reloads mid-run.
  const standing = await stage.evaluate(() => window.stage.midi.standing);
  t.check(standing.tracts === true, "the page is holding a standing state", JSON.stringify(standing));
  await stage.reload({ waitUntil: "load" });
  await stage.waitForFunction(() => window.stage && window.stage.midi, null, { timeout: 20000 });
  await t.sleep(3000);
  s = await look();
  t.check(s.wall === 1, "after a refresh the wall is still lit", `opacity ${s.wall}`);
  t.check(s.card === 0, "the title card is still down", `card opacity ${s.card}`);
  t.check(s.words === lit.words, "the words are still there", `"${s.words}"`);
  t.check(s.tiles === 3, "and the players are drawn again", `${s.tiles} tiles`);

  t.section("9 — start, and only start, goes back to the top");
  await stage.evaluate(() => window.stage.midi.feed([0xfa]));
  await t.sleep(1200);
  s = await look();
  t.check(s.card === 1, "start puts the title card back", `card opacity ${s.card}`);
  t.check(s.wall === 0, "and takes the wall down", `wall opacity ${s.wall}`);
  t.check(s.title === "Tract", "with the title the markup carries", `"${s.title}"`);

  t.section("10 — a performance is untouched by any of it");
  const plain = await t.stage();
  const off = await plain.evaluate(() => window.stage.midi.mode);
  t.check(off === false, "no MIDI mode without the flag", `mode ${off}`);
});
