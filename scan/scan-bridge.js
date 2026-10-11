#!/usr/bin/env node
/*
  scan-bridge.js — one small process, no dependencies.

    * serves the repo over HTTP            (the page needs absolute paths like
                                            /src/utils.js and the worklet URL)
    * a minimal WebSocket server on the    (the page connects back to it)
      same port
    * UDP in  on 7400: OSC in              -> forwarded to the page
    * UDP out on 7401: OSC out             <- cell + gesture feedback
                                              (QLab, Max, anything that speaks
                                               OSC — the piece needs none of it)

  usage:
      node scan/scan-bridge.js [--port 8080] [--udp-in 7400]
                               [--udp-out 7401] [--out-host 127.0.0.1]
                               [--root <repo root>] [--host 0.0.0.0]

  then open   http://localhost:8080                  (a player)
              http://localhost:8080/conduct.html      (the conductor)
              http://localhost:8080/stage.html        (the projection)
*/

const http = require("http");
const https = require("https");
const dgram = require("dgram");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const path = require("path");

/* ---------------------------------------------------------------- *
 *  args
 * ---------------------------------------------------------------- */

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const PORT = Number(arg("port", 8080));
const UDP_IN = Number(arg("udp-in", 7400));
const UDP_OUT = Number(arg("udp-out", 7401));
const OUT_HOST = arg("out-host", "127.0.0.1");
// the repo root, not scan/ — the page asks for absolute paths like /src/utils.js
// and /pink-trombone/src/…, which live beside scan/ rather than inside it
const ROOT = path.resolve(arg("root", path.join(__dirname, "..")));
// every interface by default, so the other laptops in the room can reach it;
// --host 127.0.0.1 keeps it to this machine
const HOST = arg("host", "0.0.0.0");
// TLS, which is not about secrecy here: browsers only hand out AudioWorklet in
// a secure context, and over plain http on a LAN address there isn't one — so
// the synth falls back to a main-thread ScriptProcessorNode. A self-signed
// certificate is enough to get the good path. See make-cert.sh.
/** every address the other laptops in the room could reach this machine by */
function localIPs() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push(net.address);
    }
  }
  return out;
}

/** the IP addresses a certificate already vouches for */
function certIPs(certPath) {
  try {
    const text = execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-text"], {
      encoding: "utf8",
      timeout: 10000,
    });
    return (text.match(/IP Address:([0-9.]+)/g) || []).map((m) => m.split(":")[1]);
  } catch (e) {
    return null; // no openssl, or not a certificate we can read
  }
}

function certExpired(certPath) {
  try {
    // -checkend 0 exits non-zero when it has already expired
    execFileSync("openssl", ["x509", "-in", certPath, "-noout", "-checkend", "0"], {
      timeout: 10000,
      stdio: "ignore",
    });
    return false;
  } catch (e) {
    return true;
  }
}

/**
 * Write a certificate covering this machine as it is right now.
 *
 * The room decides the addresses, and it decides them on the day. A browser
 * checks that the certificate names the exact address it dialled, so a
 * certificate made at home is wrong at the venue — which is a thing to discover
 * before a rehearsal rather than during one. So the bridge makes its own, and
 * makes a new one whenever the addresses have moved.
 */
function writeCert(certPath, keyPath, ips) {
  const san = ["DNS:localhost", "IP:127.0.0.1"].concat(ips.map((ip) => `IP:${ip}`)).join(",");
  const cfgPath = path.join(os.tmpdir(), `tract-cert-${process.pid}.cnf`);
  fs.writeFileSync(
    cfgPath,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = ext",
      "prompt = no",
      "[dn]",
      "CN = Tract",
      "[ext]",
      `subjectAltName = ${san}`,
      "basicConstraints = CA:FALSE",
      "keyUsage = digitalSignature, keyEncipherment",
      "extendedKeyUsage = serverAuth",
      "",
    ].join("\n")
  );
  try {
    execFileSync(
      "openssl",
      ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "60",
       "-keyout", keyPath, "-out", certPath, "-config", cfgPath],
      { timeout: 60000, stdio: "ignore" }
    );
    fs.chmodSync(keyPath, 0o600);
    return san;
  } finally {
    try {
      fs.unlinkSync(cfgPath);
    } catch (e) {
      /* it was a temp file */
    }
  }
}

