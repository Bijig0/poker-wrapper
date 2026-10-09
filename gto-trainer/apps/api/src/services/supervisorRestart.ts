import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * SUPERVISORS PICK UP THEIR OWN CONFIG (2026-10-10).
 *
 * A supervisor (.claude/study-api.ps1, .claude/chart-server.ps1, scripts/gtow_watchdog.ps1) used to read its script,
 * config/env.ps1 and config/local.env ONCE, at start, so a local.env edit sat unread until someone restarted it by hand
 * — and the setup page said "BEHIND THE DISK … restart the supervisor" until they did. Now (stamp protocol 2):
 *
 *   - the API and chart-server supervisors RE-READ config/env.ps1 + config/local.env before every worker start
 *     (scripts/supervisor_lib.ps1 Update-SupervisorConfig) — except the port: a port change is refused there and
 *     marked `needsReplace` in the stamp;
 *   - the worker watches the files in its supervisor's stamp (data/jobs/supervisor-<name>.json) on its auto-restart
 *     cadence (services/autoRestart.ts) and, when no session is live:
 *       env-changed         only re-read files changed (env.ps1 / local.env, no port key): a plain clean exit (0) —
 *                           the supervisor re-reads them before the next start;
 *       supervisor-changed  the supervisor's own script / its lib changed, a port key changed, or the stamp says
 *                           `needsReplace`: the worker writes the REQUEST FILE data/jobs/supervisor-<name>.replace.json
 *                           and exits with SUPERVISOR_REPLACE_EXIT (3). The supervisor acts on the FILE (the exit code
 *                           is for its log): it replaces itself (scripts/supervisor_replace.ps1) and exits 0;
 *   - the GTO Wizard watchdog has no worker: the API writes its request file and the watchdog checks for it every
 *     minute.
 *
 * Loop guards: one request per supervisor per COOLDOWN_MS (data/jobs/supervisor-<name>.replace-last.json, written for
 * both kinds); the change must have been quiet for settleMs; the worker must have been up MIN_UPTIME_MS; the
 * supervisor refuses a request in its own first 2 minutes. A supervisor whose stamp has no protocol 2 (started from
 * an older script) is only reported — it would treat the exit as a crash and relaunch into the same change.
 *
 * Same file in the chart factory's checkout (poker) as autoRestart.ts / liveStatus.ts: keep the copies identical.
 */

/** The stamp protocol a supervisor that re-reads its config and replaces itself writes. */
export const SUPERVISOR_PROTOCOL = 2;
/** The worker's exit code beside a supervisor-replace request (the request file is the signal; this is for the log). */
export const SUPERVISOR_REPLACE_EXIT = 3;
export const COOLDOWN_MS = 5 * 60_000;
export const MIN_UPTIME_MS = 60_000;
/** config/env.ps1's port table (services/ports.ts): a change to any of these is a supervisor-level change. */
export const PORT_KEYS = ["PORT_OFFSET", "PORT", "HRC_UI_PORT", "PANEL_PORT", "GTOW_CDP_PORT", "GTOW_SECONDARY_CDP_PORT", "CDP_PORT"];

/** <repo>, from <repo>/gto-trainer/apps/api/src/services. */
const REPO = resolve(import.meta.dir, "..", "..", "..", "..", "..");
/** The jobs dir the supervisors write their stamps into. */
export const JOBS_DIR = resolve(import.meta.dir, "..", "..", "data", "jobs");

export interface SupervisorStamp {
  name: string;
  pid: number | null;
  startedAt: string | null;
  /** when its config was last (re-)read */
  envReadAt: string | null;
  /** 0 = an older supervisor that reads everything once and cannot replace itself */
  protocol: number;
  /** absolute path → sha256 of what it read ("absent" = the file did not exist) */
  files: Record<string, string>;
  /** the files it re-reads before every worker start (absolute) */
  reread: string[];
  /** local.env key → short hash of its value, as read (never the values) */
  envKeys: Record<string, string> | null;
  /** the supervisor refused a re-read (a port moved): only a fresh supervisor can take it */
  needsReplace: string | null;
  /** its scheduled task's name */
  task: string | null;
  /** it refused a re-read or a self-replace because a file would not parse: why, and the files as they were then */
  refused: { why: string; files: Record<string, string> } | null;
}

export const stampPath = (name: string, jobsDir = JOBS_DIR) => join(jobsDir, `supervisor-${name}.json`);
export const requestPath = (name: string, jobsDir = JOBS_DIR) => join(jobsDir, `supervisor-${name}.replace.json`);
export const lastRequestPath = (name: string, jobsDir = JOBS_DIR) => join(jobsDir, `supervisor-${name}.replace-last.json`);

const readJson = (file: string): any => {
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
};

