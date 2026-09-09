import { Hono } from "hono";
import { join, normalize, sep } from "node:path";

/**
 * The study tool's UI pages, served straight off this API.
 *
 * These three used to be React routes on the dashboard app (:2100), iframed
 * into the wrapper's tool shell. Keeping a second dev server alive purely to
 * host them meant the study tool needed two node processes and a cross-origin
 * hop to reach its own pages, so they were rebuilt as plain pages here — the
 * data they need (`/api/replay/*`, the wrapper's own endpoints) was already on
 * this side or same-origin from it.
 *
 * Paths deliberately match the old :2100 routes (/table, /replay,
 * /state-tester) so anything still pointing at the dashboard only needs its
 * port changed.
 */
const studyUi = new Hono();

const ROOT = join(import.meta.dir, "..", "..", "static");

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

/**
 * Serve `rel` from the static directory.
 *
 * The path is normalised and re-checked against ROOT before opening: these
 * routes take a wildcard, so without that check a crafted `../` would read any
 * file the server process can.
 */
async function sendStatic(rel: string): Promise<Response> {
  const full = normalize(join(ROOT, rel));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) {
    return new Response("not found", { status: 404 });
  }
  const file = Bun.file(full);
  if (!(await file.exists())) return new Response("not found", { status: 404 });

  const dot = full.lastIndexOf(".");
  const type = TYPES[full.slice(dot).toLowerCase()] ?? "application/octet-stream";
  return new Response(file, { headers: { "Content-Type": type } });
}

/* ------------------------------------------------------------------ assets */

// The replica's own chrome and card art, at the paths the renderer asks for.
// `cardArt()` builds "/cards/<kind>/<code>.png" and the client's harvested
// SVGs live under "/ign/", so these two prefixes are part of the contract.
studyUi.get("/cards/*", (c) => sendStatic(c.req.path));
studyUi.get("/ign/*", (c) => sendStatic(c.req.path));
studyUi.get("/study/*", (c) => sendStatic(c.req.path));

/* ------------------------------------------------------------------- pages */

studyUi.get("/table", () => sendStatic("/study/reader-verify.html"));
studyUi.get("/replay", () => sendStatic("/study/replay-review.html"));
studyUi.get("/state-tester", () => sendStatic("/study/state-tester.html"));

export default studyUi;
