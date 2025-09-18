// server.js
import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import fs from "fs";
import { randomUUID } from "crypto";

const spoolDir = "/tmp/mails";
fs.mkdirSync(spoolDir, { recursive: true });

const server = new SMTPServer({
  // No login required (good for inbound mail)
  authOptional: true,

  // Accept any recipient address at your domain
  onRcptTo(address, session, callback) {
    if (!address.address.endsWith("@amanadhikari.me")) {
      return callback(new Error("550: Invalid recipient domain"));
    }
    callback(); // accept
  },

  // Handle incoming mail stream
  onData(stream, session, callback) {
    let raw = "";
    stream.on("data", (chunk) => {
      raw += chunk.toString();
    });
    stream.on("end", async () => {
      try {
        const id = randomUUID();
        const emlPath = `${spoolDir}/${id}.eml`;
        fs.writeFileSync(emlPath, raw);

        const parsed = await simpleParser(raw);
        console.log(`📩 New mail received!`);
        console.log(`   To: ${parsed.to?.text}`);
        console.log(`   From: ${parsed.from?.text}`);
        console.log(`   Subject: ${parsed.subject}`);
        console.log(`   Saved at: ${emlPath}`);

        callback(); // tell SMTP client we're done
      } catch (err) {
        console.error("❌ Error parsing mail:", err);
        callback(err);
      }
    });
  },
});

// IMPORTANT: Gmail and other providers deliver on port 25
server.listen(25, "0.0.0.0", () => {
  console.log("✅ SMTP server listening on 0.0.0.0:25");
  console.log(`📂 Mails will be stored in ${spoolDir}`);
});
