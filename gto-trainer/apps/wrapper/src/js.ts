/**
 * The JS the wrapper evaluates in the poker client's page. Each snippet lives in src/js/<module>.<NAME>.js,
 * extracted byte for byte from the Python wrapper (ignition-study-wrapper/tests/golden/extract_js.py) — several
 * contain backticks in their comments, which a TS template literal cannot hold verbatim. Line endings are
 * normalised to LF on load (Python normalises its source the same way), so a checkout's CRLF cannot change them.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const cache = new Map<string, string>();

export function js(name: string): string {
  let s = cache.get(name);
  if (s === undefined) {
    s = readFileSync(join(import.meta.dir, "js", `${name}.js`), "utf8").replace(/\r\n/g, "\n");
    cache.set(name, s);
  }
  return s;
}
