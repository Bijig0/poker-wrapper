/**
 * The JS the wrapper evaluates in the poker client's page. Each snippet lives in src/js/<module>.<NAME>.js,
 * first extracted byte for byte from the Python wrapper (its extractor went with it in 2026-09-24) — several
 * contain backticks in their comments, which a TS template literal cannot hold verbatim. Line endings are
 * normalised to LF on load (Python normalises its source the same way), so a checkout's CRLF cannot change them.
 *
 * A SNIPPET THAT LEAVES CODE RUNNING IN THE PAGE CARRIES ITS VERSION (2026-10-13). Most snippets run once and return,
 * but two install something that keeps running inside the client's page and is installed only when missing: the
 * action watcher (launch.WATCH_JS_TMPL, `__ignWatch` — a 120 ms timer) and the draw heartbeat (launch.TABLE_JS_TMPL,
 * `__wrapperDraw` — a requestAnimationFrame loop). The Ignition window outlives a wrapper relaunch, so a relaunch with
 * new code found the OLD watcher/heartbeat in place and kept it until the table's frame reloaded: the page silently
 * ran code the wrapper no longer had. Such a snippet writes `__VERSION__` where it keeps its version; js() replaces the
 * token with `"<name>@<12 hex of sha256 of the snippet's own text>"`, so any edit to the file is a new version. The
 * snippet installs over a different (or missing — every snippet before this date) version: it stops the old one and
 * keeps a handle `{version, stop()}` itself, so the next upgrade is clean. The hash is of the template as read (LF),
 * before any table is slotted in, so every table's copy of a snippet has the same version.
 * `window.__pwFramePins` (launch.FRAME_JS) is not versioned: it is data — who holds which table tag — that every read
 * evaluates with the CURRENT resolver, no code of its own runs in the page, and a relaunched wrapper needs the pin it
 * held (its table, found again within the minute). A change to that record's shape must keep reading the old shape.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Where a snippet's text names its own version. */
export const VERSION_TOKEN = "__VERSION__";

const cache = new Map<string, string>();
const versions = new Map<string, string>();

/** The version of a snippet's text: its name and the first 12 hex of the text's sha256 (the text with the token in it). */
export function versionOf(name: string, text: string): string {
  return `${name}@${createHash("sha256").update(text.replace(/\r\n/g, "\n"), "utf8").digest("hex").slice(0, 12)}`;
}

/** `text` with its version written in where it names it (a JS string literal), and that version. */
export function withVersion(name: string, text: string): { code: string; version: string } {
  const lf = text.replace(/\r\n/g, "\n");
  const version = versionOf(name, lf);
  return { code: lf.split(VERSION_TOKEN).join(JSON.stringify(version)), version };
}

function load(name: string): string {
  let s = cache.get(name);
  if (s === undefined) {
    const raw = readFileSync(join(import.meta.dir, "js", `${name}.js`), "utf8").replace(/\r\n/g, "\n");
    if (raw.includes(VERSION_TOKEN)) {
      const v = withVersion(name, raw);
      s = v.code;
      versions.set(name, v.version);
    } else {
      s = raw;
    }
    cache.set(name, s);
  }
  return s;
}

export function js(name: string): string {
  return load(name);
}

/** The version js(name) writes into the snippet, or null for a snippet that installs nothing (no `__VERSION__`). */
export function snippetVersion(name: string): string | null {
  load(name);
  return versions.get(name) ?? null;
}
