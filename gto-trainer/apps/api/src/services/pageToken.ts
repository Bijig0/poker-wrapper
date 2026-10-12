import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { API_DIR, REPO } from "./repoPaths";

/**
 * HAS THIS PAGE'S CODE CHANGED SINCE THE TAB LOADED IT (2026-10-13).
 *
 * Every page here is read from disk per request (index.ts, routes/studyUi.ts, the wrapper's server.ts), so an open tab
 * keeps running the JavaScript it was served while the file on disk moves on. A token per page — the page file AND
 * every script / stylesheet it loads from the API (size + mtime of each) — lets the tab notice; static/study/
 * page-reload.js then reloads it when nobody is using it, or shows a button.
 *
 * What a page loads is read from the page itself: every "/study/<file>.js|css" or "/dashboard.css" it names (a script
 * tag, a link, a dynamic import, a ${GTOW_API}/study/... string), and every "./x.js" a loaded module imports — so a new
 * asset is covered without touching this file. A name only in prose is covered too: one reload too many, never one
 * too few. Each file's references are re-read only when that file's size or mtime changes; a token otherwise costs one
 * stat per file.
 */

const STATIC = join(API_DIR, "static");
const WRAPPER_PAGES = join(REPO, "ignition-study-wrapper");

/** The pages that carry page-reload.js, by the id their script tag names (data-page). Nothing outside this list. */
export const PAGES: Readonly<Record<string, string>> = {
  "dashboard.html": join(API_DIR, "dashboard.html"),
  "charts-review.html": join(API_DIR, "charts-review.html"),
  "study/reader-verify.html": join(STATIC, "study", "reader-verify.html"),
  "study/replay-review.html": join(STATIC, "study", "replay-review.html"),
  "study/state-tester.html": join(STATIC, "study", "state-tester.html"),
  // the wrapper's own pages (served on :7700 from ignition-study-wrapper/), which load page-reload.js from this API
  "wrapper/admin.html": join(WRAPPER_PAGES, "admin.html"),
  "wrapper/bridge.html": join(WRAPPER_PAGES, "bridge.html"),
};

/** Where a URL path the API serves lives on disk (routes/studyUi.ts /study/*, index.ts /dashboard.css), else null. */
export function apiAssetFile(urlPath: string, staticDir = STATIC, apiDir = API_DIR): string | null {
  if (urlPath === "/dashboard.css") return join(apiDir, "dashboard.css");
  if (!urlPath.startsWith("/study/")) return null;
  const full = normalize(join(staticDir, urlPath));
  return full.startsWith(staticDir + sep) ? full : null;
}

// "/study/x.js", "/study/x.css" anywhere (a tag, a template string after ${GTOW_API}, an absolute http://...:2000/study/x.js)
const ABS_REF = /\/study\/[\w.\-]+\.(?:js|css)(?![\w.\-])|\/dashboard\.css(?![\w.\-])/g;
// a module's relative import: import ... from "./x.js", import("./x.js"), export ... from "./x.js"
const REL_REF = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[\w.\-\/]+\.js)["']/g;

/** The files one file references (not recursive). Pure: the text in, absolute paths out. */
export function refsOf(file: string, text: string, resolveUrl: (p: string) => string | null = apiAssetFile): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(ABS_REF)) {
    const f = resolveUrl(m[0]);
    if (f) out.add(f);
  }
  if (file.endsWith(".js")) for (const m of text.matchAll(REL_REF)) out.add(resolve(dirname(file), m[1]!));
  out.delete(file);
  return [...out];
}

const sigOf = (file: string): string => {
  try {
    const st = statSync(file);
    return `${st.size}-${Math.round(st.mtimeMs)}`;
  } catch {
    return "missing";
  }
};

const refCache = new Map<string, { sig: string; refs: string[] }>();

/** The file and everything it loads, each with its size-mtime signature. Stops at 64 files (a guard, not a limit seen). */
export function closureOf(entry: string, resolveUrl: (p: string) => string | null = apiAssetFile): { file: string; sig: string }[] {
  const seen = new Map<string, string>();
  const todo = [entry];
  while (todo.length && seen.size < 64) {
    const file = todo.shift()!;
    if (seen.has(file)) continue;
    const sig = sigOf(file);
    seen.set(file, sig);
    if (sig === "missing" || !/\.(?:html|js)$/.test(file)) continue;
    let hit = refCache.get(file);
    if (!hit || hit.sig !== sig) {
      let text = "";
      try { text = readFileSync(file, "utf8"); } catch { /* gone between the stat and the read: no refs this time */ }
      hit = { sig, refs: refsOf(file, text, resolveUrl) };
      refCache.set(file, hit);
    }
    for (const r of hit.refs) if (!seen.has(r)) todo.push(r);
  }
  return [...seen].map(([file, sig]) => ({ file, sig }));
}

/** One short token for a set of signed files: changes when any of them does. */
export function tokenOf(files: { file: string; sig: string }[]): string {
  const h = createHash("sha1");
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) h.update(`${f.file}\0${f.sig}\n`);
  return h.digest("hex").slice(0, 16);
}

/** The token of a registered page (PAGES), or "" for an unknown id. */
export function pageTokenOf(id: string): string {
  const file = PAGES[id];
  return file ? tokenOf(closureOf(file)) : "";
}