function findTLS() {
  if (argv.includes("--no-tls")) return null;
  const named = arg("cert", null) && arg("key", null);
  const certPath = arg("cert", path.join(__dirname, "tract-cert.pem"));
  const keyPath = arg("key", path.join(__dirname, "tract-key.pem"));
  const ips = localIPs();

  // A certificate named on the command line is used exactly as given — if you
  // said which one, you meant it.
  if (!named) {
    const have = fs.existsSync(certPath) && fs.existsSync(keyPath);
    let why = null;
    if (!have) why = "none here yet";
    else if (certExpired(certPath)) why = "the one here has expired";
    else {
      const covered = certIPs(certPath);
      if (covered === null) why = null; // cannot inspect it; trust it
      else {
        const missing = ips.filter((ip) => !covered.includes(ip));
        if (missing.length) why = `this machine is now ${missing.join(", ")}`;
      }
    }
    if (why) {
      try {
        const san = writeCert(certPath, keyPath, ips);
        console.log(`[scan-bridge] made a certificate — ${why}`);
        console.log(`[scan-bridge] covering ${san}`);
      } catch (e) {
        console.log(`[scan-bridge] could not make a certificate (${e.message.split("\n")[0]})`);
        console.log("[scan-bridge] carrying on over plain http");
        return null;
      }
    }
  }

  try {
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;
    return {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
      where: path.basename(certPath),
    };
  } catch (e) {
    console.log(`[scan-bridge] found a certificate but could not read it — ${e.message}`);
    return null;
  }
}

const TLS = findTLS();
const SCHEME = TLS ? "https" : "http";

/* ---------------------------------------------------------------- *
 *  OSC (just enough of it)
 * ---------------------------------------------------------------- */

function padded(n) {
  return n + (4 - (n % 4 || 4));
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  const value = buf.toString("utf8", offset, end);
  return [value, offset + padded(end - offset)];
}

function decodeMessage(buf) {
  let offset = 0;
  let address;
  [address, offset] = readString(buf, 0);
  const args = [];
  if (offset < buf.length && buf[offset] === 0x2c /* , */) {
    let tags;
    [tags, offset] = readString(buf, offset);
    for (const tag of tags.slice(1)) {
      switch (tag) {
        case "i":
          args.push(buf.readInt32BE(offset));
          offset += 4;
          break;
        case "f":
          args.push(buf.readFloatBE(offset));
          offset += 4;
          break;
        case "d":
          args.push(buf.readDoubleBE(offset));
          offset += 8;
          break;
        case "h":
          args.push(Number(buf.readBigInt64BE(offset)));
          offset += 8;
          break;
        case "s":
        case "S": {
          let value;
          [value, offset] = readString(buf, offset);
          args.push(value);
          break;
        }
        case "b": {
          const size = buf.readInt32BE(offset);
          offset += 4;
          args.push(buf.slice(offset, offset + size));
          offset += Math.ceil(size / 4) * 4;
          break;
        }
        case "T":
          args.push(1);
          break;
        case "F":
          args.push(0);
          break;
        case "N":
          args.push(null);
          break;
        case "I":
          args.push(Infinity);
          break;
        default:
          break;
      }
    }
  }
  return { address, args };
}

function decodeOSC(buf) {
  if (buf.length >= 8 && buf.toString("utf8", 0, 7) === "#bundle") {
    const out = [];
    let offset = 16;
    while (offset + 4 <= buf.length) {
      const size = buf.readInt32BE(offset);
      offset += 4;
      if (size <= 0 || offset + size > buf.length) break;
      out.push(...decodeOSC(buf.slice(offset, offset + size)));
      offset += size;
    }
    return out;
  }
  if (buf[0] !== 0x2f /* / */) return [];
  try {
    return [decodeMessage(buf)];
  } catch (e) {
    return [];
  }
}

function oscString(value) {
  const raw = Buffer.from(String(value), "utf8");
  const out = Buffer.alloc(padded(raw.length));
  raw.copy(out);
  return out;
}

