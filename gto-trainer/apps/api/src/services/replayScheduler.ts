import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { jobsDir } from "./storePaths";
import { liveBusy } from "./livePriority";
import { replayChecks } from "./replayCheck";
import { asActivity } from "./answerTrace";

/**
 * CHECK #13's DAILY RUN (2026-09-27, services/replayCheck). Once a day, when no live answer has been computed for ten
 * minutes, the API starts scripts/replayDeterminism.ts as a process of its own — the replay swaps gtowApi's network
 * calls, which must never happen in the process answering the table. Launched DETACHED through Start-Process (a
 * Bun.spawn child inherits the API's listening socket on Windows: services/jobs.ts runStepDetached); its output goes to
 * data/jobs/replay.log. It costs no GTO Wizard quota (the traces are the only "GTO Wizard" it talks to).
 */
const EVERY_MS = 20 * 3600_000;
const QUIET_MS = 10 * 60_000;
const TICK_MS = 30 * 60_000;

let lastLaunch = 0;
let timer: ReturnType<typeof setInterval> | null = null;

export function launchReplay(days = 2): { ok: boolean; why: string } {
  if (Date.now() - lastLaunch < 10 * 60_000) return { ok: false, why: "a replay was started less than 10 minutes ago" };
  try {
    const win = (p: string) => p.replace(/\//g, "\\");
    const apiDir = join(import.meta.dir, "..", "..");
    const cmdFile = join(jobsDir(), "replay_determinism.cmd");
    writeFileSync(cmdFile, `@echo off\r\ncd /d "${win(apiDir)}"\r\n"${win(process.execPath)}" src\\scripts\\replayDeterminism.ts --days ${days} >> "${win(join(jobsDir(), "replay.log"))}" 2>&1\r\n`);
    Bun.spawn(["powershell", "-NoProfile", "-Command",
      `Start-Process -WindowStyle Hidden -FilePath "$env:SystemRoot\\System32\\cmd.exe" -ArgumentList '/c','"${win(cmdFile)}"'`],
      { stdout: "ignore", stderr: "ignore" });
    lastLaunch = Date.now();
    return { ok: true, why: `replaying the last ${days} day(s) of live decisions — results in the Coverage tab, log in data/jobs/replay.log` };
  } catch (e) {
    return { ok: false, why: `could not start the replay: ${e instanceof Error ? e.message : String(e)}` };
  }
}

function tick(): void {
  const last = replayChecks.lastRunAt();
  if (last != null && Date.now() - last < EVERY_MS) return;
  if (Date.now() - lastLaunch < EVERY_MS) return;
  if (liveBusy(QUIET_MS)) return;   // never while hands are being answered
  const r = launchReplay(2);
  console.log(`[replay] daily determinism replay: ${r.why}`);
}

export const replayScheduler = {
  start(): void {
    if (timer || process.platform !== "win32") return;
    timer = setInterval(() => { try { asActivity("timer replayScheduler", tick); } catch { /* never the API's problem */ } }, TICK_MS);
    (timer as { unref?: () => void }).unref?.();
  },
};
