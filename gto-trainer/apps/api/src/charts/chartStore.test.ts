import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChartStore, GTOW_SOLUTION, type ChartStoreOpts } from "./chartStore";
import { chartServerFetch } from "./chartServer";

const gz = (o: unknown) => Bun.gzipSync(new TextEncoder().encode(JSON.stringify(o)));
function chart(dir: string, id: string, nodes: Record<string, unknown>, { body = true, pad = 0 } = {}) {
  const meta = { id, label: id };
  writeFileSync(join(dir, `${id}.meta.json`), JSON.stringify(meta));
  const doc = { meta, nodes, pad: randomBytes(pad).toString("base64") };
  if (body) writeFileSync(join(dir, `${id}.json.gz`), gz(doc));
  return doc;
}
function store(dir: string, o: Partial<ChartStoreOpts> = {}) {
  return new ChartStore({ dir, remote: "", bigMax: 2, smallMax: 2, smallBytes: 1024, diskCapBytes: 1e12, pinnedPrefixes: [],
                          preflopDb: join(dir, "none.sqlite"), log: () => {}, ...o });
}
const q = (s: Record<string, string>) => new URLSearchParams(s);

describe("ChartStore", () => {
  test("lists the GTOW crawl first, then every sidecar", () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    chart(d, "a", {}); chart(d, "b", {}, { body: false });
    const s = store(d).solutions();
    expect(s[0]).toEqual(GTOW_SOLUTION);
    expect(s.slice(1).map((m) => m.id).sort()).toEqual(["a", "b"]);
  });

  test("a node by line; a missing line names its neighbours; an unknown chart says so", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    chart(d, "hu", { "": { ok: true, n: 0 }, "R2": { ok: true, n: 1 }, "R2-C": { ok: true, n: 2 } });
    const s = store(d);
    expect(await s.node(q({ source: "hu", line: "R2" }))).toEqual({ ok: true, n: 1 });
    expect(await s.node(q({ source: "hu", line: "R2-F" }))).toEqual({ ok: false, error: "line not in solution", near: [] });
    expect(await s.node(q({ source: "hu", line: "R" }))).toEqual({ ok: false, error: "line not in solution", near: [] });
    expect(await s.node(q({ source: "hu", line: "" }))).toEqual({ ok: true, n: 0 });
    expect(await s.node(q({ source: "nope", line: "" }))).toEqual({ ok: false, error: "unknown solution 'nope'" });
    expect(((await s.node(q({ line: "" }))) as any).error).toMatch(/^preflop DB not found/);
  });

  test("a body only in R2 is fetched ONCE for concurrent asks, then read from disk", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    const doc = chart(d, "cold", { "": { ok: true } }, { body: false });
    let fetches = 0;
    const s = store(d, {
      fetchBody: async (_sid, dest) => { fetches++; await Bun.sleep(20); writeFileSync(dest, gz(doc)); return true; },
    });
    const got = await Promise.all([1, 2, 3].map(() => s.node(q({ source: "cold", line: "" }))));
    expect(got).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(fetches).toBe(1);
    expect(existsSync(join(d, "cold.json.gz"))).toBe(true);
    expect(existsSync(join(d, "cold.json.gz.part"))).toBe(false);
  });

  test("a failed download leaves nothing behind and answers unknown", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    chart(d, "gone", {}, { body: false });
    const s = store(d, { fetchBody: async (_sid, dest) => { writeFileSync(dest, ""); return false; } });
    expect(await s.node(q({ source: "gone", line: "" }))).toEqual({ ok: false, error: "unknown solution 'gone'" });
    expect(existsSync(join(d, "gone.json.gz.part"))).toBe(false);
  });

  test("small bodies have their own LRU: walking heads-up rungs never pushes a big tree out", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    chart(d, "big1", {}, { pad: 50_000 }); chart(d, "big2", {}, { pad: 50_000 });
    for (const r of ["hu1", "hu2", "hu3"]) chart(d, r, {});
    const s = store(d, { smallBytes: 1024 });
    for (const id of ["big1", "big2", "hu1", "hu2", "hu3"]) await s.doc(id);
    expect(s.resident()).toEqual({ big: ["big1", "big2"], small: ["hu2", "hu3"] });
  });

  test("disk eviction drops only R2-confirmed, unpinned, big, not-just-fetched bodies — and nothing when R2 is unlistable", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    for (const id of ["old_in_r2", "pin_x", "local_only", "keep"]) chart(d, id, {}, { pad: 50_000 });
    chart(d, "tiny", {});
    const size = (id: string) => Bun.file(join(d, `${id}.json.gz`)).size;
    const cap = size("keep") + size("tiny") + 10;
    const listed = new Set(["old_in_r2.json.gz", "pin_x.json.gz", "keep.json.gz", "tiny.json.gz"]);
    await store(d, { diskCapBytes: cap, listRemote: async () => null }).evictDisk();
    expect(existsSync(join(d, "old_in_r2.json.gz"))).toBe(true);
    await store(d, { diskCapBytes: cap, pinnedPrefixes: ["pin_"], listRemote: async () => listed }).evictDisk(join(d, "keep.json.gz"));
    expect(["old_in_r2", "pin_x", "local_only", "keep", "tiny"].filter((id) => existsSync(join(d, `${id}.json.gz`))))
      .toEqual(["pin_x", "local_only", "keep", "tiny"]);
  });

  test("HTTP: liveness, index, node, 404", async () => {
    const d = mkdtempSync(join(tmpdir(), "charts-"));
    chart(d, "hu", { "": { ok: true } });
    const f = chartServerFetch(store(d));
    expect((await f(new Request("http://x/"))).status).toBe(200);
    expect(await (await f(new Request("http://x/api/progress"))).json()).toEqual({});
    expect((await (await f(new Request("http://x/api/solutions"))).json()).length).toBe(2);
    expect(await (await f(new Request("http://x/api/preflop/node?source=hu&line="))).json()).toEqual({ ok: true });
    expect((await f(new Request("http://x/api/nope"))).status).toBe(404);
  });
});