function encodeOSC(address, args = []) {
  const parts = [oscString(address)];
  let tags = ",";
  const body = [];
  for (const value of args) {
    if (typeof value === "number") {
      if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) {
        tags += "i";
        const b = Buffer.alloc(4);
        b.writeInt32BE(value);
        body.push(b);
      } else {
        tags += "f";
        const b = Buffer.alloc(4);
        b.writeFloatBE(value);
        body.push(b);
      }
    } else {
      tags += "s";
      body.push(oscString(value));
    }
  }
  parts.push(oscString(tags));
  return Buffer.concat([...parts, ...body]);
}

/* ---------------------------------------------------------------- *
 *  static files
 * ---------------------------------------------------------------- */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/* The composer's save buttons POST here, so "save" writes the real file in the
 * repo instead of dropping a copy in ~/Downloads to be moved by hand. Only the
 * two data files, only from this machine, and only JSON: the bridge is a
 * development tool and should not become a way to write anything anywhere. */
const WRITABLE = new Set(["/scan/presets.json", "/scan/parts.json", "/scan/cues.json"]);

function handleWrite(request, response, url) {
  const local =
    request.socket.remoteAddress === "127.0.0.1" ||
    request.socket.remoteAddress === "::1" ||
    request.socket.remoteAddress === "::ffff:127.0.0.1";
  if (!local) {
    response.writeHead(403, { "content-type": "text/plain" }).end("local writes only");
    return;
  }
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
    if (body.length > 4e6) request.destroy();
  });
  request.on("end", () => {
    try {
      JSON.parse(body); // never write something the page cannot read back
    } catch (e) {
      response.writeHead(400, { "content-type": "text/plain" }).end("not JSON");
      return;
    }
    const target = path.join(ROOT, url.slice(1));
    fs.writeFile(target, body.endsWith("\n") ? body : body + "\n", (error) => {
      if (error) {
        response.writeHead(500, { "content-type": "text/plain" }).end(String(error.message));
        log(`write ${url} failed: ${error.message}`);
        return;
      }
      log(`wrote ${path.relative(ROOT, target)} (${body.length} bytes)`);
      response
        .writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ ok: true, path: path.relative(ROOT, target) }));
    });
  });
}

/* What a player should have to type is the address and nothing else. The bare
 * address is the player's page; only the conductor types anything after the
 * slash. The query string is carried across, so `address:8080?part=2` still
 * lands on part 2. */
const SHORTCUTS = {
  "/": "/scan/",
  "/scan": "/scan/",
  "/conduct": "/scan/conduct.html",
  "/conduct.html": "/scan/conduct.html",
  "/stage": "/scan/stage.html",
  "/stage.html": "/scan/stage.html",
};

