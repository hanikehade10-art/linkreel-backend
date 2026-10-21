const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

async function makeScript(title, text) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("No Gemini key set on Render");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const prompt =
    "Write a 30-second video narration script (about 70 words) in simple, engaging English based on this article. Return only the narration text.\n\nTitle: " +
    title + "\n\n" + text;
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
  if (!out) throw new Error("Gemini error: " + JSON.stringify(data).slice(0, 300));
  return out.trim();
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
    res.json({ title, text, script });
  } catch (e) {
    res.status(500).json({ error: "Something went wrong: " + e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
