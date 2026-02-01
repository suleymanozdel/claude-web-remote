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
  let isFirstMessage = true;

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

    // Strategy: find the LAST block of conversational text before the final ❯ prompt.
    // Claude's output pattern: [user echo] [spinner] [tool calls...] [answer text] [❯ prompt]
    // The answer is the last substantial block of natural language.

    const lines = clean.split("\n").map(l => l.trim()).filter(l => l);

    // Find the last prompt marker index
    let lastPromptIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^❯/.test(lines[i]) || /for\s+shortcuts/i.test(lines[i])) {
        lastPromptIdx = i;
        break;
      }
    }

    // Work backwards from the prompt to find the answer block.
    // The answer block is continuous text that is NOT ui chrome/spinner/tool output.
    const candidateLines = lastPromptIdx > 0 ? lines.slice(0, lastPromptIdx) : lines;

    // Filter out junk, keep answer lines
    const isJunk = (l) => {
      if (!l || l.length < 3) return true;
      // Spinner
      if (/^[A-Za-z\u00C0-\u024F]+…/.test(l)) return true;
      if (/^[A-Za-z\u00C0-\u024F]+\.{2,3}$/.test(l)) return true;
      if (/^[A-Z][a-z]+$/.test(l) && l.length < 15) return true;
      if (/^(\w+)(\s+\1){1,}/i.test(l)) return true;
      if (/^\([a-z]+\)$/i.test(l)) return true;
      // UI/chrome
      if (/^[>❯?]/.test(l)) return true;
      if (/for\s+shortcuts/i.test(l)) return true;
      if (/esc\s+(to\s+)?interrupt/i.test(l)) return true;
      if (/welcome\s*back/i.test(l)) return true;
      if (/Claude\s*Code/i.test(l)) return true;
      if (/opus|claude\s+max|organization/i.test(l)) return true;
      if (/@.*\.(com|org|net|io)/i.test(l)) return true;
      if (/\/opt\/|workspaces\//i.test(l)) return true;
      if (/^\//i.test(l)) return true;
      if (/subagent/i.test(l)) return true;
      if (/^Tip:/i.test(l)) return true;
      if (/stopit/i.test(l)) return true;
      if (/ctrl\+/i.test(l)) return true;
      if (/Esc to cancel/i.test(l)) return true;
      if (/Tab to amend/i.test(l)) return true;
      if (/Do you want to proceed/i.test(l)) return true;
      if (/tool use/i.test(l)) return true;
      if (/thought for/i.test(l)) return true;
      if (/Checking for updates/i.test(l)) return true;
      if (/-maxdepth|-name|-type/i.test(l)) return true;  // shell commands
      if (/Explore\(|Read\(|Glob\(|Grep\(|Write\(|Edit\(|Bash\(/i.test(l)) return true;  // tool names
      if (/\d+\s*tokens?/i.test(l) && l.length < 40) return true;
      if (/^\$[\d.]+/i.test(l)) return true;
      if (/Yes,\s+allow/i.test(l)) return true;
      if (/Tips\s+for|Ask\s+Claude|Recent\s+activity|No\s+recent|Try\s+"/i.test(l)) return true;
      if (/beneath\s+the\s+input|I\s+want\s+to\s+build/i.test(l)) return true;
      if (/--agent\s/i.test(l)) return true;
      if (/\/(exit|help|clear|compact|stop|cost|review|install)/i.test(l)) return true;
      if (/press\s+/i.test(l) && l.length < 40) return true;
      // Short phrase likely spinner
      if (/^[a-z]+ [a-z]+( [a-z]+)?$/i.test(l) && l.length < 20) return true;
      return false;
    };

    // Keep all non-junk lines
    const answerLines = candidateLines.filter(l => !isJunk(l));

    let result = answerLines.join(" ").replace(/\s{2,}/g, " ").trim();

    // Post-processing: strip spinner/thinking/echo fragments from joined text
    result = result
      .replace(/\(thinking\)/gi, "")
      .replace(/\bthinking\b/gi, "")
      .replace(/\b[A-Za-z\u00C0-\u024F]+…/g, "")
      .replace(/…/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    // Strip leading junk: remove all short (1-4 char) word fragments at the start
    // until we hit a word of 5+ chars (likely the start of real text)
    result = result.replace(/^(\s*\b[a-zA-Z]{1,4}\b[\s.,;:!?-]*)+/, "").trim();
    // Also strip if it starts with punctuation
    result = result.replace(/^[\s!.,;:?-]+/, "").trim();

    // Remove the user's prompt text if it leaked through
    if (lastUserText && lastUserText.length > 2) {
      const escaped = lastUserText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "gi"), "").replace(/\s{2,}/g, " ").trim();
    }

    return result;
  }

  function needsUserInput(raw) {
    const stripped = stripAnsiServer(raw);
    if (/Do you want to proceed/i.test(stripped)) return "Claude is asking: Do you want to proceed?";
    if (/Yes,\s+allow/i.test(stripped)) return "Claude needs your permission.";
    if (/Allow\s+(once|always)/i.test(stripped)) return "Claude is asking for permission.";
    if (/Esc to cancel/i.test(stripped) && /Tab to amend/i.test(stripped)) return "Claude needs your approval.";
    if (/Run command\?/i.test(stripped)) return "Claude wants to run a command.";
    if (/Allow\s+.*\?/i.test(stripped)) return "Claude is asking for permission.";
    if (/\(y\/n\)/i.test(stripped) || /\[Y\/n\]/i.test(stripped)) return "Claude needs a yes or no answer.";
    return null;
  }

  let inputNotifSent = false;

  function onOutputChunk(raw) {
    if (!userSentAt) return;
    if (Date.now() - userSentAt > 120000) return;

    rawBuffer += raw;

    // --- Notification: check if Claude needs user input ---
    if (!inputNotifSent) {
      const inputNeeded = needsUserInput(rawBuffer);
      if (inputNeeded) {
        inputNotifSent = true;
        console.log(`[NOTIFY] Input needed: "${inputNeeded}"`);
        send({ type: "input_needed", message: inputNeeded });
      }
    }

    // --- TTS: read Claude's answer aloud ---
    if (ttsDone) return;
    clearTimeout(ttsTimer);

    // Wait for prompt marker ❯ (Claude is done responding)
    const promptCount = (rawBuffer.match(/❯/g) || []).length;
    const needed = isFirstMessage ? 2 : 1;
    if (promptCount < needed) return;

    // Prompt appeared — wait 2s for trailing output, then extract and speak
    ttsTimer = setTimeout(async () => {
      const finalAnswer = extractAnswer(rawBuffer);
      console.log(`[TTS] Extracted: "${finalAnswer.substring(0, 200)}"`);
      if (finalAnswer.length > 5) {
        ttsDone = true;
        isFirstMessage = false;
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
        inputNotifSent = false;
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
