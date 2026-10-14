/** storedIgnitionRecord: the wrapper's saved copy of a record, read with no wrapper up (scripts/hhRecheck.ts). Under
 *  bun test the data root is the test sandbox, so the record dir is written inside it and emptied again here. */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storedIgnitionRecord } from "./ignitionRecord";
import { dataLayout, ignitionHhDir } from "./storePaths";
import { parseIgnitionHh } from "../utils/ignitionHh/ignitionHh";
import { record4923636936 } from "../utils/ignitionHh/fixtures";

const dir = ignitionHhDir();
if (dataLayout().mode !== "test") throw new Error(`the record dir must be the test sandbox's, not ${dir}`);
mkdirSync(dir, { recursive: true });
const saved = join(dir, "4923636936.json");
writeFileSync(saved, JSON.stringify({ ok: true, handId: "4923636936", format: "cash", fetchedAt: "2026-10-09T17:50:00.000Z", body: record4923636936 }));
const torn = join(dir, "4923636937.json");
writeFileSync(torn, "{ not json");
afterAll(() => { rmSync(saved, { force: true }); rmSync(torn, { force: true }); });

describe("storedIgnitionRecord", () => {
  test("a saved record comes back as a cached fetch result, its body as the wrapper stored it", () => {
    const rec = storedIgnitionRecord("4923636936");
    expect(rec).toMatchObject({ ok: true, cached: true, fetchedAt: "2026-10-09T17:50:00.000Z" });
    expect(parseIgnitionHh(rec!.body).actions).toHaveLength(8);
  });
  test("never fetched, unreadable, or not a hand number: null — nothing is fetched here", () => {
    expect(storedIgnitionRecord("4923636999")).toBeNull();
    expect(storedIgnitionRecord("4923636937")).toBeNull();
    expect(storedIgnitionRecord("../4923636936")).toBeNull();
  });
});
