import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBuild, liveStatus, supervisorLine, type ServiceBuild } from "./liveStatus";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "livestatus-")); dirs.push(d); return d; };
const sha = (file: string) => new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex");

const NOW = 1_800_000_000_000;
const build = (over: Partial<ServiceBuild> = {}): ServiceBuild => ({
  ok: true, service: "api", bootAt: NOW - 600_000, commit: "dd69935aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", head: "dd69935aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  stale: false, changedCount: 0, changed: [], changedAt: 0, sig: "", files: 200, scanMs: 3, graphErrors: [],
  supervised: true, auto: { state: "current", why: "", uncommitted: [], checkedAt: NOW },
  ...over,
});

describe("describeBuild", () => {
  test("current: the commit and how long it has been up", () => {
    expect(describeBuild(build(), NOW)).toBe("dd69935 · up 10 min · current");
  });
  test("behind: the auto-restart's own sentence, with its state", () => {
    const b = build({ stale: true, changedCount: 2, changed: ["a.ts", "b.ts"],
      auto: { state: "held", why: "2 committed file(s) changed (a.ts, b.ts); restart held: a poker session is live (s1)", uncommitted: [], checkedAt: NOW } });
    expect(describeBuild(b, NOW)).toBe("dd69935 · up 10 min · BEHIND THE DISK [held] 2 committed file(s) changed (a.ts, b.ts); restart held: a poker session is live (s1)");
  });
  test("behind, before the first auto-restart tick: the files", () => {
    const b = build({ stale: true, changedCount: 4, changed: ["a.ts", "b.ts", "c.ts", "d.ts"] });
    expect(describeBuild(b, NOW)).toBe("dd69935 · up 10 min · BEHIND THE DISK: 4 loaded file(s) changed (a.ts, b.ts, c.ts +1 more)");
  });
});

describe("supervisorLine", () => {
  test("no stamp = unknown, said as such", () => {
    const line = supervisorLine("api", tmp());
    expect(line.pid).toBeNull();
    expect(line.current).toBe(false);
    expect(line.text).toContain("no start stamp");
  });

  test("a running supervisor whose files are as it read them is current; an edited script is behind", () => {
    const dir = tmp();
    const script = join(dir, "study-api.ps1");
    writeFileSync(script, "# v1\r\n");
    // PowerShell 5.1's own writers add a BOM; the reader takes both
    writeFileSync(join(dir, "supervisor-api.json"), "﻿" + JSON.stringify({ name: "api", pid: process.pid, startedAt: "2026-10-03T10:59:04", files: { [script]: sha(script).toUpperCase() } }));
    const ok = supervisorLine("api", dir);
    expect(ok.alive).toBe(true);
    expect(ok.current).toBe(true);
    expect(ok.changed).toEqual([]);

    writeFileSync(script, "# v2\r\n");
    const behind = supervisorLine("api", dir);
    expect(behind.current).toBe(false);
    expect(behind.changed).toEqual([script]);
    expect(behind.text).toContain("BEHIND THE DISK");
  });

  test("a stamp left by a supervisor that is gone says not running", () => {
    const dir = tmp();
    // a pid no process has: the child has exited by the time it is asked about
    const gone = Bun.spawnSync([process.execPath, "-e", "console.log(process.pid)"]).stdout.toString().trim();
    writeFileSync(join(dir, "supervisor-charts.json"), JSON.stringify({ name: "charts", pid: Number(gone), startedAt: "2026-10-03T10:59:04", files: {} }));
    const line = supervisorLine("charts", dir);
    expect(line.alive).toBe(false);
    expect(line.current).toBe(false);
    expect(line.text).toContain("not running");
  });
});

describe("liveStatus", () => {
  // ports nothing listens on: PORT_OFFSET moves the whole install (api 33000, charts 39777, panel 38700)
  const ENV = { PORT_OFFSET: "31000" };

  test("the asking process answers for itself: its line is its own build, marked self, on the install's port", async () => {
    const s = await liveStatus({ port: 38700, build: build({ service: "wrapper" }) }, ENV);
    expect(s.services.map((x) => [x.name, x.up, !!x.self])).toEqual([["api", false, false], ["charts", false, false], ["wrapper", true, true]]);
    expect(s.head).toBe("dd69935aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    // the API and the chart server are down: that is not "current"
    expect(s.current).toBe(false);
  }, 30_000);

  test("a process on a port of its own (a rig, a verify API) is listed as this one, beside the install's lines", async () => {
    const s = await liveStatus({ port: 38795, build: build({ service: "wrapper", stale: true, changedCount: 1, changed: ["a.ts"] }) }, ENV);
    const me = s.services.find((x) => x.self)!;
    expect(me.name).toBe("wrapper :38795 (this one)");
    expect(me.current).toBe(false);
    expect(s.services.filter((x) => x.name === "wrapper").length).toBe(0);
  }, 30_000);

  test("the chart factory's API is a line, and its supervisor one, only where FACTORY_API_URL names it", async () => {
    const sup = { name: "factory", pid: 4242, alive: true, startedAt: "2026-10-03T21:00:00", changed: ["x.ps1"], current: false, text: "pid 4242 · BEHIND THE DISK: x.ps1" };
    const srv = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.json({ ...build({ service: "factory" }), supervisor: sup }) });
    try {
      const s = await liveStatus(null, { ...ENV, FACTORY_API_URL: `http://127.0.0.1:${srv.port}/` });
      const f = s.services.find((x) => x.name === "factory")!;
      expect([f.up, f.current, f.port]).toEqual([true, true, Number(srv.port)]);
      expect(s.supervisors.find((x) => x.name === "factory")?.changed).toEqual(["x.ps1"]);
      expect(s.current).toBe(false);
      const none = await liveStatus(null, ENV);
      expect(none.services.some((x) => x.name === "factory")).toBe(false);
    } finally { srv.stop(true); }
  }, 30_000);
});