const server = (TLS ? https.createServer.bind(null, TLS) : http.createServer)((request, response) => {
  const url = decodeURIComponent((request.url || "/").split("?")[0]);
  if (SHORTCUTS[url]) {
    const query = (request.url || "").slice(url.length);
    response
      .writeHead(302, { location: SHORTCUTS[url] + (query.startsWith("?") ? query : "") })
      .end();
    return;
  }
  // how the page knows this bridge can write the data files: an older build
  // simply 404s here, and the page then treats its own copies as the document
  if (url === "/bridge-info") {
    response
      .writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify({ ok: true, write: true, writable: [...WRITABLE] }));
    return;
  }
  if (request.method === "PUT" || request.method === "POST") {
    if (WRITABLE.has(url)) {
      handleWrite(request, response, url);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" }).end("not writable");
    return;
  }
  let filePath = path.join(ROOT, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  fs.stat(filePath, (error, stats) => {
    if (!error && stats.isDirectory()) filePath = path.join(filePath, "index.html");
    fs.readFile(filePath, (readError, data) => {
      if (readError) {
        response.writeHead(404, { "content-type": "text/plain" }).end("not found");
        return;
      }
      response.writeHead(200, {
        "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
        // no-store, not no-cache: a browser quietly re-running yesterday's
        // scan.js is an hour of debugging every time it happens
        "cache-control": "no-store, max-age=0",
      });
      response.end(data);
    });
  });
});

/* ---------------------------------------------------------------- *
 *  minimal WebSocket server (RFC 6455, text frames only)
 * ---------------------------------------------------------------- */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const clients = new Set();

server.on("upgrade", (request, socket) => {
  const key = request.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }
  const accept = crypto
    .createHash("sha1")
    .update(key + GUID)
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );
  socket.setNoDelay(true);
  clients.add(socket);
  // What kind of page this is only becomes knowable once it says something.
  // A player's first hello goes out before the page has finished choosing its
  // part, so wait a beat and announce what it settled on: one line per page,
  // with the right part on it, instead of "page connected" followed by two
  // corrections.
  const timer = setTimeout(() => announce(socket), SETTLE);
  if (timer.unref) timer.unref();
  pending.set(socket, timer);

  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const frame = decodeFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.size);
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        socket.write(encodeFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode === 0x1) onPageMessage(frame.payload.toString("utf8"), socket);
    }
  });
  const drop = () => {
    if (!clients.delete(socket)) return; // close and error both fire; report once
    clearTimeout(pending.get(socket));
    pending.delete(socket);
    const seen = who.get(socket);
    who.delete(socket);
    // a page that came and went inside the settle window was never announced,
    // so saying it left would be the only thing ever said about it
    if (seen && seen.announced) log(`${seen.label} disconnected — ${tally()}`);
  };
  socket.on("close", drop);
  socket.on("error", drop);
});

function decodeFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = (second & 0x80) === 0x80;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + length));
  if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
  return { opcode, payload, size: offset + length };
}

function encodeFrame(payload, opcode = 0x1) {
  const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), "utf8");
  const length = data.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, data]);
}

function broadcast(object, except = null) {
  const frame = encodeFrame(JSON.stringify(object));
  for (const socket of clients) {
    if (socket !== except && socket.writable) socket.write(frame);
  }
}

/* ---------------------------------------------------------------- *
 *  UDP
 * ---------------------------------------------------------------- */

const udpIn = dgram.createSocket("udp4");
const udpOut = dgram.createSocket("udp4");

udpIn.on("message", (message) => {
  // OSC, or a raw JSON object for anyone who prefers that
  if (message[0] === 0x7b /* { */) {
    try {
      broadcast(JSON.parse(message.toString("utf8")));
    } catch (e) {
      /* ignore */
    }
    return;
  }
  const decoded = decodeOSC(message);
  if (decoded.length === 0) return;
  if (VERBOSE) decoded.forEach((m) => log(`in  ${m.address} ${m.args.join(" ")}`));
  broadcast(decoded.length === 1 ? decoded[0] : decoded);
});

/* Addresses that one page sends to the others: the conductor cueing the
 * players, and the players saying who they are. Everything else a page sends is
 * feedback meant for Max, and relaying it would echo one page's state onto the
 * rest. */
const RELAYED = /^\/(cue|player|conductor|stage|tract)\//;
/* The projection feed is a stream of tract geometry between pages — forty-four
 * numbers, twenty times a second, per player. It belongs on the WebSocket and
 * nowhere near Max's UDP port. */
const PAGES_ONLY = /^\/tract\//;

/* ---------------------------------------------------------------- *
 *  who is on the other end
 *
 *  Nothing in the handshake says whether a socket is a player, the conductor
 *  or the stage — but what each one sends does, unambiguously, and all three
 *  start sending at once:
 *
 *    player      /player/hello, /scan/out/…, /tract/…
 *    conductor   /cue/…
 *    stage       /stage/hello
 *
 *  A player's hello carries its part, so the log can name it: "player III".
 * ---------------------------------------------------------------- */

const who = new Map(); // socket -> { kind, label, announced }
const pending = new Map(); // socket -> the settle timer
const SETTLE = 1500; // ms to let a page finish saying which part it is

