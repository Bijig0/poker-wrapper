/**
 * Every port the Poker Wrapper listens on or calls, in ONE place — and ONE setting that moves them all.
 *
 *   PORT_OFFSET=50  in config/local.env          api 2050 · charts 8827 · panel 7750 (+10 per extra table)
 *                                                GTO Wizard CDP 9272 · second GTO Wizard account 9273 · table browser 9383
 *
 * Why (2026-09-30): ports are machine-wide on Windows — an account signed in in the background keeps its :2000, :8777,
 * :7700 and :9222, so a second Windows account (Brady's Test account beside his own stack) could only run its install
 * with the first signed out. Now the installer (setup\setup.ps1 step 6) sees the ports taken by another account and
 * picks the first free offset; every server, client and script here derives its ports from the same rule, and the
 * browser files (panel.html, dashboard.html, static/study) have their ":2000"-style addresses rewritten on the way out
 * (rewritePorts). The explicit names still win, one launch at a time — PORT=2001 for a verify API, --panel-port for a
 * second rig — which is why `livePort` (what the install is MEANT to run on) and `port` (this process's) differ.
 *
 * config/env.ps1 derives the same six variables for PowerShell (the supervisors, the watchdog, setup, doctor); keep the
 * two tables identical.
 */

export const PORT_DEFAULTS = {
  api: 2000,           // the study API + dashboard (PORT)
  charts: 8777,        // the chart server (HRC_UI_PORT)
  panel: 7700,         // the wrapper's panel; extra tables at +10, +20, +30 (PANEL_PORT)
  gtow: 9222,          // the primary GTO Wizard client's DevTools port (GTOW_CDP_PORT)
  gtowSecondary: 9223, // the second GTO Wizard account's (GTOW_SECONDARY_CDP_PORT)
  tableCdp: 9333,      // the wrapper's table browser DevTools port (CDP_PORT, --cdp-port)
} as const;
export type PortName = keyof typeof PORT_DEFAULTS;

/** The environment variable that overrides each port for one launch. */
export const PORT_ENV: Record<PortName, string> = {
  api: "PORT", charts: "HRC_UI_PORT", panel: "PANEL_PORT",
  gtow: "GTOW_CDP_PORT", gtowSecondary: "GTOW_SECONDARY_CDP_PORT", tableCdp: "CDP_PORT",
};

/** PORT_OFFSET, a non-negative integer (anything else reads as 0). */
export function portOffset(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.PORT_OFFSET ?? "").trim();
  if (!/^\d+$/.test(raw)) return 0;
  const n = Number(raw);
  return n > 0 && n < 50_000 ? n : 0;
}

/** The port a service is MEANT to run on in this install: default + PORT_OFFSET. "The live API" means this one. */
export function livePort(name: PortName, env: NodeJS.ProcessEnv = process.env): number {
  return PORT_DEFAULTS[name] + portOffset(env);
}

/** The port THIS process uses for a service: the explicit variable (PORT, PANEL_PORT, ...) when set, else livePort. */
export function port(name: PortName, env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env[PORT_ENV[name]] ?? "").trim();
  if (/^\d+$/.test(raw) && Number(raw) > 0 && Number(raw) < 65536) return Number(raw);
  return livePort(name, env);
}

/** 127.0.0.1, NOT localhost: on Windows localhost tries ::1 first and the servers listen on IPv4 only. */
export const apiUrl = (env: NodeJS.ProcessEnv = process.env) => `http://127.0.0.1:${port("api", env)}`;
export const chartsUrl = (env: NodeJS.ProcessEnv = process.env) => `http://127.0.0.1:${port("charts", env)}`;
export const panelUrl = (env: NodeJS.ProcessEnv = process.env) => `http://127.0.0.1:${port("panel", env)}`;

/**
 * A browser file on its way out (panel.html, dashboard.html, static/study/*): every ":2000"-style address of a service —
 * in a URL (http://localhost:2000/hands) and in a message ("the API on :2000") — becomes this install's port. Only the
 * ":<default>" form, so a bare 2000 (a timeout, "2000 hands") is left alone; a colon-number that is not one of the four
 * defaults is left alone too. A no-op when nothing moved, which is every install without PORT_OFFSET.
 */
export function rewritePorts(text: string, env: NodeJS.ProcessEnv = process.env): string {
  const map = new Map<string, string>();
  for (const name of ["api", "charts", "panel", "gtow", "gtowSecondary"] as PortName[]) {
    const now = port(name, env);
    if (now !== PORT_DEFAULTS[name]) map.set(String(PORT_DEFAULTS[name]), String(now));
  }
  if (!map.size) return text;
  const re = new RegExp(`:(${[...map.keys()].join("|")})(?!\\d)`, "g");
  return text.replace(re, (_, p: string) => `:${map.get(p)}`);
}