export function readStamp(name: string, jobsDir = JOBS_DIR): SupervisorStamp | null {
  const j = readJson(stampPath(name, jobsDir));
  if (!j || typeof j !== "object") return null;
  return {
    name: String(j.name ?? name),
    pid: Number(j.pid) || null,
    startedAt: j.startedAt ?? null,
    envReadAt: j.envReadAt ?? null,
    protocol: Number(j.protocol) || 0,
    files: j.files && typeof j.files === "object" ? j.files : {},
    reread: Array.isArray(j.reread) ? j.reread.map(String) : typeof j.reread === "string" ? [j.reread] : [],
    envKeys: j.envKeys && typeof j.envKeys === "object" ? j.envKeys : null,
    needsReplace: j.needsReplace ? String(j.needsReplace) : null,
    task: j.task ? String(j.task) : null,
    refused: j.refused && typeof j.refused === "object" && j.refused.why ? { why: String(j.refused.why), files: j.refused.files ?? {} } : null,
  };
}

export const sha256File = (file: string): string | null => {
  try { return new Bun.CryptoHasher("sha256").update(readFileSync(file)).digest("hex").toLowerCase(); } catch { return null; }
};

/** A path for a person: relative to the checkout, forward slashes. */
export const relPath = (file: string): string =>
  /^[\\/]/.test(file.slice(REPO.length, REPO.length + 1)) && file.slice(0, REPO.length).toLowerCase() === REPO.toLowerCase()
    ? file.slice(REPO.length + 1).replace(/\\/g, "/") : file;

/**
 * local.env's keys the way config/env.ps1 reads them (a trailing " # comment" dropped, blank values ignored, the
 * FIRST line for a key wins) → the first 16 hex of sha256(value). The supervisor writes the same map into its stamp
 * (scripts/supervisor_lib.ps1 Get-LocalEnvKeyHashes); only hashes ever leave the file.
 */
export function localEnvKeyHashes(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const l = line.replace(/\s+#.*$/, "").trim();
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (!l || l.startsWith("#") || !m) continue;
    const v = m[2].trim().replace(/^"+|"+$/g, "");
    if (!v || m[1].toUpperCase() in upperKeys(out)) continue;
    out[m[1]] = new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 16);
  }
  return out;
}
const upperKeys = (o: Record<string, string>) => Object.fromEntries(Object.keys(o).map((k) => [k.toUpperCase(), 1]));

/** The keys whose value differs between two key-hash maps (added, removed or changed). */
export function changedKeys(was: Record<string, string>, now: Record<string, string>): string[] {
  const up = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k.toUpperCase(), v]));
  const a = up(was), b = up(now);
  return [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).sort();
}

export type NeedKind = "env-changed" | "supervisor-changed";

export interface SupervisorNeed {
  kind: NeedKind;
  /** changed files, relative */
  files: string[];
  /** local.env keys that changed (when the stamp carries key hashes) */
  keys: string[];
  /** the disk as it is now: the same change is one request, a further edit is a new one */
  sig: string;
  /** e.g. "config/local.env changed (keys: GTOW_POLL_MS)" */
  why: string;
}

const isLocalEnv = (f: string) => /[\\/]config[\\/]local\.env$/i.test(f);

/** What the disk says this supervisor is missing, or null when it read what is there now. */
export function supervisorNeed(stamp: SupervisorStamp, hash: (f: string) => string | null = sha256File): SupervisorNeed | null {
  const changed: string[] = [];
  const now: string[] = [];
  for (const [file, was] of Object.entries(stamp.files)) {
    const h = hash(file);
    now.push(`${file}=${h ?? "absent"}`);
    if ((h ?? "absent") !== String(was).toLowerCase()) changed.push(file);
  }
  if (!changed.length && !stamp.needsReplace) return null;
  let keys: string[] = [];
  const envFile = changed.find(isLocalEnv);
  if (envFile && stamp.envKeys) {
    let text = "";
    try { text = readFileSync(envFile, "utf8"); } catch { /* removed: every key it had changed */ }
    keys = changedKeys(stamp.envKeys, localEnvKeyHashes(text));
  }
  const reread = new Set(stamp.reread.map((f) => f.toLowerCase()));
  const portKeys = keys.filter((k) => PORT_KEYS.includes(k));
  const scriptChanged = changed.filter((f) => !reread.has(f.toLowerCase()));
  const kind: NeedKind = stamp.needsReplace || scriptChanged.length || portKeys.length ? "supervisor-changed" : "env-changed";
  const parts = changed.map((f) => (isLocalEnv(f) && keys.length ? `${relPath(f)} (keys: ${keys.join(", ")})` : relPath(f)));
  const why = [parts.length ? `${parts.join(", ")} changed` : "", stamp.needsReplace ?? ""].filter(Boolean).join("; ");
  return { kind, files: changed.map(relPath), keys, sig: now.sort().join("|") + (stamp.needsReplace ? `|${stamp.needsReplace}` : ""), why };
}

