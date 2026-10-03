/**
 * WHAT IS LIVE — one line per running service: which commit it runs and whether it is behind the code on disk.
 *
 *   bun setup/live.ts              print it; exit 0 when everything running is current, 1 when something is behind
 *   bun setup/live.ts --wait [s]   after a merge: wait (default 120 s) for the services to pick the commit up, then print
 *   bun setup/live.ts --json       the raw answer (services/liveStatus.ts)
 *
 * Why (2026-10-03): the services read their code once, at start. "Fixed" used to mean "the file on disk is right",
 * while the process answering the table was still the old one — or the fix was on a branch that never reached main.
 * A commit on main that changes code a service loaded now restarts it by itself (services/autoRestart.ts: when no
 * session is live); this is where to SEE that it happened, and what is in the way when it has not:
 *   settling           the change landed seconds ago — it restarts in a moment
 *   held               a poker session is live — it restarts when the session ends
 *   uncommitted        only uncommitted edits differ — never picked up by themselves: commit them to main
 *   boot-check-failed  the code on disk does not build — the old process keeps serving
 *   unsupervised       nothing would relaunch it (a hand-started process; the wrapper: relaunch it)
 * It also lists what is NOT on main — branches with commits main lacks, and uncommitted files in this checkout —
 * because none of that is live either.
 *
 * Read-only: it asks each service for its own /build and reads the supervisors' start stamps. It starts nothing.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { liveStatus, type LiveStatus } from "../gto-trainer/apps/api/src/services/liveStatus";

const ROOT = resolve(import.meta.dir, "..");
const argv = process.argv.slice(2);
const JSON_OUT = argv.includes("--json");
const waitAt = argv.indexOf("--wait");
const WAIT_S = waitAt < 0 ? 0 : /^\d+$/.test(argv[waitAt + 1] ?? "") ? Number(argv[waitAt + 1]) : 120;

// the install's ports: PORT_OFFSET lives in config/local.env (config/env.ps1 hands it to the services)
if (!process.env.PORT_OFFSET) {
  try {
    const m = /^\s*PORT_OFFSET\s*=\s*"?(\d+)/m.exec(readFileSync(join(ROOT, "config", "local.env"), "utf8"));
    if (m) process.env.PORT_OFFSET = m[1];
  } catch { /* no local.env: the default ports */ }
}

const git = (...args: string[]): string | null => {
  const r = spawnSync("git", ["-C", ROOT, ...args], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  // the END only: a porcelain status line starts with a space (" M path"), and trimming it shifts the path by one
  return r.status === 0 ? r.stdout.replace(/\s+$/, "") : null;
};

/** What is not on main, so not live: branches ahead of it, and uncommitted files in this checkout. */
function notOnMain(): string[] {
  if (!existsSync(join(ROOT, ".git"))) return [];
  const out: string[] = [];
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch && branch !== "main") out.push(`this checkout is on "${branch}", not main — the live services run the main checkout`);
  for (const b of (git("for-each-ref", "refs/heads", "--format=%(refname:short)") ?? "").split(/\r?\n/).filter((x) => x && x !== "main")) {
    const n = Number(git("rev-list", "--count", `main..${b}`) ?? 0);
    if (n > 0) out.push(`branch ${b}: ${n} commit(s) not merged into main (last ${git("log", "-1", "--format=%cd", "--date=short", b) ?? "?"})`);
  }
  const dirty = (git("status", "--porcelain") ?? "").split(/\r?\n/).filter(Boolean);
  if (dirty.length) {
    out.push(`${dirty.length} uncommitted file(s) in this checkout: ${dirty.slice(0, 4).map((l) => l.slice(3)).join(", ")}${dirty.length > 4 ? ` +${dirty.length - 4} more` : ""}`);
  }
  return out;
}

/**
 * Something is on its way to a restart, so time alone will change the answer: a service that is behind and about to
 * go (settling / restarting / not looked yet), or the API or chart server in the gap between exit and relaunch.
 * A line that will NOT change by itself — a wrapper left open, an uncommitted edit, a held restart — is not waited for.
 */
const onItsWay = (s: LiveStatus) => s.services.some((x) =>
  (!x.up && (x.name === "api" || x.name === "charts")) ||
  (x.up && !x.current && !!x.build && ["settling", "restarting", "current"].includes(x.build.auto?.state)));

function print(s: LiveStatus): void {
  const w = Math.max(...s.services.map((x) => x.name.length), 10);
  console.log(`What is live — ${ROOT} @ ${(git("rev-parse", "--short", "HEAD") ?? s.head?.slice(0, 7) ?? "?")} (${git("rev-parse", "--abbrev-ref", "HEAD") ?? "?"})`);
  for (const x of s.services) console.log(`  ${x.current ? "ok " : x.up ? "OLD" : "-- "} ${x.name.padEnd(w)} :${String(x.port).padEnd(5)} ${x.text}`);
  if (!s.services.some((x) => x.name === "wrapper")) console.log(`  --  ${"wrapper".padEnd(w)}        not running (a launch always loads the code on disk)`);
  for (const x of s.supervisors) console.log(`  ${x.current ? "ok " : x.pid === null ? "?? " : "OLD"} ${`supervisor: ${x.name}`.padEnd(w + 7)} ${x.text}`);
  const off = notOnMain();
  if (off.length) {
    console.log("Not on main, so not live:");
    for (const l of off) console.log(`  ${l}`);
  }
  console.log(s.current ? "Everything running is on the code on disk." : "SOMETHING IS BEHIND THE CODE ON DISK (the OLD lines above say why).");
}

let s = await liveStatus();
// --wait: a service says it is behind the moment the files change, so nothing on its way at the first look means
// nothing this merge touched is loaded by a service that restarts itself. Otherwise wait for those to come back.
const until = Date.now() + WAIT_S * 1000;
while (onItsWay(s) && Date.now() < until) {
  await Bun.sleep(3_000);
  s = await liveStatus();
}
if (JSON_OUT) console.log(JSON.stringify(s, null, 2));
else print(s);
process.exit(s.current ? 0 : 1);
