#!/usr/bin/env node
/*
  scan-bridge.js — one small process, no dependencies.

    * serves the repo over HTTP            (the page needs absolute paths like
                                            /src/utils.js and the worklet URL)
    * a minimal WebSocket server on the    (the page connects back to it)
      same port
    * UDP in  on 7400: OSC from Max        -> forwarded to the page
    * UDP out on 7401: OSC to Max          <- cell + gesture feedback

  usage:
      node scan-bridge/scan-bridge.js [--port 8080] [--udp-in 7400]
                                      [--udp-out 7401] [--out-host 127.0.0.1]
                                      [--root <repo root>] [--host 0.0.0.0]

  then open   http://localhost:8080            (a player)
              http://localhost:8080/conduct.html  (the conductor)

  In Max:   [udpsend 127.0.0.1 7400]   <- messages beginning with "/" are sent
                                          as OSC automatically
            [udpreceive 7401]          <- feedback
*/

const http = require("http");
const dgram = require("dgram");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
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
const ROOT = path.resolve(arg("root", path.join(__dirname, "..")));
// every interface by default, so the other laptops in the room can reach it;
// --host 127.0.0.1 keeps it to this machine
const HOST = arg("host", "0.0.0.0");

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
  ".maxpat": "application/json; charset=utf-8",
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
};

const server = http.createServer((request, response) => {
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
  log(`page connected (${clients.size} open)`);

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
    clients.delete(socket);
    log(`page disconnected (${clients.size} open)`);
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
const RELAYED = /^\/(cue|player|conductor)\//;

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
    if (RELAYED.test(item.address)) relay.push(item);
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
  log(`players  http://localhost:${PORT}/`);
  log(`conduct  http://localhost:${PORT}/conduct.html`);
  if (HOST === "0.0.0.0") {
    // the addresses the other laptops in the room should type
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === "IPv4" && !net.internal) {
          log(`on the network: http://${net.address}:${PORT}   (${name})  + /conduct.html to conduct`);
        }
      }
    }
  }
});

process.on("SIGINT", () => {
  log("bye");
  process.exit(0);
});