/** The supervisor refused exactly the files that are on disk now (a further edit is worth another try). */
export function stillRefused(stamp: SupervisorStamp, hash: (f: string) => string | null = sha256File): boolean {
  const r = stamp.refused;
  if (!r) return false;
  const files = Object.entries(r.files);
  return files.length > 0 && files.every(([f, was]) => (hash(f) ?? "absent") === String(was).toLowerCase());
}

export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (e: any) { return e?.code === "EPERM"; }
}

export type WatchState =
  | "current"   // it read what is on disk
  | "unknown"   // no stamp, a stamp from another process, or it is not running: nothing to ask for
  | "old"       // behind, but its script predates protocol 2: restart it by hand once
  | "settling"  // the change is seconds old: wait for it to be quiet
  | "cooldown"  // a request for this supervisor went out less than COOLDOWN_MS ago (loop guard)
  | "refused"   // it refused this very change (a file would not parse): nothing is asked until the files change again
  | "ready";    // behind and free to be acted on (the caller still asks whether a session is live)

export interface WatchCheck {
  state: WatchState;
  need: SupervisorNeed | null;
  stamp: SupervisorStamp | null;
}

export interface SupervisorWatchOpts {
  name: string;
  jobsDir?: string;
  /** the supervisor that runs THIS process (POKER_SUPERVISOR): its stamp must carry that pid. Unset = a foreign
   *  supervisor (the watchdog, asked for by the API): its pid must be alive. */
  ownPid?: () => number | null;
  now?: () => number;
  hash?: (f: string) => string | null;
  alive?: (pid: number) => boolean;
  settleMs?: number;
  cooldownMs?: number;
}

/** One supervisor's stamp against the disk, with the settle + cooldown guards and the request file. */
export class SupervisorWatch {
  readonly name: string;
  readonly jobsDir: string;
  private seen: { sig: string; at: number } | null = null;
  private readonly o: Required<Omit<SupervisorWatchOpts, "ownPid" | "jobsDir">> & { ownPid?: () => number | null };

  constructor(opts: SupervisorWatchOpts) {
    this.name = opts.name;
    this.jobsDir = opts.jobsDir ?? JOBS_DIR;
    this.o = { now: Date.now, hash: sha256File, alive: pidAlive, settleMs: 20_000, cooldownMs: COOLDOWN_MS, ...opts };
  }

  get own(): boolean { return !!this.o.ownPid; }

  check(): WatchCheck {
    const stamp = readStamp(this.name, this.jobsDir);
    if (!stamp || !stamp.pid) return { state: "unknown", need: null, stamp };
    if (this.o.ownPid ? stamp.pid !== this.o.ownPid() : !this.o.alive(stamp.pid)) return { state: "unknown", need: null, stamp };
    const need = supervisorNeed(stamp, this.o.hash);
    if (!need) { this.seen = null; return { state: "current", need, stamp }; }
    if (stamp.protocol < SUPERVISOR_PROTOCOL) return { state: "old", need, stamp };
    if (stillRefused(stamp, this.o.hash)) return { state: "refused", need, stamp };
    const now = this.o.now();
    if (this.seen?.sig !== need.sig) this.seen = { sig: need.sig, at: now };
    if (now - this.seen.at < this.o.settleMs) return { state: "settling", need, stamp };
    const last = Number(readJson(lastRequestPath(this.name, this.jobsDir))?.at) || 0;
    if (now - last < this.o.cooldownMs) return { state: "cooldown", need, stamp };
    return { state: "ready", need, stamp };
  }

  /** ms since the last request for this supervisor (Infinity when none) */
  sinceLastRequest(): number {
    const last = Number(readJson(lastRequestPath(this.name, this.jobsDir))?.at) || 0;
    return last ? this.o.now() - last : Infinity;
  }

  /**
   * Record that this change is being acted on (the loop guard) and, for a supervisor-level change, write the request
   * file the supervisor acts on. Returns null, or why it could not (then nothing may exit).
   */
  request(c: WatchCheck, by: string): string | null {
    if (!c.need || !c.stamp) return "nothing to request";
    const at = this.o.now();
    const body = { name: this.name, supervisorPid: c.stamp.pid, kind: c.need.kind, why: c.need.why, files: c.need.files, keys: c.need.keys,
      at, atIso: new Date(at).toISOString(), by };
    try {
      writeAtomic(lastRequestPath(this.name, this.jobsDir), JSON.stringify(body, null, 2));
      if (c.need.kind === "supervisor-changed") writeAtomic(requestPath(this.name, this.jobsDir), JSON.stringify(body, null, 2));
      return null;
    } catch (e: any) {
      return `could not write the request file: ${String(e?.message ?? e).slice(0, 120)}`;
    }
  }

  /** A request already waiting for this supervisor (written, not yet taken). */
  pending(): { at: number; why: string } | null {
    if (!existsSync(requestPath(this.name, this.jobsDir))) return null;
    const j = readJson(requestPath(this.name, this.jobsDir));
    return j ? { at: Number(j.at) || 0, why: String(j.why ?? "") } : null;
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
