import express from "express";
import fs from "fs";
import path from "path";
import { simpleParser } from "mailparser";

const app = express();
const PORT = 3000;
const SPOOL_DIR = "/tmp/mails";

app.set("view engine", "ejs");
app.set("views", "./views");

// Main inbox page
app.get("/", async (req, res) => {
  try {
    const files = fs.readdirSync(SPOOL_DIR).filter(f => f.endsWith(".eml"));
    const emails = [];

    for (const file of files) {
      const raw = fs.readFileSync(path.join(SPOOL_DIR, file));
      const parsed = await simpleParser(raw);
      emails.push({
        subject: parsed.subject || "(no subject)",
        from: parsed.from?.text || "(unknown)",
        to: parsed.to?.text || "(unknown)",
        date: parsed.date?.toISOString() || "(no date)",
        text: parsed.text || "",
        id: file
      });
    }

    // Show newest first
    emails.sort((a,b) => new Date(b.date) - new Date(a.date));
    res.render("inbox", { emails });
  } catch (err) {
    res.status(500).send("Error reading mails: " + err.message);
  }
});

// View single email
app.get("/email/:id", (req, res) => {
  try {
    const raw = fs.readFileSync(path.join(SPOOL_DIR, req.params.id));
    simpleParser(raw).then(parsed => {
      res.render("email", { email: parsed });
    });
  } catch (err) {
    res.status(404).send("Email not found");
  }
});

app.listen(PORT, () => {
  console.log(`📨 Inbox UI running at http://localhost:${PORT}`);
});
