// A small static server, purely to preview popup.html and options.html outside
// Chrome. Not part of the shipped extension.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8791);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
};

createServer(async (req, res) => {
  const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
  const file = path.join(ROOT, rel || "dev/popup-preview.html");

  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end("nope");
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("introuvable");
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}/dev/popup-preview.html`));
