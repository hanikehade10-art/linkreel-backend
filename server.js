const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const ffmpegPath = require("ffmpeg-static");
const { EdgeTTS } = require("node-edge-tts");

const app = express();
app.use(cors());
app.use(express.json());

const jobs = {};

async function makeScript(title, text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No Gemini key set on Render");
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";
  const prompt =
    "Write a 30-second video narration script (about 70 words) in simple, engaging English based on this article. Stay close to the article and do not exaggerate. Return only the narration text.\n\nTitle: " +
    title + "\n\n" + text;
  let last = "";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      }
    );
    const data = await r.json();
    const out = data.candidates && data.candidates[0] && data.candidates[0].content.parts[0].text;
    if (out) return out.trim();
    last = JSON.stringify(data).slice(0, 300);
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error("Gemini error: " + last);
}

async function makeAudio(script, dir) {
  const file = path.join(dir, "voice.mp3");
  const tts = new EdgeTTS({
    voice: "en-US-AriaNeural",
    lang: "en-US",
    outputFormat: "audio-24khz-48kbitrate-mono-mp3"
  });
  await tts.ttsPromise(script, file);
  return file;
}

function getImageUrls($, baseUrl) {
  const raw = [];
  const og = $('meta[property="og:image"]').attr("content");
  if (og) raw.push(og);
  $("img").each((i, el) => {
    const s = $(el).attr("src") || $(el).attr("data-src");
    if (s) raw.push(s);
  });
  const urls = [];
  for (const s of raw) {
    try {
      const u = new URL(s, baseUrl).href;
      if (/^https?:/i.test(u) && !/\.(svg|gif)(\?|$)/i.test(u) && !urls.includes(u)) {
        urls.push(u);
      }
    } catch (e) {}
  }
  return urls.slice(0, 10);
}

async function downloadImages(urls, dir) {
  const files = [];
  for (const u of urls) {
    if (files.length >= 4) break;
    try {
      const r = await fetch(u, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(10000)
      });
      const ct = r.headers.get("content-type") || "";
      if (!ct.startsWith("image/")) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 15000) continue;
      const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
      const file = path.join(dir, "img" + files.length + "." + ext);
      fs.writeFileSync(file, buf);
      files.push(file);
    } catch (e) {}
  }
  return files;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile(ffmpegPath, args, { timeout: 300000 }, (err, stdout, stderr) => {
      if (err) reject(new Error("FFmpeg failed: " + String(stderr || err.message).slice(-200)));
      else resolve();
    });
  });
}

async function buildVideo(job, imageUrls, dir, audioFile) {
  try {
    const images = await downloadImages(imageUrls, dir);
    const seconds = (fs.statSync(audioFile).size * 8) / 48000;
    const out = path.join(dir, "video.mp4");
    let args;
    if (images.length === 0) {
      args = [
        "-y", "-f", "lavfi", "-i", "color=c=0x1a1a2e:s=480x854:r=15",
        "-i", audioFile, "-shortest",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", out
      ];
    } else {
      const each = seconds / images.length + 1;
      args = ["-y"];
      images.forEach((img) => args.push("-loop", "1", "-t", String(each), "-i", img));
      args.push("-i", audioFile);
      const parts = images.map(
        (_, i) =>
          "[" + i + ":v]scale=480:854:force_original_aspect_ratio=increase,crop=480:854,setsar=1,fps=15[v" + i + "]"
      );
      const joined = images.map((_, i) => "[v" + i + "]").join("");
      const filter = parts.join(";") + ";" + joined + "concat=n=" + images.length + ":v=1:a=0[v]";
      args.push(
        "-filter_complex", filter,
        "-map", "[v]", "-map", images.length + ":a", "-shortest",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-movflags", "+faststart", out
      );
    }
    await runFfmpeg(args);
    job.file = out;
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e.message.slice(0, 250);
  }
}

app.get("/", (req, res) => {
  res.send("LinkReel backend is running");
});

app.post("/read", async (req, res) => {
  try {
    let url = (req.body.url || "").trim();
    if (!url) {
      return res.status(400).json({ error: "Please paste a link first" });
    }
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }
    const response = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    const html = await response.text();
    const $ = cheerio.load(html);
    const imageUrls = getImageUrls($, url);
    $("script, style, nav, footer, noscript").remove();
    const title = $("title").first().text().trim();
    const text = $("p")
      .map((i, el) => $(el).text().trim())
      .get()
      .filter((t) => t.length > 40)
      .join("\n\n")
      .slice(0, 3000);
    if (!text) {
      return res.status(400).json({ error: "Could not find readable text on that page" });
    }
    const script = await makeScript(title, text);

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lr-"));
    let audio = null;
    let audioError = null;
    let jobId = null;
    try {
      const audioFile = await makeAudio(script, dir);
      audio = fs.readFileSync(audioFile).toString("base64");
      jobId = crypto.randomUUID();
      const job = { status: "working" };
      jobs[jobId] = job;
      buildVideo(job, imageUrls, dir, audioFile);
      setTimeout(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete jobs[jobId];
      }, 30 * 60 * 1000);
    } catch (e) {
      audioError = e.message;
      fs.rmSync(dir, { recursive: true, force: true });
    }
    res.json({ title, script, audio, audioError, jobId });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong: " + e.message });
  }
});

app.get("/job/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job) {
    return res.json({ status: "error", error: "Job not found. The server may have restarted." });
  }
  res.json({ status: job.status, error: job.error || null });
});

app.get("/video/:id", (req, res) => {
  const job = jobs[req.params.id];
  if (!job || job.status !== "done") {
    return res.status(404).send("Video not ready");
  }
  if (req.query.download) {
    return res.download(job.file, "linkreel.mp4");
  }
  res.sendFile(job.file);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
