const express = require("express");
const cors = require("cors");
const cheerio = require("cheerio");

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("LinkReel backend is running");
});

app.post("/read", async (req, res) => {
  try {
    const url = req.body.url;
    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: "Please paste a full link starting with http or https" });
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
    res.json({ title, text });
  } catch (e) {
    res.status(500).json({ error: "Could not read that link" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running on port " + PORT));
