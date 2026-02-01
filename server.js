// Claude Code Web Remote - Server
// ================================
// Express + WebSocket server that spawns Claude Code in a real PTY.
// Each connected client gets their own Claude session.

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { WebSocketServer } = require("ws");

const PORT = parseInt(process.env.PORT, 10) || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";
const CLAUDE_BIN = process.env.CLAUDE_BIN || "/home/ubuntu/.local/bin/claude";
const PTY_HELPER = path.join(__dirname, "pty-helper.py");

const OPENAI_KEY = process.env.OPENAI_KEY || "";

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Whisper transcription endpoint ---
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No audio file" });
  if (!OPENAI_KEY) return res.status(500).json({ error: "No OpenAI key configured" });

  try {
    const FormData = (await import("form-data")).default;
    const form = new FormData();
    form.append("file", req.file.buffer, { filename: "audio.webm", contentType: req.file.mimetype });
    form.append("model", "whisper-1");
    form.append("response_format", "json");

    const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, ...form.getHeaders() },
      body: form.getBuffer(),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("Whisper error:", err);
      return res.status(502).json({ error: "Whisper API error" });
    }

    const data = await response.json();
    res.json({ text: data.text || "" });
  } catch (err) {
    console.error("Transcribe error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- TTS endpoint (AWS Polly) ---
const { PollyClient, SynthesizeSpeechCommand } = require("@aws-sdk/client-polly");
const polly = new PollyClient({ region: "eu-central-1" });

// Warm up Polly credentials on startup so first request isn't slow
(async () => {
  try {
    await polly.send(new SynthesizeSpeechCommand({
      Text: "ready", OutputFormat: "mp3", VoiceId: "Danielle", Engine: "generative",
    }));
    console.log("Polly warmed up.");
  } catch (err) {
    console.error("Polly warmup failed:", err.message);
  }
})();

app.post("/api/tts", async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });

  try {
    const cmd = new SynthesizeSpeechCommand({
      Text: text.substring(0, 3000),
      OutputFormat: "mp3",
      VoiceId: "Danielle",
      Engine: "generative",
    });
    const result = await polly.send(cmd);

    res.set("Content-Type", "audio/mpeg");
    const stream = result.AudioStream;
    stream.pipe(res);
  } catch (err) {
    console.error("Polly TTS error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- Text fix endpoint (OpenAI proxy) ---
app.post("/api/fix-text", async (req, res) => {
  const { text, history } = req.body;
  if (!text) return res.status(400).json({ error: "No text provided" });
  if (!OPENAI_KEY) return res.status(500).json({ error: "No OpenAI key configured" });

  try {
    const messages = [
      {
        role: "system",
        content: "You fix the user's text: correct grammar, spelling, and clarity. Keep it concise — do NOT extend or add content. Preserve the original meaning and tone. Return ONLY the corrected text, nothing else. No quotes, no explanations."
      }
    ];

    if (history && Array.isArray(history)) {
      for (const h of history.slice(-10)) {
        messages.push({ role: "user", content: h });
      }
    }
    messages.push({ role: "user", content: text });

    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        max_tokens: 500,
        temperature: 0.3,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error("OpenAI error:", err);
      return res.status(502).json({ error: "OpenAI API error" });
    }

    const data = await response.json();
    const fixed = data.choices?.[0]?.message?.content?.trim() || text;
    res.json({ fixed });
  } catch (err) {
    console.error("Fix-text error:", err.message);
    res.json({ fixed: text });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// --- Per-client session management ---
const fs = require("fs");
const IDLE_TIMEOUT = 5 * 60 * 1000;
const WORKSPACES_DIR = path.join(__dirname, "workspaces");

function ensureUserDir(name) {
  // Sanitize name to safe directory name
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 32) || "anonymous";
  const dir = path.join(WORKSPACES_DIR, safe);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created workspace for "${safe}" at ${dir}`);
  }
  return dir;
}

function spawnClaude(cols, rows, userName) {
  const ptyCols = cols || 80;
  const ptyRows = rows || 24;
  const cwd = ensureUserDir(userName);
  console.log(`Spawning Claude Code PTY (${ptyCols}x${ptyRows}) for "${userName}" in ${cwd}...`);
  const child = spawn("python3", [PTY_HELPER, CLAUDE_BIN], {
    cwd,
    env: {
      ...process.env,
      TERM: "xterm-256color",
      PTY_COLS: String(ptyCols),
      PTY_ROWS: String(ptyRows),
      HOME: process.env.HOME || "/home/ubuntu",
      PATH: `/home/ubuntu/.local/bin:${process.env.PATH}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

wss.on("connection", (ws, req) => {
  // Auth check
  if (AUTH_TOKEN) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get("token");
    if (token !== AUTH_TOKEN) {
      ws.send(JSON.stringify({ type: "error", data: "Invalid or missing auth token." }));
      ws.close(4001, "Unauthorized");
      return;
    }
  }

  const clientIp = req.headers["x-real-ip"] || req.socket.remoteAddress;
  const url = new URL(req.url, `http://${req.headers.host}`);
  const clientName = url.searchParams.get("name") || "anonymous";
  console.log(`Client "${clientName}" connected from ${clientIp}`);

  let child = null;
  let idleTimer = null;

  function send(msg) {
    try { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); } catch {}
  }

  function killSession() {
    clearTimeout(idleTimer);
    if (child) {
      console.log(`Killing Claude session for "${clientName}" (${clientIp})`);
      try { child.kill("SIGTERM"); } catch {}
      child = null;
    }
  }

  // --- Server-side TTS answer extraction ---
  let rawBuffer = "";
  let userSentAt = 0;
  let ttsTimer = null;
  let ttsDone = false;
  let lastUserText = "";

  function stripAnsiServer(str) {
    return str
      .replace(/\x1b\][^\x07]*\x07/g, "")
      // Replace cursor movement sequences with a space to prevent word merging
      .replace(/\x1b\[[0-9;?]*[ABCDHJ]/g, " ")
      .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
      .replace(/\x1b[()][A-Z0-9]/g, "")
      .replace(/\x1b[\x20-\x2F]*[\x40-\x7E]/g, "")
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
      .replace(/\r\n?/g, "\n");
  }

  function extractAnswer(raw) {
    const clean = stripAnsiServer(raw)
      .replace(/[╭╮╯╰│┌┐└┘├┤┬┴┼▐▛▜▌▝▘█▀▄░▒▓⎿⎡⎢⎣]/g, "")
      .replace(/[─━]{2,}/g, "")
      .replace(/[✻✶✽✢●·⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\*]/g, "")
      .replace(/\xa0/g, " ");

    const lines = clean.split("\n").map(l => l.trim()).filter(l => l);

    // Filter out all known UI/chrome lines
    const answerLines = lines.filter(l => {
      const alpha = l.replace(/[^a-zA-Z]/g, "");
      if (alpha.length < 3) return false;
      if (l.length < 8) return false;

      // --- Spinner / animation ---
      // Single word + ellipsis (any language, accented)
      if (/^[A-Za-z\u00C0-\u024F]+…/.test(l) && l.length < 25) return false;
      if (/^[A-Za-z\u00C0-\u024F]+\.{2,3}$/.test(l)) return false;
      // Single capitalized word alone (truncated spinner)
      if (/^[A-Z\u00C0-\u024F][a-z\u00C0-\u024F]+$/.test(l) && l.length < 15) return false;
      // Same word repeated ("thinking thinking thinking")
      if (/^(\w+)(\s+\1){1,}/i.test(l)) return false;
      // "(word)" pattern
      if (/^\([a-z]+\)$/i.test(l)) return false;
      // Two-three word spinner phrases ("point in time", etc.)
      if (/^[a-z]+ [a-z]+( [a-z]+)?$/i.test(l) && l.length < 20) return false;

      // --- Welcome screen & UI chrome ---
      if (/welcome\s*back/i.test(l)) return false;
      if (/Claude\s*Code/i.test(l)) return false;
      if (/opus|claude\s+max|organization/i.test(l)) return false;
      if (/@.*\.(com|org|net|io)/i.test(l)) return false;
      if (/\/opt\/|workspaces\//i.test(l)) return false;
      if (/Tips\s+for/i.test(l)) return false;
      if (/Ask\s+Claude/i.test(l)) return false;
      if (/Recent\s+activity/i.test(l)) return false;
      if (/No\s+recent\s+activity/i.test(l)) return false;
      if (/I\s+want\s+to\s+build/i.test(l)) return false;
      if (/beneath\s+the\s+input/i.test(l)) return false;
      if (/Try\s+"/i.test(l)) return false;

      // --- Prompt / input UI ---
      if (/^[>❯]/.test(l)) return false;
      if (/^\?/.test(l)) return false;
      if (/for\s+shortcuts/i.test(l)) return false;
      if (/esc\s+(to\s+)?interrupt/i.test(l)) return false;
      if (/press\s+/i.test(l) && l.length < 40) return false;

      // --- Slash commands and UI labels ---
      if (/^\//i.test(l)) return false;
      if (/\/(exit|help|clear|compact|stop|cost|review|install)/i.test(l)) return false;
      if (/subagent/i.test(l)) return false;
      if (/stopit/i.test(l)) return false;
      if (/--agent\s/i.test(l)) return false;
      if (/^Tip:/i.test(l)) return false;

      // --- Cost/token info ---
      if (/\d+\s*tokens?/i.test(l) && l.length < 40) return false;
      if (/^\$[\d.]+/i.test(l)) return false;

      return true;
    });

    // Join into single text
    let result = answerLines.join(" ").replace(/\s{2,}/g, " ").trim();

    // --- Post-processing: clean spinner/junk from joined text ---
    // Remove "thinking" and fragments like "thi", "nki", "ng", "ing" that come from spinner animation
    result = result
      // Remove (thinking) and thinking repeated
      .replace(/\(thinking\)/gi, "")
      .replace(/\bthinking\b/gi, "")
      // Remove spinner word fragments: 2-3 char fragments separated by spaces/hyphens
      // Pattern: sequences of short fragments like "thi -nki ng" or "thi nki ng"
      .replace(/(\b[a-z]{1,3}\b[\s-]*){3,}/gi, (match) => {
        // Only remove if the fragments don't form a meaningful sentence
        const cleaned = match.replace(/[\s-]+/g, "");
        if (cleaned.length < 15) return "";
        return match;
      })
      // Remove any remaining isolated 1-3 letter fragments at start
      .replace(/^([a-z]{1,3}\s+)+/i, "")
      // Remove common spinner words that leaked through
      .replace(/\b(pondering|ruminating|musing|considering|reflecting|contemplating|reasoning|flowing|imagining|dreaming|composing|crafting|brewing|conjuring|weaving|channeling|processing|generating|ideating|saut[ée]ing|newspapering)\b\.{0,3}…?/gi, "")
      // Clean up
      .replace(/\s{2,}/g, " ")
      .trim();

    // Remove the user's prompt text if it leaked through
    if (lastUserText && lastUserText.length > 2) {
      const escaped = lastUserText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "").replace(/\s{2,}/g, " ").trim();
    }

    return result;
  }

  function onOutputChunk(raw) {
    if (!userSentAt || ttsDone) return;
    if (Date.now() - userSentAt > 60000) return;

    rawBuffer += raw;
    clearTimeout(ttsTimer);

    // Don't try to extract until at least 3s after user sent input (Claude needs time)
    if (Date.now() - userSentAt < 3000) {
      ttsTimer = setTimeout(() => onOutputChunk(""), 1000);
      return;
    }

    // Only start the debounce timer once we detect real answer content
    const preview = extractAnswer(rawBuffer);
    if (preview.length <= 5) return; // Still just spinner/UI, wait for more

    // We have answer content — wait 3s for more to arrive, then send
    ttsTimer = setTimeout(async () => {
      const finalAnswer = extractAnswer(rawBuffer);
      console.log(`[TTS] Extracted: "${finalAnswer.substring(0, 200)}"`);
      if (finalAnswer.length > 5) {
        ttsDone = true;
        try {
          const cmd = new SynthesizeSpeechCommand({
            Text: finalAnswer.substring(0, 3000),
            OutputFormat: "mp3",
            VoiceId: "Danielle",
            Engine: "generative",
          });
          const result = await polly.send(cmd);
          const chunks = [];
          for await (const chunk of result.AudioStream) {
            chunks.push(chunk);
          }
          const audioBuffer = Buffer.concat(chunks);
          const base64Audio = audioBuffer.toString("base64");
          send({ type: "tts_audio", audio: base64Audio });
        } catch (err) {
          console.error("Polly TTS error:", err.message);
        }
      }
    }, 2000);
  }

  function startSession(cols, rows) {
    if (child) return;
    child = spawnClaude(cols, rows, clientName);

    child.stdout.on("data", (data) => {
      const str = data.toString();
      send({ type: "output", data: str });
      onOutputChunk(str);
    });

    child.stderr.on("data", (data) => {
      send({ type: "output", data: data.toString() });
    });

    child.on("exit", (code) => {
      console.log(`Claude exited (code ${code}) for "${clientName}"`);
      send({ type: "exit", code });
      child = null;
    });

    child.on("error", (err) => {
      console.error(`Claude spawn error for "${clientName}":`, err.message);
      send({ type: "error", data: "Failed to start Claude: " + err.message });
      child = null;
    });

    send({ type: "ready" });
  }

  // Spawn immediately with default size
  startSession(80, 24);

  // Keepalive ping every 20s
  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) ws.ping();
    else clearInterval(pingInterval);
  }, 20000);

  ws.on("message", (msg) => {
    try {
      const parsed = JSON.parse(msg);
      if (parsed.type === "input") {
        if (!child) return;
        // Reset TTS tracking on user input
        rawBuffer = "";
        userSentAt = Date.now();
        ttsDone = false;
        lastUserText = parsed.data.replace(/\r$/, "").trim().toLowerCase();
        clearTimeout(ttsTimer);
        if (parsed.data.length > 1 && parsed.data.endsWith("\r")) {
          const text = parsed.data.slice(0, -1);
          child.stdin.write(text);
          setTimeout(() => { if (child) child.stdin.write("\r"); }, 200);
        } else {
          child.stdin.write(parsed.data);
        }
      } else if (parsed.type === "resize") {
        if (!child && parsed.cols && parsed.rows) {
          startSession(parsed.cols, parsed.rows);
        }
      }
    } catch {
      if (child) child.stdin.write(msg.toString());
    }
  });

  ws.on("close", () => {
    clearInterval(pingInterval);
    console.log(`Client "${clientName}" disconnected`);
    killSession();
  });

  ws.on("error", (err) => {
    clearInterval(pingInterval);
    console.error("WebSocket error:", err.message);
    killSession();
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Claude Web Remote running at http://0.0.0.0:${PORT}`);
  if (AUTH_TOKEN) console.log("Auth token is SET.");
  else console.log("WARNING: No AUTH_TOKEN set.");
});
