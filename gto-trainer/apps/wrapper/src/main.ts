/**
 * THE POKER WRAPPER — entry point (replaces run-study.pyw + launch.main()).
 *
 *   bun run src/main.ts [--panel-port N] [--cdp-port N] [--fake]
 *
 * Rig selection comes from argv, not the environment, on purpose: the takeover scan reads other processes'
 * COMMAND LINES to tell one rig from another. config/local.env is read first (a value already in the environment
 * wins). Launching REPLACES whatever instance is serving this panel port — the Python wrapper included — so the
 * code that runs is always the code on disk.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { REPO } from "./env";

// ---- 1. argv + config/local.env -> the environment, BEFORE the app's modules read it ----------------------
const argv = process.argv.slice(2);
function opt(name: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === name && i + 1 < argv.length) return argv[i + 1]!;
    if (a.startsWith(name + "=")) return a.split("=").slice(1).join("=");
  }
  return null;
}
const localEnv = join(REPO, "config", "local.env");
if (existsSync(localEnv)) {
  for (const line of readFileSync(localEnv, "utf8").replace(/^﻿/, "").split(/\r?\n/)) {
    const l = line.split(" #")[0]!.trim();
    if (!l || l.startsWith("#") || !l.includes("=")) continue;
    const i = l.indexOf("=");
    const k = l.slice(0, i).trim();
    const v = l.slice(i + 1).trim().replace(/^"+|"+$/g, "");
    if (k && v && !process.env[k]) process.env[k] = v;
  }
}
if (opt("--panel-port")) process.env.PANEL_PORT = opt("--panel-port")!;
if (opt("--cdp-port")) process.env.CDP_PORT = opt("--cdp-port")!;
if (argv.includes("--fake")) process.env.FAKE_TABLE = "1";

// the hidden launcher has no console: WRAPPER_LOG_FILE sends the log to a file (server.log)
if (process.env.WRAPPER_LOG_FILE) {
  const file = resolve(process.env.WRAPPER_LOG_FILE);
  mkdirSync(dirname(file), { recursive: true });
  const write = (...a: unknown[]) => {
    try {
      appendFileSync(file, a.map((x) => (typeof x === "string" ? x : String(x))).join(" ") + "\n", "utf8");
    } catch {}
  };
  console.log = write;
  console.error = write;
  console.warn = write;
}

// A background thread's exception killed only that thread in the Python wrapper; the server kept serving. A stray
// rejection must not take the whole process (and every answer on screen) down with it here either — log it and go on.
process.on("unhandledRejection", (e: any) => console.log(`[error] unhandled rejection: ${e?.stack ?? e}`));
process.on("uncaughtException", (e: any) => console.log(`[error] uncaught exception: ${e?.stack ?? e}`));

const { reloadConfig } = await import("./config");
reloadConfig();
const mainModule = await import("./app");
try {
  await mainModule.main(argv);
} catch (e: any) {
  // the hidden launcher has nowhere to print — file it where run-study.pyw filed it
  try {
    const { DEBUG_DIR } = await import("./config");
    appendFileSync(join(DEBUG_DIR(), "last-start.txt"), `EXC: ${e?.stack ?? e}
`, "utf8");
  } catch {}
  console.log(`[panel] startup failed: ${e?.stack ?? e}`);
  process.exit(1);
}

export {};
