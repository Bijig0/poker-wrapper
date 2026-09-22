import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * dashboard.html is ~4,000 lines of inline JavaScript with NO build step: nothing parses it
 * between an edit and the browser, so a syntax slip ships as a blank page. It happened on
 * 2026-09-20 — a `??` mixed with `||` without parentheses, which is a SyntaxError rather
 * than a runtime one, so the whole script block failed to evaluate and the router never ran;
 * the page rendered the default view and looked merely "wrong" instead of broken.
 *
 * Parsing costs milliseconds. `new Function(body)` compiles without executing, which is
 * exactly the check the browser does first.
 */
const PAGE = join(import.meta.dir, "..", "dashboard.html");

describe("dashboard.html", () => {
  const html = readFileSync(PAGE, "utf-8");
  const blocks = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];

  test("has inline script blocks to check", () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  for (const [i, m] of blocks.entries()) {
    const startLine = html.slice(0, m.index).split("\n").length;
    test(`inline script #${i + 1} (line ${startLine}) parses`, () => {
      expect(() => new Function(m[1]!)).not.toThrow();
    });
  }

  test("every 13x13 grid goes through classGrid", () => {
    // Two hand-rolled `#grid` builders in the Playthrough tab were the reason the suitedness
    // label and the combo panel were not uniform. One implementation, one behaviour.
    expect(html).not.toMatch(/<div id="grid">/);
  });
});
