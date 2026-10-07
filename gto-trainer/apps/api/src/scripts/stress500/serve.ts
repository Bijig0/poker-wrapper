/**
 * Serve the stress-500 replayer locally with a place to keep Brady's review marks (2026-10-07).
 *
 *   bun src/scripts/stress500/serve.ts --dir <exported replayer dir> [--marks <marks.json>] [--port 5310]
 *
 * Static files from --dir (the export.ts output: stress500.html + data/), no caching, plus
 *   GET  api/marks  → the marks file as JSON ({} when absent)
 *   POST api/marks  → replaces the marks file (the page sends the whole object; a backup of the previous file is kept
 *                     beside it as marks.prev.json)
 * The replayer falls back to localStorage when this endpoint is missing (the artifact copy), so the two stay in step
 * through its Export / Import buttons.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";

const argv = process.argv.slice(2);
const arg = (k: string): string | undefined => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const DIR = (arg("dir") ?? ".").replace(/\\/g, "/");
const MARKS = (arg("marks") ?? join(DIR, "marks.json")).replace(/\\/g, "/");
const PORT = Number(arg("port") ?? 5310);
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".json": "application/json", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };

mkdirSync(dirname(MARKS), { recursive: true });
const readMarks = (): string => (existsSync(MARKS) ? readFileSync(MARKS, "utf-8") : "{}");

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (path === "api/marks") {
      if (req.method === "GET") return new Response(readMarks(), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
      if (req.method === "POST") {
        const body = await req.text();
        try { JSON.parse(body); } catch { return new Response("not json", { status: 400 }); }
        if (existsSync(MARKS)) renameSync(MARKS, MARKS.replace(/\.json$/, ".prev.json"));
        writeFileSync(MARKS, body);
        return new Response("ok", { headers: { "cache-control": "no-store" } });
      }
      return new Response("method", { status: 405 });
    }
    const rel = normalize(path || "stress500.html").replace(/^(\.\.[\\/])+/, "");
    const file = Bun.file(join(DIR, rel));
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file, { headers: { "content-type": TYPES[extname(rel)] ?? "application/octet-stream", "cache-control": "no-store" } });
  },
});
console.log(`stress-500 replayer on http://127.0.0.1:${PORT} · dir ${DIR} · marks ${MARKS}`);
