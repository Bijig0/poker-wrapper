import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTempDir } from "../test/tempDir";
import { localEnvKeyHashes, readStamp, stillRefused, supervisorNeed } from "./supervisorRestart";

/**
 * scripts\supervisor_lib.ps1 + scripts\supervisor_replace.ps1, run for real in PowerShell against a FAKE checkout
 * (__fixtures__/supervisorLibDryRun.ps1): the config re-read, the port refusal, the request guards and the self-replace
 * in -DryRun — the helper only logs what it would do. A made-up USERNAME makes the task name one that does not exist,
 * so even the read-only task lookup never names a live task. Windows only (PowerShell 5.1).
 */
const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
const win = process.platform === "win32";

describe.skipIf(!win)("supervisor_lib.ps1 (PowerShell, dry run)", () => {
  test("re-reads local.env, refuses a port move, guards requests, and dry-runs the self-replace", () => {
    const root = testTempDir("supervisor-restart-");
    mkdirSync(join(root, "config"), { recursive: true });
    copyFileSync(join(REPO, "config", "env.ps1"), join(root, "config", "env.ps1"));
    writeFileSync(join(root, "config", "local.env"), "GTOW_POLL_MS=500\r\n");
    writeFileSync(join(root, "fake-supervisor.ps1"), "# a stand-in supervisor script\r\n");
    // the environment a scheduled task hands over: none of the values the run checks
    const env: Record<string, string> = {};
    const drop = /^(PORT|PORT_OFFSET|HRC_UI_PORT|PANEL_PORT|GTOW_CDP_PORT|CDP_PORT|GTOW_POLL_MS|POKER_ROOT|POKER_SUPERVISOR|STUDY_API_SUPERVISOR|POKER_SUPERVISOR_REPLACED|AUTO_RESTART)$/i;
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !drop.test(k)) env[k] = v;
    env.USERNAME = "supervisor-lib-test";
    const r = Bun.spawnSync(["powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
      join(import.meta.dir, "__fixtures__", "supervisorLibDryRun.ps1"), "-Root", root, "-Lib", join(REPO, "scripts", "supervisor_lib.ps1")],
      { env, stdout: "pipe", stderr: "pipe", timeout: 150_000 });
    const out = r.stdout.toString();
    const v = Object.fromEntries(out.split(/\r?\n/).filter((l) => /^[A-Z]\d?=/.test(l)).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
    const log = (() => { try { return readFileSync(join(root, "sup.log"), "utf8"); } catch { return ""; } })();
    const ctx = `stdout:\n${out}\nstderr:\n${r.stderr.toString()}\nlog:\n${log}`;
    expect(r.exitCode, ctx).toBe(0);

    // started from local.env; the edit is read on the next start although the old value was already in the environment
    expect(v.A1, ctx).toBe("500|2000|True");
    expect(v.A2, ctx).toBe("900|2000|True");
    expect(log).toContain("config re-read before this start: local.env changed (local.env keys: GTOW_POLL_MS)");
    const afterEnv = JSON.parse(readFileSync(join(root, "stamp-after-env.json"), "utf8"));
    expect(afterEnv.protocol).toBe(2);
    expect(afterEnv.reread.length).toBe(2);
    expect(afterEnv.task).toBe("PokerWrapper API - supervisor-lib-test");
    // the PowerShell key hashes are the TypeScript ones (only hashes leave local.env)
    expect(afterEnv.envKeys).toEqual(localEnvKeyHashes("GTOW_POLL_MS=900\r\n"));

    // the port move is refused: the old environment stays, the stamp asks for a fresh supervisor
    expect(v.A3, ctx).toBe("900|2000");
    expect(log).toContain("the port moved (PORT 2000 -> 2010)");
    mkdirSync(join(root, "port"));
    copyFileSync(join(root, "stamp-after-port.json"), join(root, "port", "supervisor-api.json"));
    const portStamp = readStamp("api", join(root, "port"))!;
    expect(String(portStamp.needsReplace)).toContain("port moved");
    const need = supervisorNeed(portStamp);
    expect(need?.kind).toBe("supervisor-changed");

    // a worker found on the port is adopted: re-stamped with this supervisor's pid and the worker's; cleared again
    const stampOf = (file: string) => {
      const d = join(root, file.replace(/\.json$/, ""));
      mkdirSync(d);
      copyFileSync(join(root, file), join(d, "supervisor-api.json"));
      return readStamp("api", d)!;
    };
    const adopted = stampOf("stamp-adopted.json");
    expect(adopted.pid, ctx).toBe(Number(v.P));
    expect(adopted.adopted?.pid, ctx).toBe(54321);
    expect(log).toContain(`adopted worker pid 54321 - stamp re-written with this supervisor's pid ${v.P}`);
    expect(stampOf("stamp-unadopted.json").adopted, ctx).toBeNull();

    // guards: too young, exit 3 without a file, a script that does not parse
    expect(v.R1, ctx).toBe("False|False");
    expect(log).toContain("self-replace REFUSED (study-api.ps1 changed): this supervisor started only");
    expect(v.R2, ctx).toBe("False");
    expect(log).toContain("worker exited 3 but left no request file - a plain relaunch");
    expect(v.R3, ctx).toBe("False");
    expect(log).toMatch(/self-replace REFUSED \(study-api\.ps1 changed\): fake-supervisor\.ps1 does not parse/);
    const refused = JSON.parse(readFileSync(join(root, "stamp-refused.json"), "utf8"));
    expect(String(refused.refused?.why)).toContain("does not parse");
    // fixed since (the fixture rewrote it): no longer the refused content
    expect(stillRefused({ ...refused, refused: { why: refused.refused.why, files: refused.refused.files } })).toBe(false);

    // the dry run: logged on both sides, nothing started, the environment as it was
    expect(v.R4, ctx).toBe("study-api.ps1 changed|False");
    expect(v.H, ctx).toBe("0");
    expect(v.A4, ctx).toBe("900|False");
    expect(log).toContain("supervisor replacing itself: study-api.ps1 changed (asked by test) [DRY RUN]");
    expect(log).toMatch(/\[replace\] helper \(pid \d+\) for api \(study-api\.ps1\)/);
    expect(log).toContain("would wait up to 60 s for pid");
    expect(log).toContain("no scheduled task 'PokerWrapper API - supervisor-lib-test'");
    expect(log).toMatch(/would spawn if the task brings nothing: conhost\.exe --headless powershell\.exe .*-File ".*\\\.claude\\study-api\.ps1"/);
    expect(log).not.toContain("spawned the supervisor directly");
  }, 180_000);
});
