/**
 * The wrapper's settings, from the environment — what launch.py read at import. main.ts translates the launcher's
 * argv (--panel-port, --cdp-port, --fake) and config/local.env into the environment FIRST, then loads the app, so
 * everything here is fixed for the life of the process (as it was in Python). Only TABLE_SLOT / TABLE_COUNT are
 * read live (tables.ts): adopt() changes them mid-run.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./env";

function defaultBrowser(): string {
  const local = process.env.LOCALAPPDATA || "";
  for (const p of [`${local}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
                   "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe",
                   "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"]) {
    if (existsSync(p)) return p;
  }
  return "chrome.exe";
}

function load() {
  const env = process.env;
  const fake = env.FAKE_TABLE === "1";
  const rig = fake ? "-fake" : "";
  const slot = env.TABLE_SLOT || "";
  const tag = env.PANEL_TAG || "";
  const profileSuffix = env.PROFILE_SUFFIX || "";
  return {
    ROOT: paths().root,
    PANEL_PORT: Number(env.PANEL_PORT || "7700"),
    CDP_PORT: Number(env.CDP_PORT || "9333"),
    IGNITION_URL: env.IGNITION_URL || "https://www.ignitioncasino.eu/poker-lobby",
    CHROME: env.CHROME_EXE || defaultBrowser(),
    TABLE_FRAC: Number(env.TABLE_FRAC || (fake ? "0.55" : "0.70")),
    TABLE_FULLSCREEN: (env.TABLE_FULLSCREEN || "multi").trim().toLowerCase(),
    /** what this process IS (the launcher's --fake), as opposed to the fake-table MODE, which can change */
    FAKE_RIG: fake,
    HEADLESS: env.WRAPPER_HEADLESS === "1",
    RIG: rig,
    SLOT: slot,
    TAG: tag,
    PROFILE_TABLE: `.profile-table${rig}${profileSuffix}`,
    PROFILE_PANEL: `.profile-panel${rig}${slot ? "-" + slot : ""}` + (tag ? `-t${[...tag].filter((c) => /[\p{L}\p{N}]/u.test(c)).join("")}` : ""),
    PROFILE_LEADER: `.profile-leader${rig}`,
    PANEL_TITLE: (rig ? "Poker Wrapper Tool" : "Poker Wrapper") + (slot ? ` ${slot}` : "") + (tag ? ` ${tag}` : ""),
    DEBUG_BUDGET_MB: Number(env.DEBUG_BUDGET_MB || "2000"),
    NET_PROBE_EVERY_S: Number(env.NET_PROBE_EVERY_S || "45"),
    TOP_UP_PREFOLD: (env.TOP_UP_PREFOLD ?? "1") !== "0",
    TOP_UP_PREFOLD_BUDGET_S: Number(env.TOP_UP_PREFOLD_BUDGET_S || "6.0"),
    TOP_UP_PREFOLD_BANKED_S: Number(env.TOP_UP_PREFOLD_BANKED_S || "20.0"),
    WS_DUMP_NAME: slot ? `ws_dump-${slot}.jsonl` : "ws_dump.jsonl",
    PANEL_DEFER_WINDOW: env.PANEL_DEFER_WINDOW === "1",
    PANEL_PUBLIC_URL: env.PANEL_PUBLIC_URL || "",
  };
}

export let C = load();

/** Re-read the environment (main.ts after it has applied argv; the golden tests between scenarios). */
export function reloadConfig(): void {
  C = load();
}

export const DATA_DIR = () => paths().data;
export const DEBUG_DIR = () => paths().debug;
export const wsDumpPath = () => join(paths().debug, C.WS_DUMP_NAME);
