/**
 * Open 1-4 Ignition tables, each with its own study answers (port of run-tables.pyw, 2026-09-24).
 *
 *   bun run src/tools/runTables.ts [N] [--fake] [--stop]
 *
 * N is 1-4 (Ignition's own ceiling); it defaults to 1, which is exactly the single-table setup and takes none of
 * the multi-table paths.
 *
 *     slot 1  panel :7700  ─┐
 *     slot 2  panel :7710   ├─ four wrapper PROCESSES, one shared browser
 *     slot 3  panel :7720   │  (one --user-data-dir ⇒ one login, one CDP port),
 *     slot 4  panel :7730  ─┘  four app windows, four panels
 *
 * Four tables are four processes rather than one process with four of everything: the failure mode of shared
 * state across tables is "acted on the wrong table's state", and process isolation makes that impossible rather
 * than unlikely. Nothing here hands out windows — the client keeps all N tables in ONE page and each wrapper
 * claims its own by its slot — so starting N wrappers IS the setup, and a wrapper that dies can be restarted alone.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { paths } from "../env";
import * as TABLES from "../tables";

const ROOT = join(paths().repo, "ignition-study-wrapper");
const MAIN = join(import.meta.dir, "..", "main.ts");
const CDP_PORT = Number(process.env.CDP_PORT || 9333);
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));

/**
 * Is slot `slotN` up — as that slot, on the rig this run is for? NOT "does something answer :7710": the test rig
 * serves these same ports, so a bare liveness check would call a live real-money wrapper "slot 2, already up" in a
 * --fake run (and the other way round). The wrapper says which slot and which rig it is; believe that.
 */
async function up(slotN: number, fake: boolean, timeoutS = 1.5): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutS * 1000);
  try {
    const r = await fetch(`http://127.0.0.1:${TABLES.panelPort(slotN)}${TABLES.PRESENCE_PATH}`, { signal: ctl.signal });
    const d: any = await r.json();
    return !!d && d.slot === slotN && d.rig === (fake ? "fake" : "live");
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function startSlot(slotN: number, total: number, fake: boolean): Promise<void> {
  const port = TABLES.panelPort(slotN);
  if (await up(slotN, fake)) {
    console.log(`slot ${slotN}: already up on :${port}`);
    return;
  }
  // THE DECLARED COUNT goes to every slot: the layout is computed from it, not from how many slots happen to be up,
  // so a slot that dies and restarts finds its own cell again. EVERY SLOT SHARES ONE CDP PORT (one browser).
  const env: Record<string, string> = { ...(process.env as Record<string, string>),
    TABLE_SLOT: String(slotN), PANEL_PORT: String(port), TABLE_COUNT: String(total), CDP_PORT: String(CDP_PORT) };
  env.WRAPPER_LOG_FILE ??= join(ROOT, "server-rig.log");   // never the live wrapper's server.log
  if (fake) env.FAKE_TABLE = "1";
  // the ports in ARGV too: the takeover scan tells instances apart by command line
  const args = ["run", MAIN, "--panel-port", String(port), "--cdp-port", String(CDP_PORT), ...(fake ? ["--fake"] : [])];
  spawn(process.execPath, args, { env, cwd: ROOT, detached: true, stdio: "ignore", windowsHide: true }).unref();
  console.log(`slot ${slotN}: starting on :${port} (CDP :${CDP_PORT})`);
}

/** The rig is part of the address here too: `--stop --fake` must never stand down a live wrapper on :7710. */
async function stopSlot(slotN: number, fake: boolean): Promise<void> {
  const port = TABLES.panelPort(slotN);
  if (!(await up(slotN, fake))) return;
  try {
    await fetch(`http://127.0.0.1:${port}/quit`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
                                                   signal: AbortSignal.timeout(5000) });
    console.log(`slot ${slotN}: asked :${port} to stand down`);
  } catch (e: any) {
    console.log(`slot ${slotN}: could not stop :${port} — ${e?.message ?? e}`);
  }
}

async function main(argv: string[]): Promise<number> {
  const fake = argv.includes("--fake");
  const stop = argv.includes("--stop");
  const nums = argv.filter((a) => /^\d+$/.test(a));
  const n = nums.length ? Number(nums[0]) : 1;
  if (!(n >= 1 && n <= TABLES.MAX_TABLES)) {
    console.log(`tables must be 1-${TABLES.MAX_TABLES} (Ignition's own ceiling); got ${n}`);
    return 2;
  }
  if (stop) {
    for (let s = TABLES.MAX_TABLES; s >= 1; s--) await stopSlot(s, fake);
    return 0;
  }
  // SLOT 1 FIRST, AND ALONE UNTIL IT IS UP: it launches the browser with the debugger bound; every later slot only
  // joins that process and would otherwise race a half-started browser (four browsers, four logins).
  await startSlot(1, n, fake);
  let ok = false;
  for (let i = 0; i < 120 && !ok; i++) {
    ok = await up(1, fake);
    if (!ok) await sleep(0.5);
  }
  if (!ok) {
    console.log("slot 1 did not come up — not starting the rest");
    return 1;
  }
  console.log("slot 1 is up; the browser and its debugger belong to it");
  for (let s = 2; s <= n; s++) {
    await startSlot(s, n, fake);
    // stagger: each slot answers as itself before the next starts, so a failure is attributed to the slot that had it
    for (let i = 0; i < 60 && !(await up(s, fake)); i++) await sleep(0.5);
  }
  console.log("");
  for (let s = 1; s <= n; s++) {
    console.log(`  table ${s}: panel http://127.0.0.1:${TABLES.panelPort(s)}/panel  ${(await up(s, fake)) ? "up" : "NOT UP"}`);
  }
  console.log("\nEach table needs its own seat: open its panel and use the session setup as usual.");
  if (n > 1) console.log("The tables tile the table monitor between them; the panels tile the other screen.");
  return 0;
}

process.exit(await main(process.argv.slice(2)));
