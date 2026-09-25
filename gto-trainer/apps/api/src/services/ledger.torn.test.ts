import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fp, loadLedger, updateLedger } from "./ledger";

/**
 * data/ledger.json is written in place by other processes (poker-zenbook's linuxShardJob.ts points a box at its shard,
 * hand edits) while the API reads it. On 2026-09-25 19:46Z a read landed mid-write and GET /api/ledger answered 500
 * ("JSON Parse error: Unexpected EOF" in loadLedger). And every artifact was re-hashed per proposal detail — the 23 MB
 * mes_postflop.json ~36 times a request, 3-13 s of blocked event loop per 7 s poll.
 */
const dir = mkdtempSync(join(tmpdir(), "ledger-torn-"));
const prev = process.env.LEDGER_PATH;
const ledger = (id: string) => ({ formats: [], trees: {}, configs: [{ id, status: "planned" }], sources: {}, plans: [], proposals: [{ id: "p1", approved: null }] });
let tick = Date.now() / 1000;
/** write + move the mtime on, so a same-millisecond rewrite still reads as a change */
const put = (path: string, body: string) => { writeFileSync(path, body); tick += 5; utimesSync(path, tick, tick); };

beforeAll(() => { process.env.LEDGER_PATH = join(dir, "ledger.json"); });
afterAll(() => {
  if (prev === undefined) delete process.env.LEDGER_PATH; else process.env.LEDGER_PATH = prev;
  rmSync(dir, { recursive: true, force: true });
});

describe("loadLedger: a read that lands mid-write", () => {
  test("serves the last good read, then the new file once it parses", () => {
    const path = process.env.LEDGER_PATH!;
    put(path, JSON.stringify(ledger("a")));
    expect(loadLedger().configs[0]!.id).toBe("a");
    const full = JSON.stringify(ledger("b"), null, 2);
    put(path, full.slice(0, Math.floor(full.length / 2)));          // half a file: the writer is mid-write
    expect(loadLedger().configs[0]!.id).toBe("a");
    put(path, full);                                                  // the write finished
    expect(loadLedger().configs[0]!.id).toBe("b");
  });

  test("a first read with nothing good to fall back on still throws", () => {
    process.env.LEDGER_PATH = join(dir, "other.json");
    try {
      put(process.env.LEDGER_PATH, '{"formats": [');
      expect(() => loadLedger()).toThrow();
    } finally { process.env.LEDGER_PATH = join(dir, "ledger.json"); }
  });
});

describe("updateLedger: temp file + rename", () => {
  test("the change lands, nothing is left beside the ledger, and loadLedger sees it", () => {
    const path = process.env.LEDGER_PATH!;
    put(path, JSON.stringify(ledger("c"), null, 2) + "\n");
    expect(loadLedger().configs[0]!.id).toBe("c");
    const found = updateLedger((L) => { const P = L.proposals!.find((x) => x.id === "p1"); if (P) P.approved = { at: "2026-09-26T00:00:00Z" }; return !!P; });
    expect(found).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf-8")).proposals[0].approved).toEqual({ at: "2026-09-26T00:00:00Z" });
    expect(readFileSync(path, "utf-8").endsWith("}\n")).toBe(true);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(loadLedger().proposals![0]!.approved).toEqual({ at: "2026-09-26T00:00:00Z" });
  });

  test("reads the file fresh, not the cache: another writer's change is kept", () => {
    const path = process.env.LEDGER_PATH!;
    put(path, JSON.stringify(ledger("d")));
    expect(loadLedger().configs[0]!.id).toBe("d");
    const other = ledger("d"); other.configs.push({ id: "from-another-process", status: "planned" });
    writeFileSync(path, JSON.stringify(other));                       // no mtime bump: the cache may still look current
    updateLedger((L) => { L.configs[0]!.status = "done"; });
    const L = JSON.parse(readFileSync(path, "utf-8"));
    expect(L.configs.map((c: { id: string }) => c.id)).toEqual(["d", "from-another-process"]);
    expect(L.configs[0].status).toBe("done");
  });
});

describe("fp: the sha256 is re-hashed only when the file moves", () => {
  test("same file → same hash; a rewrite → the new content's hash", () => {
    const path = join(dir, "artifact.json");
    put(path, '{"v":1}');
    const a = fp("x", path);
    expect(a.exists).toBe(true);
    expect(fp("x", path).sha256).toBe(a.sha256!);
    put(path, '{"v":2}');                                             // same size, new mtime
    const b = fp("x", path);
    expect(b.sha256).not.toBe(a.sha256);
    expect(b.sha256).toBe(new Bun.CryptoHasher("sha256").update('{"v":2}').digest("hex").slice(0, 16));
  });

  test("a missing file is not an artifact", () => {
    expect(fp("x", join(dir, "nope.json"))).toMatchObject({ exists: false, sha256: null });
  });
});