function nameOf(address, args) {
  if (address === "/player/hello") {
    const part = args && args[1];
    return { kind: "player", label: part ? `player ${part}` : "player" };
  }
  if (address.startsWith("/stage/")) return { kind: "stage", label: "stage" };
  if (address.startsWith("/cue/")) return { kind: "conductor", label: "conductor" };
  if (address.startsWith("/scan/out/") || address.startsWith("/tract/")) {
    return { kind: "player", label: "player" };
  }
  return null;
}

/** "2 players, 1 conductor, 1 stage" — what is in the room right now */
function tally() {
  const counts = { player: 0, conductor: 0, stage: 0, unknown: 0 };
  who.forEach((entry) => (counts[entry.kind] += 1));
  counts.unknown += clients.size - who.size; // connected, still settling
  const parts = [];
  const say = (n, one, many) => n && parts.push(`${n} ${n === 1 ? one : many}`);
  say(counts.player, "player", "players");
  say(counts.conductor, "conductor", "conductors");
  say(counts.stage, "stage", "stages");
  say(counts.unknown, "unidentified page", "unidentified pages");
  return parts.length ? parts.join(", ") : "nobody left";
}

/** the settle window is up: say what this page turned out to be */
function announce(socket) {
  pending.delete(socket);
  if (!clients.has(socket)) return;
  let seen = who.get(socket);
  if (!seen) {
    seen = { kind: "unknown", label: "something that will not say what it is" };
    who.set(socket, seen);
  }
  seen.announced = true;
  log(`${seen.label} connected — ${tally()}`);
}

function identify(socket, address, args) {
  const found = nameOf(address, args);
  if (!found) return;
  const known = who.get(socket);
  if (!known) {
    who.set(socket, { kind: found.kind, label: found.label, announced: false });
    return;
  }
  if (found.label === known.label) return;
  // /tract/ and /scan/out/ only say "a player"; never trade a known part for that
  if (found.label === "player" && known.kind === "player") return;
  const was = known.label;
  known.kind = found.kind;
  known.label = found.label;
  // before the announcement this is just the page settling; after it, it is news
  if (known.announced) log(`${was} is now ${found.label} — ${tally()}`);
}

function onPageMessage(text, from) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (e) {
    return;
  }
  const list = Array.isArray(message) ? message : [message];
  const relay = [];
  for (const item of list) {
    if (!item || !item.address) continue;
    identify(from, item.address, item.args);
    if (RELAYED.test(item.address)) relay.push(item);
    if (PAGES_ONLY.test(item.address)) continue;
    const packet = encodeOSC(item.address, item.args || []);
    udpOut.send(packet, UDP_OUT, OUT_HOST);
    if (VERBOSE) log(`out ${item.address} ${(item.args || []).join(" ")}`);
  }
  // to every other page, never back to the sender
  if (relay.length) broadcast(relay.length === 1 ? relay[0] : relay, from);
}

/* ---------------------------------------------------------------- *
 *  go
 * ---------------------------------------------------------------- */

const VERBOSE = argv.includes("--verbose") || argv.includes("-v");
function log(...args) {
  console.log("[scan-bridge]", ...args);
}

udpIn.bind(UDP_IN, () => log(`OSC in   udp ${UDP_IN}`));
server.listen(PORT, HOST, () => {
  log(`serving  ${ROOT}`);
  log(`OSC out  udp ${OUT_HOST}:${UDP_OUT}`);
  log(`players  ${SCHEME}://localhost:${PORT}/`);
  log(`conduct  ${SCHEME}://localhost:${PORT}/conduct.html`);
  log(`stage    ${SCHEME}://localhost:${PORT}/stage.html`);
  if (TLS) {
    log(`using ${TLS.where} — players click through the warning once`);
  } else {
    log("no certificate, so players on other laptops get the slower");
    log("main-thread synth. Run ./make-cert.sh in scan/ to make one.");
  }
  if (HOST === "0.0.0.0") {
    // the addresses the other laptops in the room should type
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          log(
            `on the network: ${SCHEME}://${net.address}:${PORT}   (${name})  + /conduct.html to conduct` +
              (TLS ? "   (players click through the certificate warning once)" : "")
          );
        }
      }
    }
  }
});

process.on("SIGINT", () => {
  log("bye");
  process.exit(0);
});
