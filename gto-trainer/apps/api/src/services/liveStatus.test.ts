import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeBuild, supervisorLine, type ServiceBuild } from "./liveStatus";

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
