/*
  A Standard MIDI File reader, written from the spec rather than from
  midi/make-midi.js, so a misunderstanding the two shared could not pass.
*/

/** a Standard MIDI File reader, from the spec */
function parseSMF(buf) {
  let p = 0;
  const tag = () => buf.toString("ascii", p, (p += 4));
  const u32 = () => ((buf[p++] << 24) | (buf[p++] << 16) | (buf[p++] << 8) | buf[p++]) >>> 0;
  const u16 = () => (buf[p++] << 8) | buf[p++];
  if (tag() !== "MThd") throw new Error("not a MIDI file");
  const headerLen = u32();
  const format = u16();
  const ntracks = u16();
  const division = u16();
  p += headerLen - 6;

  const tracks = [];
  let tempo = 500000;
  for (let i = 0; i < ntracks; i++) {
    if (tag() !== "MTrk") throw new Error(`track ${i} is not an MTrk`);
    const len = u32();
    const end = p + len;
    let tick = 0;
    let running = null;
    const events = [];
    const markers = [];
    let name = "";
    while (p < end) {
      let delta = 0;
      for (;;) {
        const b = buf[p++];
        delta = (delta << 7) | (b & 0x7f);
        if (!(b & 0x80)) break;
      }
      tick += delta;
      let status = buf[p];
      if (status & 0x80) p++;
      else status = running;
      if (status === undefined) throw new Error("running status with no status");
      if (status === 0xff) {
        const type = buf[p++];
        let n = 0;
        for (;;) {
          const b = buf[p++];
          n = (n << 7) | (b & 0x7f);
          if (!(b & 0x80)) break;
        }
        const data = buf.slice(p, p + n);
        p += n;
        if (type === 0x51) tempo = (data[0] << 16) | (data[1] << 8) | data[2];
        if (type === 0x03) name = data.toString("utf8");
        if (type === 0x06) markers.push({ tick, text: data.toString("utf8") });
        running = null;
        continue;
      }
      running = status;
      const kind = status & 0xf0;
      const channel = (status & 0x0f) + 1;
      if (kind === 0xc0 || kind === 0xd0) {
        p += 1;
        continue;
      }
      const d1 = buf[p++];
      const d2 = buf[p++];
      events.push({ tick, kind, channel, d1, d2 });
    }
    if (p !== end) throw new Error(`track ${i} overran its declared length by ${p - end}`);
    tracks.push({ name, events, markers });
  }
  if (p !== buf.length) throw new Error("trailing bytes after the last track");
  return { format, ntracks, division, tempo, tracks };
}

module.exports = { parseSMF };
