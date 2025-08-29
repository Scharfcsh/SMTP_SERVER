// server.js — minimal SMTP listener (educational, localhost-only)
// Node 18+ recommended
import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const HOST = "127.0.0.1";
const PORT = 2525;
const SPOOL_DIR = "/tmp/smtp-mvp";
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const ALLOWED_DOMAINS = new Set(["local.test", "example.com"]); // accept RCPT TO only for these domains

fs.mkdirSync(SPOOL_DIR, { recursive: true });

function nowISO() { return new Date().toISOString(); }

function writeLine(socket, line) {
  socket.write(line + "\r\n");
}

function parseAddr(angleAddr) {
  // angleAddr like: <alice@example.com>  OR bare alice@example.com
  const m = angleAddr.match(/<([^>]+)>/) || angleAddr.match(/([^<>\s]+)/);
  return m ? m[1].toLowerCase() : "";
}

const server = net.createServer((socket) => {
  socket.setEncoding("utf8");
  socket.setTimeout(2 * 60 * 1000);
  const remote = `${socket.remoteAddress}:${socket.remotePort}`;
  console.log(`[${nowISO()}] CONNECT ${remote}`);

  let buf = "";
  const session = {
    state: "GREET", // GREET -> MAIL -> RCPT -> DATA
    helo: null,
    mailFrom: null,
    rcptTo: [],
    dataLines: [],
    bytes: 0
  };

  writeLine(socket, "220 smtp-local.test SimpleSMTP ready");

  socket.on("data", (chunk) => {
    buf += chunk;
    // process lines by CRLF
    let idx;
    while ((idx = buf.indexOf("\r\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleLine(line);
    }
  });

  socket.on("timeout", () => {
    writeLine(socket, "421 4.4.2 Timeout - closing");
    socket.end();
  });

  socket.on("close", () => {
    console.log(`[${nowISO()}] DISCONNECT ${remote}`);
  });

  socket.on("error", (err) => {
    console.error("socket error", err);
  });

  function handleLine(rawLine) {
    const line = rawLine.replace(/\r?\n$/, "");
    // console.log("C:", line);
    // DATA mode handling
    if (session.state === "DATA") {
      if (line === ".") {
        // end of data
        const raw = session.dataLines.join("\r\n") + "\r\n";
        if (Buffer.byteLength(raw) > MAX_SIZE) {
          writeLine(socket, "552 5.3.4 Message size exceeds fixed limit");
        } else {
          persistMessage(session, raw, remote);
          writeLine(socket, "250 2.0.0 OK queued");
        }
        // reset transaction
        session.state = "MAIL";
        session.mailFrom = null;
        session.rcptTo = [];
        session.dataLines = [];
        session.bytes = 0;
        return;
      }
      // dot-stuffing handling
      const dataLine = line.startsWith("..") ? line.slice(1) : line;
      session.dataLines.push(dataLine);
      session.bytes += Buffer.byteLength(dataLine + "\r\n");
      if (session.bytes > MAX_SIZE) {
        writeLine(socket, "552 5.3.4 Message too large; closing DATA");
        session.state = "MAIL";
        session.mailFrom = null;
        session.rcptTo = [];
        session.dataLines = [];
        session.bytes = 0;
      }
      return;
    }

    const up = line.toUpperCase();
    if (up.startsWith("EHLO") || up.startsWith("HELO")) {
      session.helo = line.split(/\s+/)[1] || "";
      // multi-line 250 response
      session.state = "MAIL";
      writeLine(socket, "250-smtp-local.test Hello " + (session.helo || "client"));
      writeLine(socket, "250-8BITMIME");
      writeLine(socket, `250-SIZE ${MAX_SIZE}`);
      writeLine(socket, "250-STARTTLS"); // placeholder, not implemented in this MVP
      writeLine(socket, "250 HELP");
      // writeLine(socket, `${session.state}`);
      console.log("session changed to MAIL state", session.state);
      return;
    }

    if (up.startsWith("MAIL FROM:")) {
      if (session.state !== "MAIL") { writeLine(socket, "503 5.5.1 Bad sequence of commands"); return; }
      const addr = parseAddr(line.slice(10).trim());
      session.mailFrom = addr;
      writeLine(socket, "250 2.1.0 OK");
      return;
    }

    if (up.startsWith("RCPT TO:")) {
      if (!session.mailFrom) { writeLine(socket, "503 5.5.1 Need MAIL FROM first"); return; }
      const rcpt = parseAddr(line.slice(8).trim());
      const domain = rcpt.split("@")[1] || "";
      if (!ALLOWED_DOMAINS.has(domain)) {
        writeLine(socket, "550 5.1.1 Relay denied");
        return;
      }
      session.rcptTo.push(rcpt);
      writeLine(socket, "250 2.1.5 OK");
      return;
    }

    if (up === "DATA") {
      if (!session.mailFrom || session.rcptTo.length === 0) {
        writeLine(socket, "503 5.5.1 Need MAIL FROM and RCPT TO first");
        return;
      }
      session.state = "DATA";
      session.dataLines = [];
      session.bytes = 0;
      writeLine(socket, "354 End data with <CR><LF>.<CR><LF>");
      return;
    }

    if (up === "RSET") {
      session.state = "MAIL";
      session.mailFrom = null;
      session.rcptTo = [];
      session.dataLines = [];
      session.bytes = 0;
      writeLine(socket, "250 2.0.0 OK");
      return;
    }

    if (up === "NOOP") { writeLine(socket, "250 2.0.0 OK"); return; }

    if (up === "QUIT") { writeLine(socket, "221 2.0.0 Bye"); socket.end(); return; }

    if (up === "STARTTLS") {
      // educational: we are not implementing TLS here
      writeLine(socket, "454 4.7.0 TLS not available (MVP)");
      return;
    }

    writeLine(socket, "502 5.5.2 Command not implemented");
  } // end handleLine

  function persistMessage(sess, raw, remoteAddr) {
    try {
      const id = randomUUID();
      const base = path.join(SPOOL_DIR, id);
      const meta = {
        id,
        receivedAt: new Date().toISOString(),
        remote: remoteAddr,
        helo: sess.helo,
        mailFrom: sess.mailFrom,
        rcptTo: sess.rcptTo
      };
      fs.writeFileSync(base + ".meta.json", JSON.stringify(meta, null, 2), { flag: "w" });
      fs.writeFileSync(base + ".eml", raw, { flag: "w" });
      console.log(`[${nowISO()}] QUEUED id=${id} from=${sess.mailFrom} to=${sess.rcptTo.join(",")}`);
    } catch (err) {
      console.error("persist error", err);
    }
  }

}); // end server

server.listen(PORT, HOST, () => {
  console.log(`Simple SMTP MVP listening on ${HOST}:${PORT} (spool=${SPOOL_DIR})`);
});
