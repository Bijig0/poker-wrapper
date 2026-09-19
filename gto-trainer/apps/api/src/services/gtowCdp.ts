/**
 * GtowCdp — drives the GTO Wizard desktop app (Electron/Chromium) over the
 * Chrome DevTools Protocol for the classroom teaching aid.
 *
 * GTO Wizard must be launched with remote debugging enabled:
 *   open -a "GTO Wizard" --args --remote-debugging-port=9222
 *
 * We attach to its renderer page (app.gtowizard.com) and read/click the DOM
 * directly — sub-50ms, exact, no OCR. Selectors are the app's own stable
 * `data-tst` test IDs where available, else structural classes.
 */

import { parseHandClass } from "../utils/parseHandClass/parseHandClass";
import { parseBetLabel } from "../utils/parseBetLabel/parseBetLabel";
import { parseExactCombo } from "../utils/parseExactCombo/parseExactCombo";
import { parseComboLegend } from "../utils/parseComboLegend/parseComboLegend";
import {
  canonicalizeActions,
  canonicalActionKey,
} from "../utils/canonicalizeActions/canonicalizeActions";
import {
  buildLinePlan,
  type LinePlan,
  type LineState,
  type PostflopStreet,
} from "../utils/buildLinePlan/buildLinePlan";
import { existsSync } from "node:fs";
import { pickWeightedAction } from "../utils/pickWeightedAction/pickWeightedAction";
import { pseudoHarmonicProbLow, bracket } from "../utils/pseudoHarmonic/pseudoHarmonic";
import {
  totalVariation,
  blend,
  agrees,
  type ActionFreq,
} from "../utils/bracketDisagreement/bracketDisagreement";

const DEBUG_HOST = "127.0.0.1";
const DEBUG_PORT = 9222;
const TARGET_MATCH = "app.gtowizard.com";

/**
 * Which desktop client to drive. Two builds can sit side by side: the
 * international one at "GTO Wizard", and the Chinese regional build — renamed
 * (folder AND exe) to "Chinese GTO Wizard" on 2026-09-18, because Windows takes
 * a process's name from the exe, so two installs called "GTO Wizard.exe" are
 * indistinguishable to Get-Process and a relaunch would kill the wrong one.
 * GTOW_CLIENT_PATH pins a build; otherwise the international one wins when
 * installed and we fall back to the Chinese build.
 */
const CLIENT_CANDIDATES = [
  "C:\\Program Files\\GTO Wizard\\GTO Wizard.exe",
  "C:\\Program Files\\Chinese GTO Wizard\\Chinese GTO Wizard.exe",
];

const CHROME_CANDIDATES = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

/**
 * Two ways to hold a GTO Wizard session we can sniff a token from:
 *  - `electron`: a desktop client exe (what we used until 2026-09-18).
 *  - `chrome`:   app.gtowizard.com in a DEDICATED Chrome profile. GTO Wizard
 *                ships no native client — their own "install on PC" is a PWA —
 *                so this is the fallback when no Electron build is installed.
 *                A dedicated --user-data-dir is required: Chrome refuses
 *                --remote-debugging-port on an already-running profile.
 * `scripts/start_gtow_chrome.ps1` is the manual twin of the chrome branch.
 */
type WinClient =
  | { kind: "electron"; exe: string }
  | { kind: "chrome"; exe: string; profileDir: string };

function resolveWinClient(): WinClient | null {
  const pinned = process.env.GTOW_CLIENT_PATH?.trim();
  if (pinned) return { kind: "electron", exe: pinned };
  const electron = CLIENT_CANDIDATES.find((c) => existsSync(c));
  if (electron) return { kind: "electron", exe: electron };
  const chrome = CHROME_CANDIDATES.find((c) => existsSync(c));
  if (chrome) {
    const profileDir =
      process.env.GTOW_CHROME_PROFILE?.trim() ||
      `${process.env.LOCALAPPDATA ?? "C:\\Users\\Brady\\AppData\\Local"}\\gtow-cdp-profile`;
    return { kind: "chrome", exe: chrome, profileDir };
  }
  return null;
}

/** PowerShell selecting ONLY this client's processes — never anything else's. */
function scopedProcPs(c: WinClient): string {
  if (c.kind === "electron") {
    // Windows names a process after its exe, so two installs both called
    // "GTO Wizard.exe" are indistinguishable by name — match the full path.
    const name = (c.exe.split("\\").pop() ?? c.exe).replace(/\.exe$/i, "");
    return `Get-Process -Name '${name}' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq '${c.exe}' }`;
  }
  // NEVER match chrome.exe by name or path: that is the user's entire browser,
  // and a relaunch would close every tab they have open. The dedicated
  // --user-data-dir on the command line is the only safe discriminator.
  return (
    `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.CommandLine -and $_.CommandLine -like '*--user-data-dir=${c.profileDir}*' } | ` +
    `ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }`
  );
}

function launchClientPs(c: WinClient): string {
  if (c.kind === "electron") {
    return `Start-Process -FilePath '${c.exe}' -ArgumentList '--remote-debugging-port=${DEBUG_PORT}' -WindowStyle Minimized`;
  }
  const args = [
    `--user-data-dir=${c.profileDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    // Chrome rejects CDP websockets with an unexpected Origin without this.
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    `https://${TARGET_MATCH}/`,
  ]
    .map((a) => `'${a}'`)
    .join(",");
  return `Start-Process -FilePath '${c.exe}' -ArgumentList ${args} -WindowStyle Minimized`;
}

interface CdpResult {
  result?: { value?: unknown };
  exceptionDetails?: { exception?: { description?: string }; text?: string };
}

interface CdpMessage {
  id: number;
  result?: CdpResult;
}

/**
 * Parse "Qh Jh 2s" / "qhjh2s" / "8c" → normalized card list (1–5, validated).
 * The count check against the street's open slots happens in the DOM, since
 * GTO Wizard decides how many cards the current street expects.
 */
export function parseCards(input: string): string[] {
  const tokens = input.match(/[2-9TJQKA][hdcs]/gi) ?? [];
  const cards = tokens.map((t) => t[0].toUpperCase() + t[1].toLowerCase());
  if (cards.length < 1 || cards.length > 5) {
    throw new Error(`Expected 1–5 cards (e.g. "Qh Jh 2s" or "8c"), parsed ${cards.length}.`);
  }
  if (new Set(cards).size !== cards.length) throw new Error(`Duplicate card in "${input}".`);
  return cards;
}

/** Street-gating state: which cards (if any) can be set right now. */
export interface BoardState {
  street: string | null; // Preflop / Flop / Turn / River (from the title)
  slotLabel: string | null; // FLOP / TURN / RIVER of the open slot group
  settable: boolean; // can any card be set on the current street right now?
  mode: "deal" | "repick" | "locked"; // deal empties / replace current / gated
  emptyCount: number; // empty slots (cards to deal for the next street)
  totalSlots: number; // total slots in the current street's group
  expects: number; // how many cards the input should provide
  filledCards: string[]; // cards already on the board
  board: string | null; // board param in the URL, if any
  blockedReason: string | null; // why setting is blocked (if locked)
}

/** A presolved solution set in GTO Wizard's library, addressed by URL params. */
export interface SolutionSet {
  id: string;
  label: string;
  gametype: string; // GTO Wizard's `gametype` URL param
  /** Stack depths (bb) with FULL postflop solutions (`solution_completeness: all_spots`). */
  depths: number[];
  defaultDepth: number;
  /** Seat labels in preflop acting order, as GTO Wizard renders them. */
  seats: string[];
}

/*
 * ---- CoinPoker ANTE sets ----
 *
 * Every non-ante set below is the wrong range source for CoinPoker, which
 * posts an ante every hand — that mismatch is how the postflop solve fleet
 * ended up conditioned on ranges from a different game.
 *
 * GTO Wizard ships CoinPoker-specific trees whose `info` block matches the
 * live game on every axis that matters:
 *   ante 0.166/player  (0.16 measured across 75,572 real hands — same number)
 *   rake 5%, cap 3BB at NL200  (== configs.json rake_rate/rake_cap_bb)
 *   no_flop_no_drop
 *
 * Generated rather than hand-listed: rake × opening-size is a clean product,
 * and eight copy-pasted blocks would drift.
 *
 * Two gotchas worth stating, both of which produce a silently empty page:
 *   - Depths are FRACTIONAL. The ante rides in the depth string, so 100bb is
 *     `100.166`, never `100`.
 *   - BCC, not NCC. That axis is "BTN cold call" vs "No cold calls", and
 *     srp_co_vs_btn / srp_hj_vs_btn in the solve configs are BTN cold-calling
 *     an earlier open — a line NCC's tree cannot express.
 *
 * NL100 caps rake at 5BB and NL200 at 3BB; the fleet's configs use 3.0, so
 * NL200 is the drop-in. NL100 is crawled alongside it for the other stake.
 */
const CP_ANTE_DEPTHS = [
  20.166, 30.166, 40.166, 50.166, 60.166, 70.166, 80.166, 90.166, 100.166, 125.166, 150.166, 200.166,
];
/** Suffix is the open size with the decimal dropped: R225 = 2.25x. */
const CP_ANTE_OPENS = [
  { sfx: "R2", x: "2", id: "2" },
  { sfx: "R225", x: "2.25", id: "225" },
  { sfx: "R25", x: "2.5", id: "25" },
  { sfx: "R3", x: "3", id: "3" },
] as const;
const CP_ANTE_RAKES = ["NL100", "NL200"] as const;

export const CP_ANTE_SETS: SolutionSet[] = CP_ANTE_RAKES.flatMap((rake) =>
  CP_ANTE_OPENS.map((o) => ({
    id: `6max-cp-ante-${rake.toLowerCase()}-${o.id}`,
    label: `6-max · CoinPoker ante 0.166 · ${rake} · ${o.x}x opens`,
    gametype: `Cash6mSimple_6mCPante0166BCC${rake}${o.sfx}`,
    depths: CP_ANTE_DEPTHS,
    defaultDepth: 100.166,
    seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  }))
);

/**
 * The solution sets exposed to the trainer — the full-postflop subset of GTO
 * Wizard's cash catalog (inventoried from the app's own gameformat store;
 * everything else in the library is preflop-only), plus the ante sets above.
 */
export const SOLUTION_SETS: SolutionSet[] = [
  {
    id: "6max",
    label: "6-max · NL500 · General",
    gametype: "Cash6m500zGeneral",
    depths: [20, 40, 50, 75, 100, 150, 200],
    defaultDepth: 100,
    seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  },
  {
    id: "6max-25open",
    label: "6-max · NL500 · General · 2.5x opens",
    gametype: "Cash6m500zGeneral25Open",
    depths: [100],
    defaultDepth: 100,
    seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  },
  {
    id: "6max-complex",
    label: "6-max · NL500 · Complex (12-19 sizes)",
    gametype: "Cash6m500zComplex",
    depths: [100],
    defaultDepth: 100,
    seats: ["UTG", "HJ", "CO", "BTN", "SB", "BB"],
  },
  {
    id: "9max",
    label: "9-max · NL50 · General",
    gametype: "Cash9m50zGeneral",
    depths: [100],
    defaultDepth: 100,
    seats: ["UTG", "UTG1", "UTG2", "LJ", "HJ", "CO", "BTN", "SB", "BB"],
  },
  {
    id: "hu",
    label: "Heads-up · NL500 · Advanced",
    gametype: "CashHu500zComplex",
    depths: [20, 40, 60, 80, 100, 150],
    defaultDepth: 100,
    seats: ["SB", "BB"],
  },
  {
    id: "hu-simple",
    label: "Heads-up · NL500 · Simple (deep stacks)",
    gametype: "CashHu500zSimple",
    depths: [20, 40, 60, 80, 100, 150, 200, 300, 400, 500],
    defaultDepth: 100,
    seats: ["SB", "BB"],
  },


  ...CP_ANTE_SETS,
];

export class GtowCdp {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, (r: CdpMessage) => void>();
  private connecting: Promise<void> | null = null;

  /** (Re)establish a CDP websocket to the GTO Wizard renderer page. */
  private async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;

    this.connecting = (async () => {
      // EVERY step is bounded: this in-flight promise is cached, so a single
      // hung attempt (a wedged debug port, a WS handshake that never fires —
      // both observed racing the app's boot) would otherwise poison
      // isConnected() FOREVER — the "connected=false while the port answers
      // fine" deadlock of 2026-07-31.
      // /json/list rather than /json — the latter can hang on some app builds
      const list = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      }).then(
        (r) => r.json() as Promise<Array<{ type: string; url: string; webSocketDebuggerUrl: string }>>
      );
      const page = list.find((t) => t.type === "page" && t.url.includes(TARGET_MATCH));
      if (!page) throw new Error("GTO Wizard page target not found on the debug port.");

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      this.pending.clear();
      ws.addEventListener("message", (e) => {
        const msg = JSON.parse(e.data as string);
        if (msg.id && this.pending.has(msg.id)) {
          this.pending.get(msg.id)!(msg);
          this.pending.delete(msg.id);
        }
      });
      ws.addEventListener("close", () => {
        if (this.ws === ws) this.ws = null;
      });
      await new Promise<void>((res, rej) => {
        const deadline = setTimeout(() => {
          try { ws.close(); } catch {}
          rej(new Error("CDP websocket didn't open within 8s"));
        }, 8_000);
        ws.addEventListener("open", () => { clearTimeout(deadline); res(); });
        ws.addEventListener("error", () => { clearTimeout(deadline); rej(new Error("CDP websocket error")); });
      });
      this.ws = ws;
      await this.rpc("Runtime.enable");
    })();

    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  private rpc(method: string, params: Record<string, unknown> = {}): Promise<{ result?: CdpResult }> {
    const ws = this.ws;
    if (!ws) return Promise.reject(new Error("not connected"));
    const id = this.nextId++;
    return new Promise((res, rej) => {
      // A reply that never comes (app hung, renderer gone mid-call) must not
      // strand the caller — waitUntil/evaluate loops retry on rejection.
      const deadline = setTimeout(() => {
        this.pending.delete(id);
        rej(new Error(`CDP ${method} got no reply within 20s`));
      }, 20_000);
      this.pending.set(id, (r) => { clearTimeout(deadline); res(r); });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate a JS expression in the page and return its JSON value. */
  private async evaluate<T>(expression: string, awaitPromise = false): Promise<T> {
    await this.connect();
    // CDP shape: { id, result: { result: { value }, exceptionDetails? } }
    const msg = await this.rpc("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
    });
    const payload = msg.result;
    if (payload?.exceptionDetails) {
      throw new Error(
        payload.exceptionDetails.exception?.description ?? payload.exceptionDetails.text ?? "eval error"
      );
    }
    return payload?.result?.value as T;
  }

  /**
   * Escape hatch for read-only introspection of the client (catalogue dumps,
   * probing which formats exist). Runs in the PAGE context, so `fetch` here
   * carries the app's own session — no token handling needed at the caller.
   *
   * Deliberately not used by the live path: everything the trainer relies on
   * has a typed method above, and this bypasses all of them.
   */
  async evalInPage<T>(expression: string, awaitPromise = true): Promise<T> {
    return this.evaluate<T>(expression, awaitPromise);
  }

  /** True if GTO Wizard is reachable over CDP. */
  async isConnected(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }

  /** Minimize GTO Wizard's window (Windows). Electron ignores the launcher's
   *  minimized-start hint, so an unattended (re)launch minimizes explicitly
   *  once the renderer is up — the solver is a background service here; its
   *  window must never cover the table or the study panel. Fire-and-forget. */
  private minimizeAppWindow(): void {
    Bun.spawn(
      [
        "powershell",
        "-NoProfile",
        "-Command",
        "Add-Type -Namespace U -Name W -MemberDefinition " +
          "'[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr h, int n);'; " +
          "Get-Process 'GTO Wizard' -ErrorAction SilentlyContinue | " +
          "Where-Object { $_.MainWindowHandle -ne 0 } | " +
          "ForEach-Object { $null = [U.W]::ShowWindow($_.MainWindowHandle, 6) }",
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
  }

  /** True once the debug port is serving the GTO Wizard page target. */
  private async debugPortReady(): Promise<boolean> {
    try {
      const list = await fetch(`http://${DEBUG_HOST}:${DEBUG_PORT}/json/list`, {
        signal: AbortSignal.timeout(5_000),
      }).then(
        (r) => r.json() as Promise<Array<{ type: string; url: string }>>
      );
      return list.some((t) => t.type === "page" && t.url.includes(TARGET_MATCH));
    } catch {
      return false;
    }
  }

  /**
   * Launch GTO Wizard with remote debugging enabled — the one-click version of
   * `open -a "GTO Wizard" --args --remote-debugging-port=9222`.
   *
   * macOS won't apply new `--args` to an already-running app, so if it's up
   * WITHOUT the debug port we must quit it first (its own Quit, escalating to a
   * kill) and relaunch. If the port is already live we do nothing — UNLESS
   * `force` is set, which skips that shortcut and always quits+relaunches.
   * `force` exists because "debug port reachable" only proves the CDP
   * connection is alive, not that GTO Wizard is actually processing
   * navigation (confirmed: it can sit wedged on a stale page, rejecting every
   * new URL, while still answering CDP reads fine) — see studyPoller's
   * wedge detection. Returns once the CDP target is reachable, or times out.
   */
  async launchApp(opts?: { force?: boolean }): Promise<{ ok: boolean; connected: boolean; relaunched: boolean; error?: string }> {
    if (!opts?.force && (await this.debugPortReady())) return { ok: true, connected: true, relaunched: false };

    // Drop any stale socket so the next connect attaches to the new instance.
    try { this.ws?.close(); } catch { /* ignore */ }
    this.ws = null;

    let relaunched = false;
    if (process.platform === "win32") {
      // Windows: same quit-then-relaunch-with-CDP dance via PowerShell
      // (scripts/start_gtow_ai.ps1 at the repo root is the manual twin).
      const ps = (cmd: string) =>
        Bun.spawn(["powershell", "-NoProfile", "-Command", cmd], { stdout: "pipe", stderr: "ignore" });
      // Scope every process lookup to OUR exe's full path: with both the
      // international and the Chinese build installed, a name-only match would
      // quit whichever one the user happens to have open.
      const client = resolveWinClient();
      if (!client) {
        return {
          ok: false,
          connected: false,
          relaunched: false,
          error:
            "no GTO Wizard client available: install a desktop build at " +
            "C:\\Program Files\\GTO Wizard, or install Chrome for the dedicated-profile fallback",
        };
      }
      const scoped = scopedProcPs(client);
      const running = async () => {
        const p = ps(`[bool](${scoped})`);
        await p.exited;
        return (await new Response(p.stdout).text()).trim() === "True";
      };
      if (await running()) {
        relaunched = true;
        // Close the main window politely, then force whatever survives.
        const q = ps(
          `${scoped} | ForEach-Object { $null = $_.CloseMainWindow() }; Start-Sleep -Seconds 3; ` +
            `${scoped} | Stop-Process -Force -Confirm:$false`,
        );
        await q.exited;
        await this.sleep(1200);
      }
      // Minimized ≈ macOS `open -g`: unattended relaunch must never cover
      // what the user is looking at (Ignition, the study panel) mid-session.
      ps(launchClientPs(client));
    } else {
      const running = async () => {
        const p = Bun.spawn(["pgrep", "-x", "GTO Wizard"], { stdout: "pipe", stderr: "ignore" });
        await p.exited;
        return (await new Response(p.stdout).text()).trim().length > 0;
      };

      if (await running()) {
        relaunched = true;
        // Ask it to quit cleanly, then wait for the process to actually exit.
        Bun.spawn(["osascript", "-e", 'quit app "GTO Wizard"'], { stdout: "ignore", stderr: "ignore" });
        let waited = 0;
        while ((await running()) && waited < 8000) {
          await this.sleep(400);
          waited += 400;
        }
        // Still alive after 8s → force it, then give the OS a moment to reap it.
        if (await running()) {
          Bun.spawn(["pkill", "-x", "GTO Wizard"], { stdout: "ignore", stderr: "ignore" });
          await this.sleep(1200);
        }
      }

      // -g: don't bring GTO Wizard to the foreground — it can now relaunch
      // itself unattended (the study poller's auto-connect/wedge-recovery),
      // and doing that with focus would cover whatever the user is actually
      // looking at (Ignition, the assistive-play panel) mid-session.
      Bun.spawn(["open", "-g", "-a", "GTO Wizard", "--args", `--remote-debugging-port=${DEBUG_PORT}`], {
        stdout: "ignore",
        stderr: "ignore",
      });
    }

    // The renderer needs a few seconds to boot and open its debug target.
    let waited = 0;
    while (waited < 30000) {
      await this.sleep(700);
      waited += 700;
      if (await this.debugPortReady()) {
        const connected = await this.isConnected();
        if (process.platform === "win32") this.minimizeAppWindow();
        return { ok: true, connected, relaunched };
      }
    }
    return {
      ok: false,
      connected: false,
      relaunched,
      error: "GTO Wizard didn't expose the debug port within 30s — it may still be starting or need a sign-in.",
    };
  }

  /**
   * GTO Wizard's own blocking overlay, if one is up — e.g. the daily
   * solution-browsing limit (data-tst "429"). While it shows, node
   * navigation and AI solving don't work and the grid behind it is stale.
   */
  async studyBlocker(): Promise<{ blocked: boolean; code?: string | null; message?: string }> {
    // (see isRecoverableBlocker below for which of these setup can clear itself)
    return this.evaluate<{ blocked: boolean; code?: string | null; message?: string }>(
      `(() => {
        const block = [...document.querySelectorAll("[data-tst=study_messages] .gw_mesblock")]
          .find(e => e.offsetWidth > 0 && (e.innerText||"").trim());
        if (!block) return { blocked: false };
        return {
          blocked: true,
          code: block.getAttribute("data-tst") || null,
          message: (block.innerText||"").replace(/\\s+/g," ").trim().slice(0, 300),
        };
      })()`
    );
  }

  /** Current page path, title, board, and whose turn it is (active node). */
  async status() {
    return this.evaluate<{
      path: string;
      title: string;
      board: string | null;
      activePosition: string | null;
    }>(
      `(() => {
        const active = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className));
        return {
          path: location.pathname + location.search,
          title: document.title,
          board: (location.search.match(/board=([^&]*)/) || [])[1] || null,
          activePosition: active ? (active.innerText||"").split("\\n")[0].trim() : null,
        };
      })()`
    );
  }

  /** The currently-loaded solution set (gametype + depth), and its matching id. */
  async currentSolution() {
    const sol = await this.evaluate<{ gametype: string | null; depth: string | null }>(
      `(() => { const p = new URLSearchParams(location.search); return { gametype: p.get("gametype"), depth: p.get("depth") }; })()`
    );
    const match = SOLUTION_SETS.find((s) => s.gametype === sol.gametype);
    return { ...sol, activeId: match?.id ?? null, activeDepth: sol.depth ? Number(sol.depth) : null };
  }

  /** Switch GTO Wizard to a presolved solution set by navigating to its URL. */
  async setSolutionSet(id: string, depth?: number) {
    const set = SOLUTION_SETS.find((s) => s.id === id);
    if (!set) return { ok: false, error: `Unknown solution set: ${id}` };
    const d = depth ?? set.defaultDepth;
    if (!set.depths.includes(d)) {
      return { ok: false, error: `${set.label} has no ${d}bb solution (depths: ${set.depths.join(", ")}).` };
    }
    // Navigate to a fresh preflop view for this set (line/board reset naturally).
    // Stamp the OLD document first: waits that follow can require the stamp to
    // be gone, proving the reload actually happened — otherwise a "loaded"
    // check can pass against the pre-navigation DOM.
    await this.evaluate<unknown>(
      `(() => { window.__solveNavStamp = 1; location.href = location.origin + "/solutions?gametype=" + ${JSON.stringify(
        set.gametype
      )} + "&depth=" + ${d} + "&solution_type=gwiz&gmfs_solution_tab=ai_sols&soltab=strategy"; })()`
    );
    return { ok: true, id: set.id, gametype: set.gametype, depth: d };
  }

  /**
   * One-click spot setup: load a solution set at a depth, then auto-walk the
   * preflop tree to a heads-up pot between two chosen seats — the earlier
   * seat opens (standard size = first raise option), the later seat calls
   * (SRP) or 3-bets and gets called (3bet), everyone else folds. Ends at the
   * flop-deal state, ready for the trainer.
   */
  async setupSpot(opts: {
    setId: string;
    depth: number;
    heroSeat: string;
    villainSeat: string;
    potType: "SRP" | "3bet";
    /** The hand's actual open size (BB) — picks the nearest tree raise. */
    openSize?: number | null;
    /** The hand's actual 3-bet size (BB) — picks the nearest tree re-raise. */
    threeBetSize?: number | null;
  }) {
    const set = SOLUTION_SETS.find((s) => s.id === opts.setId);
    if (!set) return { ok: false as const, error: `Unknown solution set: ${opts.setId}` };
    if (opts.heroSeat === opts.villainSeat) {
      return { ok: false as const, error: "Hero and villain need different seats." };
    }
    for (const seat of [opts.heroSeat, opts.villainSeat]) {
      if (!set.seats.includes(seat)) {
        return { ok: false as const, error: `${seat} isn't a seat in ${set.label} (seats: ${set.seats.join(", ")}).` };
      }
    }
    const nav = await this.setSolutionSet(opts.setId, opts.depth);
    if (!nav.ok) return { ok: false as const, error: nav.error };
    // Wait for the solutions view to render decision cards — NOT for a
    // "Preflop" title: the app restores its previously-browsed line right
    // after loading, which can put the title on any street. The index walk
    // below truncates whatever line was restored by clicking from spot 0.
    const up = await this.waitUntil(
      `typeof window.__solveNavStamp === "undefined" && document.title.includes("Solutions") && [...document.querySelectorAll(".hspot-card")].some(c => c.querySelectorAll(".hspotcrd_action").length > 0)`,
      25000,
      600
    );
    if (!up) return { ok: false as const, error: "Solution didn't load a preflop tree in time." };
    // wait out the app's line-restore, or a first click gets overwritten
    await this.waitForTreeSettle();
    // A lingering dialog (e.g. the SELECT BOARD picker) survives navigation
    // via the ?dialogs= param and overlays the strategy area — with it open
    // the legend never renders and every advance-wait would time out.
    await this.closeStaleDialogs();

    // the earlier-acting of the two seats opens; the other one responds
    const opener =
      set.seats.indexOf(opts.heroSeat) < set.seats.indexOf(opts.villainSeat)
        ? opts.heroSeat
        : opts.villainSeat;
    const responder = opener === opts.heroSeat ? opts.villainSeat : opts.heroSeat;

    const pickLabel = (
      labels: string[],
      kind: "fold" | "call" | "raise",
      targetBb?: number | null
    ): string | null => {
      const parsed = labels.map((l) => {
        const p = parseBetLabel(l);
        return { l, k: p?.kind, bb: p?.amount };
      });
      if (kind === "raise") {
        const raiseOpts = parsed.filter((p) => p.k === "raise");
        // with a target size from the real hand, take the closest tree size;
        // otherwise first (smallest) raise = the standard size
        if (targetBb != null && raiseOpts.some((p) => p.bb != null)) {
          return raiseOpts
            .filter((p) => p.bb != null)
            .reduce((a, b) => (Math.abs(b.bb! - targetBb) < Math.abs(a.bb! - targetBb) ? b : a)).l;
        }
        return raiseOpts[0]?.l ?? parsed.find((p) => p.k === "allin")?.l ?? null;
      }
      return parsed.find((p) => p.k === kind)?.l ?? null;
    };

    // Walk the decision points BY INDEX from the first seat, not by chasing
    // the active card: GTO Wizard restores its previously-browsed line a beat
    // after a solution loads, which yanks the active marker mid-walk. Clicking
    // spot i simply truncates any restored tail (the app's own interaction
    // model), so an index walk lands the desired line no matter what state the
    // tree was in.
    let opened = false;
    let threeBet = false;
    const taken: string[] = [];
    let idx = 0;
    for (let guard = 0; guard < set.seats.length * 2 + 8; guard++) {
      const state = await this.evaluate<{
        done: boolean;
        pos: string | null;
        tst: string | null;
        labels: string[];
      }>(
        `((i) => {
          // Only PREFLOP decision cards: the flop-deal slot (empty board
          // placeholders) is the boundary — a restored line's postflop cards
          // sit past it and must never be indexed by this walk.
          const all = [...document.querySelectorAll(".hspot-card")];
          let boundary = all.findIndex(c => c.querySelector(".poker-card_empty"));
          if (boundary < 0) boundary = all.length;
          const done = boundary < all.length;
          const cards = all.slice(0, boundary).filter(c => c.querySelectorAll(".hspotcrd_action").length > 0);
          const card = cards[i] || null;
          return {
            done,
            pos: card ? (card.innerText||"").split("\\n")[0].trim() : null,
            tst: card ? (card.getAttribute("data-tst")||"").replace(/_active$/, "") : null,
            labels: card ? [...card.querySelectorAll(".hspotcrd_action")].map(a => (a.innerText||"").replace(/\\s+/g," ").trim()) : [],
          };
        })(${idx})`
      );
      if (!state.pos || !state.tst) {
        if (state.done) break; // line closed into the flop-deal state
        // Spot idx hasn't rendered yet (post-click re-render, or the app is
        // still restoring a remembered line) — give it a beat and re-read.
        const settled = await this.waitUntil(
          `(() => {
            const all = [...document.querySelectorAll(".hspot-card")];
            let boundary = all.findIndex(c => c.querySelector(".poker-card_empty"));
            if (boundary < 0) boundary = all.length;
            const done = boundary < all.length;
            const n = all.slice(0, boundary).filter(c => c.querySelectorAll(".hspotcrd_action").length > 0).length;
            return done || n > ${idx};
          })()`,
          6000,
          300
        );
        if (settled) continue;
        // Still nothing: most often GTO Wizard's own blocking overlay (e.g.
        // the daily browsing limit) is covering the tree — say so precisely.
        // ("Choose board first" isn't an outage — the tree renders behind it.)
        const blocker = await this.studyBlocker().catch(() => ({ blocked: false as const }));
        if (blocker.blocked && !isRecoverableBlocker(blocker)) {
          // Only the daily browsing-limit overlay (code "429") is actually transient —
          // other messages (e.g. "no solution for this spot") won't clear on their own.
          const resets = "code" in blocker && blocker.code === "429" ? " Navigation resumes when it resets." : "";
          return {
            ok: false as const,
            error: `GTO Wizard is unavailable: ${("message" in blocker && blocker.message) || "usage limit reached"}${resets}`,
            line: taken,
          };
        }
        return { ok: false as const, error: `Preflop spot ${idx + 1} never rendered while walking the line.`, line: taken };
      }
      let kind: "fold" | "call" | "raise";
      if (state.pos === opener && !opened) kind = "raise";
      else if (state.pos === responder) kind = opts.potType === "3bet" && !threeBet ? "raise" : "call";
      else if (state.pos === opener && opened) kind = "call"; // opener facing the 3-bet
      else kind = "fold";

      const target =
        kind !== "raise" ? null : state.pos === opener ? opts.openSize : opts.threeBetSize;
      const label = pickLabel(state.labels, kind, target);
      if (!label) {
        return { ok: false as const, error: `No ${kind} option at ${state.pos} (has: ${state.labels.join(", ")}).`, line: taken };
      }
      // no legend requirement: preflop on the strategy tab has no board yet,
      // so the panel shows "Choose board first" and never renders a legend
      const adv = await this.advanceViaAction(state.tst, label, { requireLegend: false });
      if (!adv.ok) return { ok: false as const, error: adv.err, line: taken };
      taken.push(`${state.pos} ${label}`);
      if (state.pos === opener && kind === "raise") opened = true;
      if (state.pos === responder && kind === "raise") threeBet = true;
      idx++;
    }

    const done = await this.waitUntil(
      `[...document.querySelectorAll(".hspot-card")].some(c => c.querySelector(".poker-card_empty"))`,
      8000,
      400
    );
    if (!done) {
      return { ok: false as const, error: "Preflop didn't close into a flop-deal state.", line: taken };
    }
    const pot = await this.potAtActiveStreet();
    return {
      ok: true as const,
      setId: set.id,
      depth: opts.depth,
      potType: opts.potType,
      opener,
      responder,
      line: taken,
      pot,
    };
  }

  /**
   * URL-FIRST navigation: encode the whole line in the /solutions URL and
   * apply it with ONE navigation, then VERIFY by reading the taken actions
   * back. This retires the click-walk race class — the app's own deterministic
   * line-loader does the work, and read-back is a real postcondition.
   *
   * Returns per-street the intended vs actual tokens so the caller can decide
   * whether every action landed (fast path done) or a size was snapped
   * off-tree (fall back to the click-walk to repair).
   */
  async gotoNodeUrl(search: string): Promise<{
    ok: boolean;
    error?: string;
    taken: { street: string; pos: string; label: string }[];
    active: { pos: string | null; tst: string | null; labels: string[] };
    blocked?: boolean;
  }> {
    await this.evaluate<unknown>(
      `(() => { window.__solveNavStamp = 1; location.href = location.origin + "/solutions?" + ${JSON.stringify(search)}; })()`
    );
    const upCondition = `typeof window.__solveNavStamp === "undefined" && document.title.includes("Solutions") && [...document.querySelectorAll(".hspot-card")].some(c => c.querySelectorAll(".hspotcrd_action").length > 0)`;
    let up = await this.waitUntil(upCondition, 25000, 600);
    if (!up) {
      let blocker = await this.studyBlocker().catch(() => ({ blocked: false as const }));
      if (isFastModeRecoverable(blocker) && (await this.clickFastModeSolve())) {
        up = await this.waitUntil(upCondition, 20000, 600);
        if (!up) blocker = await this.studyBlocker().catch(() => ({ blocked: false as const }));
      }
      if (!up) {
        if (blocker.blocked && !isRecoverableBlocker(blocker)) {
          return { ok: false, blocked: true, error: `GTO Wizard is unavailable: ${("message" in blocker && blocker.message) || "usage limit reached"}.`, taken: [], active: { pos: null, tst: null, labels: [] } };
        }
        return { ok: false, error: "Solution didn't load the URL line in time.", taken: [], active: { pos: null, tst: null, labels: [] } };
      }
    }
    await this.waitForTreeSettle();
    await this.closeStaleDialogs();
    // The strategy GRID (range cells) renders a beat after the tree; a combo
    // read fired before it is up comes back empty. Wait for it so the very
    // first read at this node succeeds.
    await this.waitUntil(
      `document.querySelectorAll(".study-combos_cell").length > 0 && document.querySelectorAll(".sab_btn_name").length > 0`,
      6000,
      250
    );

    const state = await this.readNodeState();
    return { ok: true, ...state };
  }

  /**
   * Read the CURRENT line strip without navigating: the taken action of every
   * spot card plus the active node's position and available action labels.
   * Shared by gotoNodeUrl's post-navigation read-back and the off-tree repair
   * loop (which re-reads after a fast-solve without reloading the page).
   */
  async readNodeState(): Promise<{
    taken: { street: string; pos: string; label: string }[];
    active: { pos: string | null; tst: string | null; labels: string[] };
  }> {
    return this.evaluate<{
      taken: { street: string; pos: string; label: string }[];
      active: { pos: string | null; tst: string | null; labels: string[] };
    }>(
      `(() => {
        const streetOf = (tst) => { const m = (tst||"").match(/_(preflop|flop|turn|river)_/); return m ? m[1] : "?"; };
        const taken = [];
        for (const c of document.querySelectorAll(".hspot-card")) {
          const tst = (c.getAttribute("data-tst")||"").replace(/_active$/, "");
          const t = [...c.querySelectorAll(".hspotcrd_action")].find(a => /hspotcrd_action_active/.test(a.className));
          if (t) taken.push({ street: streetOf(tst), pos: (c.innerText||"").split("\\n")[0].trim(), label: (t.innerText||"").replace(/\\s+/g," ").trim() });
        }
        const a = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className) && c.querySelectorAll(".hspotcrd_action").length > 0);
        return {
          taken,
          active: {
            pos: a ? (a.innerText||"").split("\\n")[0].trim() : null,
            tst: a ? (a.getAttribute("data-tst")||"").replace(/_active$/, "") : null,
            labels: a ? [...a.querySelectorAll(".hspotcrd_action")].map(x => (x.innerText||"").replace(/\\s+/g," ").trim()) : [],
          },
        };
      })()`
    );
  }

  /**
   * Walk the preflop tree along a hand's ACTUAL action line (one step per
   * decision, blinds implicit) and stop at the node AFTER the last step —
   * hero's live decision point. Unlike setupSpot (which builds its own
   * standard heads-up line), this follows whatever really happened, with
   * nearest-tree-size selection for raises. The caller then reads hero's
   * class strategy at the resulting node.
   */
  async openPreflopLine(opts: {
    setId: string;
    depth: number;
    line: { kind: "fold" | "call" | "raise" | "allin"; sizeBb?: number | null; pos?: string | null }[];
  }) {
    const set = SOLUTION_SETS.find((s) => s.id === opts.setId);
    if (!set) return { ok: false as const, error: `Unknown solution set: ${opts.setId}` };
    const nav = await this.setSolutionSet(opts.setId, opts.depth);
    if (!nav.ok) return { ok: false as const, error: nav.error };
    const up = await this.waitUntil(
      `typeof window.__solveNavStamp === "undefined" && document.title.includes("Solutions") && [...document.querySelectorAll(".hspot-card")].some(c => c.querySelectorAll(".hspotcrd_action").length > 0)`,
      25000,
      600
    );
    if (!up) return { ok: false as const, error: "Solution didn't load a preflop tree in time." };
    // wait out the app's line-restore, or a first click gets overwritten
    await this.waitForTreeSettle();
    await this.closeStaleDialogs();

    // idx walks TREE cards; stepIdx walks the hand's line. They can drift:
    // the tree merges seats (a forced single-action card the hand never saw)
    // and auto-folds others (a hand fold with no card of its own).
    const taken: string[] = [];
    let idx = 0;
    let stepIdx = 0;
    for (let guard = 0; guard < opts.line.length * 3 + 12 && stepIdx < opts.line.length; guard++) {
      const state = await this.evaluate<{
        done: boolean;
        pos: string | null;
        tst: string | null;
        labels: string[];
      }>(
        `((i) => {
          const all = [...document.querySelectorAll(".hspot-card")];
          let boundary = all.findIndex(c => c.querySelector(".poker-card_empty"));
          if (boundary < 0) boundary = all.length;
          const done = boundary < all.length;
          const cards = all.slice(0, boundary).filter(c => c.querySelectorAll(".hspotcrd_action").length > 0);
          const card = cards[i] || null;
          return {
            done,
            pos: card ? (card.innerText||"").split("\\n")[0].trim() : null,
            tst: card ? (card.getAttribute("data-tst")||"").replace(/_active$/, "") : null,
            labels: card ? [...card.querySelectorAll(".hspotcrd_action")].map(a => (a.innerText||"").replace(/\\s+/g," ").trim()) : [],
          };
        })(${idx})`
      );
      if (!state.pos || !state.tst) {
        const settled = await this.waitUntil(
          `(() => {
            const all = [...document.querySelectorAll(".hspot-card")];
            let boundary = all.findIndex(c => c.querySelector(".poker-card_empty"));
            if (boundary < 0) boundary = all.length;
            const n = all.slice(0, boundary).filter(c => c.querySelectorAll(".hspotcrd_action").length > 0).length;
            return n > ${idx};
          })()`,
          6000,
          300
        );
        if (settled) continue;
        return { ok: false as const, error: `Preflop spot ${idx + 1} never rendered while walking the line.`, line: taken };
      }
      const step = opts.line[stepIdx];
      const parsed = state.labels.map((l) => {
        const p = parseBetLabel(l);
        return { l, k: p?.kind, bb: p?.amount };
      });

      // Position alignment when both sides know who is acting.
      if (step.pos && state.pos && step.pos !== state.pos) {
        if (state.labels.length === 1) {
          // Tree interjection: a forced single-action card for a seat the
          // hand's list skips — click it without consuming the step.
          const adv = await this.advanceViaAction(state.tst, state.labels[0], { requireLegend: false });
          if (!adv.ok) return { ok: false as const, error: adv.err, line: taken };
          taken.push(`${state.pos} ${state.labels[0]} (forced)`);
          idx++;
          continue;
        }
        if (step.kind === "fold") {
          // The tree auto-folded this seat — no card to click; skip the step.
          taken.push(`${step.pos} fold (merged)`);
          stepIdx++;
          continue;
        }
        return {
          ok: false as const,
          error: `Tree/line mismatch: the tree's next decision is ${state.pos} but the hand's next action is ${step.pos} ${step.kind}.`,
          line: taken,
        };
      }
      let label: string | null = null;
      if (step.kind === "raise") {
        const raises = parsed.filter((p) => p.k === "raise");
        if (step.sizeBb != null && raises.some((p) => p.bb != null)) {
          label = raises
            .filter((p) => p.bb != null)
            .reduce((a, b) => (Math.abs(b.bb! - step.sizeBb!) < Math.abs(a.bb! - step.sizeBb!) ? b : a)).l;
        } else {
          label = raises[0]?.l ?? parsed.find((p) => p.k === "allin")?.l ?? null;
        }
      } else if (step.kind === "allin") {
        label = parsed.find((p) => p.k === "allin")?.l ?? null;
      } else {
        label = parsed.find((p) => p.k === step.kind)?.l ?? null;
      }
      if (!label) {
        return {
          ok: false as const,
          error: `The tree has no ${step.kind} at ${state.pos} (has: ${state.labels.join(", ")}) — this line is off-tree.`,
          line: taken,
        };
      }
      const adv = await this.advanceViaAction(state.tst, label, { requireLegend: false });
      if (!adv.ok) return { ok: false as const, error: adv.err, line: taken };
      taken.push(`${state.pos} ${label}`);
      idx++;
      stepIdx++;
    }
    if (stepIdx < opts.line.length) {
      return { ok: false as const, error: "Preflop walk didn't finish the line.", line: taken };
    }
    return { ok: true as const, line: taken };
  }

  /** The active postflop decision node: its position, tst, and action labels. */
  async activeNode(): Promise<{ pos: string | null; tst: string | null; labels: string[] }> {
    return this.evaluate<{ pos: string | null; tst: string | null; labels: string[] }>(
      `(() => {
        const a = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className) && c.querySelectorAll(".hspotcrd_action").length > 0);
        return {
          pos: a ? (a.innerText||"").split("\\n")[0].trim() : null,
          tst: a ? (a.getAttribute("data-tst")||"").replace(/_active$/, "") : null,
          labels: a ? [...a.querySelectorAll(".hspotcrd_action")].map(x => (x.innerText||"").replace(/\\s+/g," ").trim()) : [],
        };
      })()`
    );
  }

  /**
   * Replay hero's own checks on a street so a facing-bet read happens at the
   * VILLAIN node. Position-aware and idempotent: the board deal often already
   * advances past hero's check (leaving the villain node active), so this only
   * clicks Check while HERO's own node is the active one, and stops the moment
   * a non-hero node is active. Clicking Check on the villain's node — which
   * also offers Check — would skip past the bet entirely (the classic bug).
   */
  async replayHeroChecks(heroSeat: string, maxChecks: number): Promise<{ ok: boolean; err?: string; clicked: number }> {
    let clicked = 0;
    for (let i = 0; i < maxChecks; i++) {
      const node = await this.activeNode();
      if (!node.tst || node.pos !== heroSeat) {
        // active node is the villain (or the street already advanced) — done
        return { ok: true, clicked };
      }
      const label = node.labels.find((l) => /^check/i.test(l));
      if (!label) {
        return { ok: false, err: `Hero's node (${node.pos}) has no Check (has: ${node.labels.join(", ")}).`, clicked };
      }
      const adv = await this.advanceViaAction(node.tst, label, { requireLegend: false });
      if (!adv.ok) return { ok: false, err: adv.err, clicked };
      clicked++;
    }
    return { ok: true, clicked };
  }

  /** The ordered decision points in the current line, with their actions. */
  async readSpots() {
    return this.evaluate<Array<{ label: string; actions: { txt: string; active: boolean }[] }>>(
      `[...document.querySelectorAll(".hspot-card")].map(c => {
        const label = (c.innerText||"").trim().split("\\n")[0].slice(0,14);
        const actions = [...c.querySelectorAll(".hspotcrd_action")].map(a => ({
          txt: (a.innerText||"").replace(/\\s+/g," ").trim(),
          active: /hspotcrd_action_active/.test(a.className),
        }));
        return { label, actions };
      }).filter(s => s.actions.length)`
    );
  }

  /** Navigate directly to a solution node via URL (line + active spot encoded). */
  async navigateToNode(gametype: string, depth: number, preflopActions: string, historySpot: number) {
    await this.evaluate<unknown>(
      `(() => { location.href = location.origin + "/solutions?gametype=" + ${JSON.stringify(gametype)} +
        "&depth=" + ${depth} + "&solution_type=gwiz&gmfs_solution_tab=ai_sols&soltab=strategy" +
        "&preflop_actions=" + ${JSON.stringify(preflopActions)} + "&history_spot=" + ${historySpot}; })()`
    );
    return { ok: true };
  }

  /** Click the Nth decision card itself (no action) — makes it the active node. */
  async selectSpot(spotIndex: number) {
    return this.evaluate<{ ok: boolean; label?: string; err?: string }>(
      `((idx) => {
        const cards = [...document.querySelectorAll(".hspot-card")].filter(c => c.querySelectorAll(".hspotcrd_action").length);
        const card = cards[idx];
        if (!card) return { ok: false, err: "no decision point at index " + idx };
        card.click();
        return { ok: true, label: (card.innerText||"").trim().split("\\n")[0] };
      })(${spotIndex})`
    );
  }

  /** Click the action whose text matches, on the Nth decision point in the line. */
  async setAction(spotIndex: number, action: string) {
    const expr = `((idx, txt) => {
      const cards = [...document.querySelectorAll(".hspot-card")].filter(c => c.querySelectorAll(".hspotcrd_action").length);
      const card = cards[idx];
      if (!card) return { ok:false, err:"no decision point at index "+idx };
      const norm = s => (s||"").replace(/\\s+/g," ").trim().toLowerCase();
      const acts = [...card.querySelectorAll(".hspotcrd_action")];
      const t = norm(txt);
      const target = acts.find(a => norm(a.innerText).startsWith(t)) || acts.find(a => norm(a.innerText).includes(t));
      if (!target) return { ok:false, err:"no action '"+txt+"' (have: "+acts.map(a=>norm(a.innerText)).join(", ")+")" };
      target.click();
      return { ok:true, clicked: target.innerText.replace(/\\s+/g," ").trim() };
    })(${spotIndex}, ${JSON.stringify(action)})`;
    return this.evaluate<{ ok: boolean; clicked?: string; err?: string }>(expr);
  }

  /**
   * Read GTO Wizard's strategy for a specific hand at the current node.
   * Parses the range-grid cell's layered gradient (colors = actions, widths =
   * frequencies) and maps colors to actions via the node's `.sab_btn` legend.
   */
  async readCombo(handInput: string) {
    const handClass = parseHandClass(handInput); // throws on bad input
    const expr = `((hand) => {
      const normColor = c => (c||"").replace(/\\s+/g,"");
      // legend: each action button carries its name (+ aggregate %) and swatch color
      const legend = [...document.querySelectorAll(".sab_btn")].map(b => {
        const raw = (b.querySelector(".sab_btn_name")?.innerText || b.innerText || "").replace(/\\s+/g," ").trim();
        const m = raw.match(/^(.*?)(\\d+(?:\\.\\d+)?)%$/);
        const action = (m ? m[1] : raw).trim();
        const rangePct = m ? parseFloat(m[2]) : null;
        // the action's swatch is a .sab_btn_back child; read its exact color
        const back = b.querySelector(".sab_btn_back");
        const color = back ? getComputedStyle(back).backgroundColor : null;
        return { action, rangePct, color };
      }).filter(l => l.action);
      if (!legend.length) return { ok:false, err:"No strategy legend on screen — open a solution node in Study." };

      const cell = document.querySelector('[data-tst^="range_table_cell"][data-tst$="_'+hand+'"]');
      if (!cell) return { ok:false, err:"Hand "+hand+" is not in the current range grid (wrong node or format?)." };

      // one color per gradient LAYER (each layer repeats its color as start+end stop)
      const colors = ((cell.style.backgroundImage || "").match(/linear-gradient\\(to right, rgb\\([^)]+\\)/g) || [])
        .map(layer => (layer.match(/rgb\\([^)]+\\)/) || [])[0]);
      const sizes = (getComputedStyle(cell).backgroundSize || "").split(",").map(s => parseFloat(s));
      // layered gradients: cumulative widths → per-layer frequency
      let prev = 0;
      const parts = colors.map((c, i) => {
        const cum = isNaN(sizes[i]) ? 100 : sizes[i];
        const freq = Math.max(0, cum - prev);
        prev = cum;
        return { color: normColor(c), freq };
      });
      const actions = parts.map(p => {
        const lg = legend.find(l => l.color && normColor(l.color) === p.color);
        return { action: lg ? lg.action : ("unknown "+p.color), frequency: Math.round(p.freq * 10) / 10 };
      }).filter(a => a.frequency >= 0.1).sort((a,b) => b.frequency - a.frequency);

      // current node label (whose turn it is) from the active decision card
      const node = [...document.querySelectorAll(".hspot-card")]
        .filter(c => /hspotcrd_active/.test(c.className)).map(c => (c.innerText||"").split("\\n")[0].trim())[0]
        || (document.title.match(/\\b(Preflop|Flop|Turn|River)\\b/i)||[])[0] || null;
      const board = (location.search.match(/board=([^&]*)/)||[])[1] || null;
      return { ok:true, hand, node, board, actions, legend: legend.map(l => ({ action:l.action, rangePct:l.rangePct })) };
    })(${JSON.stringify(handClass)})`;
    return this.evaluate<{
      ok: boolean;
      err?: string;
      hand?: string;
      node?: string | null;
      board?: string | null;
      actions?: { action: string; frequency: number }[];
      legend?: { action: string; rangePct: number | null }[];
    }>(expr);
  }

  /**
   * Per-combo strategy read (postflop): select the combo's hand class in the
   * range grid, then read the exact combo's row from GTO Wizard's Hands aside
   * panel — suit-specific (blocker-level) frequencies, not the class average.
   */
  async readComboExact(handInput: string) {
    const exact = parseExactCombo(handInput); // throws on malformed cards
    if (!exact) {
      return {
        ok: false as const,
        err: `Postflop reads need an exact combo (e.g. "AhKs") — "${handInput}" is a class, and suits matter once there's a board.`,
        needsExactCombo: true,
      };
    }
    const expr = `(async (cls, comboId) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const clickCell = (cell) => {
        const r = cell.getBoundingClientRect();
        const opts = { bubbles:true, cancelable:true, clientX:r.x+r.width/2, clientY:r.y+r.height/2 };
        for (const ev of ["pointerover","mouseover","pointerdown","mousedown","pointerup","mouseup","click"]) {
          cell.dispatchEvent(new MouseEvent(ev, opts));
        }
      };
      // the aside must be on the Hands tab to render per-combo cells
      const handsTab = document.querySelector("[data-tst=tab_hands]");
      if (handsTab && !/gtabs_tab_active/.test(handsTab.className)) { handsTab.click(); await wait(400); }
      const cell = [...document.querySelectorAll('[data-tst^="range_table_cell"]')]
        .find(c => (c.getAttribute("data-tst")||"").endsWith("_" + cls) && c.offsetWidth > 0);
      if (!cell) return { ok:false, err: "Hand class " + cls + " isn't in the visible range grid." };
      if (/rtc_folded/.test(cell.className)) return { ok:false, notInRange:true };
      // The aside keeps the last selection across node changes, so a pre-existing
      // cell for this combo may hold STALE strategy from an earlier node. Select a
      // different class first so the target's render is provably fresh.
      if ([...document.querySelectorAll(".study-combos_cell")].some(c => (c.id||"").endsWith("_" + comboId))) {
        const other = [...document.querySelectorAll('[data-tst^="range_table_cell"]')]
          .find(c => c.offsetWidth > 0 && !/rtc_folded/.test(c.className)
            && (c.style.backgroundImage||"").includes("gradient")
            && !(c.getAttribute("data-tst")||"").endsWith("_" + cls));
        if (other) {
          clickCell(other);
          for (let i = 0; i < 20; i++) {
            await wait(150);
            const ids = [...document.querySelectorAll(".study-combos_cell")].map(c => c.id || "");
            if (ids.length && ids.every(id => !id.endsWith("_" + comboId))) break;
          }
        }
      }
      clickCell(cell);
      let comboCell = null;
      for (let i = 0; i < 25 && !comboCell; i++) {
        await wait(150);
        comboCell = [...document.querySelectorAll(".study-combos_cell")].find(c => (c.id||"").endsWith("_" + comboId));
      }
      if (comboCell) await wait(250); // let the legend rows settle before reading
      if (!comboCell) {
        const shown = [...document.querySelectorAll(".study-combos_cell")].map(c => c.id.replace(/^\\d+_/, "")).join(", ");
        return { ok:false, err: "Combo panel didn't show " + comboId + (shown ? " (showing: " + shown + ")" : "") + "." };
      }
      const rows = [...comboCell.querySelectorAll(".htc_graph_legend_item")]
        .map(l => (l.innerText||"").replace(/\\s+/g," ").trim()).filter(Boolean);
      const legend = [...document.querySelectorAll(".sab_btn_name")]
        .map(e => (e.innerText||"").replace(/\\s+/g," ").trim()).filter(Boolean);
      const node = [...document.querySelectorAll(".hspot-card")]
        .filter(c => /hspotcrd_active/.test(c.className)).map(c => (c.innerText||"").split("\\n")[0].trim())[0] || null;
      const board = (location.search.match(/board=([^&]*)/)||[])[1] || null;
      return { ok:true, rows, legend, node, board };
    })(${JSON.stringify(exact.handClass)}, ${JSON.stringify(exact.comboId)})`;

    // The aside re-renders asynchronously on node changes and keeps its last
    // selection, so a read can come back with the PREVIOUS node's strategy.
    // Validate every combo action against the node's own legend (by canonical
    // action identity) and retry until they're consistent.
    let lastErr = "per-combo read failed";
    for (let attempt = 0; attempt < 4; attempt++) {
      const raw = await this.evaluate<{
        ok: boolean;
        err?: string;
        notInRange?: boolean;
        rows?: string[];
        legend?: string[];
        node?: string | null;
        board?: string | null;
      }>(expr, true);

      if (!raw.ok) {
        if (raw.notInRange) {
          return {
            ok: true as const,
            hand: exact.comboId,
            handClass: exact.handClass,
            actions: [] as ActionFreq[],
            notInRange: true,
            err: `${exact.handClass} isn't in the acting player's range at this node.`,
          };
        }
        return { ok: false as const, err: raw.err ?? "per-combo read failed" };
      }
      const boardCards: string[] = (raw.board ?? "").match(/[2-9TJQKA][hdcs]/gi) ?? [];
      const blocked = exact.cards.some((c) => boardCards.includes(c));
      if (blocked) {
        return {
          ok: false as const,
          err: `${exact.comboId} is impossible here — it shares a card with the board (${raw.board}).`,
        };
      }
      const actions = parseComboLegend(raw.rows ?? []);
      // Staleness gate: compare on action KIND, not exact size. Some sets
      // render the combo panel in bb ("Raise 12") but the node legend in pct
      // ("Raise 10%") — same node, different units — so a size-exact match
      // spuriously fails. A genuinely stale read (a different node's aside)
      // differs in kind-set (bet/check vs fold/call/raise), which this catches.
      const legendKinds = new Set(
        (raw.legend ?? []).map((l) => parseBetLabel(l)?.kind).filter(Boolean)
      );
      const consistent =
        legendKinds.size > 0 && actions.every((a) => legendKinds.has(parseBetLabel(a.action)?.kind));
      if (consistent && actions.length > 0) {
        return {
          ok: true as const,
          hand: exact.comboId,
          handClass: exact.handClass,
          node: raw.node,
          board: raw.board,
          actions,
          notInRange: false,
        };
      }
      // Empty legend right after a node change usually means the strategy
      // aside hasn't rendered yet — NOT that the combo is out of range (that
      // comes via raw.notInRange above). Retry rather than reporting empty.
      lastErr =
        actions.length === 0
          ? `Combo panel not rendered yet for ${exact.comboId}.`
          : `Combo panel showed stale strategy for ${exact.comboId} (kinds ${actions
              .map((a) => parseBetLabel(a.action)?.kind ?? "?")
              .join("/")} vs node legend kinds ${[...legendKinds].join("/")}).`;
      await this.sleep(900);
    }
    // Exhausted retries still empty — treat as genuinely not in range (a set
    // that doesn't flag raw.notInRange), otherwise surface the staleness error.
    if (/not rendered/.test(lastErr)) {
      return {
        ok: true as const,
        hand: exact.comboId,
        handClass: exact.handClass,
        actions: [] as ActionFreq[],
        notInRange: true,
      };
    }
    return { ok: false as const, err: lastErr };
  }

  /**
   * Route a hand read by street: preflop uses the class grid (suits don't
   * matter there), postflop demands an exact combo and reads it per-combo.
   */
  async readComboAuto(handInput: string) {
    const st = await this.status();
    if (st.board) return this.readComboExact(handInput);
    return this.readCombo(handInput);
  }

  /**
   * Read a combo's strategy at the current node and roll a single action from
   * its mix (weighted by frequency) — the action you'd actually take.
   */
  async decideCombo(handInput: string) {
    const read = await this.readComboAuto(handInput);
    if (!read.ok || !read.actions?.length) return read;
    const decision = pickWeightedAction(read.actions);
    return { ...read, decision };
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Poll an in-page boolean expression until true or timeout (robust to render lag). */
  private async waitUntil(expr: string, timeoutMs = 5000, intervalMs = 150): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.evaluate<boolean>(`!!(${expr})`)) return true;
      await this.sleep(intervalMs);
    }
    return false;
  }

  /**
   * Describe the active villain node: its stable `hs_<spot>_<street>_<pos>`
   * data-tst (for return navigation) and its available bet sizes as pot
   * fractions. Labels come in two formats depending on the solution set
   * ("Bet 1.8 (33%)" vs "Bet 75% (18.75)") — parseBetLabel handles both.
   * All-in counts as a size so oversized bets bracket against the jam.
   * Returns `null` when the active node isn't a betting decision.
   */
  private async villainBetNode() {
    const raw = await this.evaluate<{
      baseTst: string;
      position: string;
      labels: string[];
    } | null>(
      `(() => {
        const active = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className));
        if (!active) return null;
        const baseTst = (active.getAttribute("data-tst")||"").replace(/_active$/, "");
        if (!baseTst) return null;
        const pos = (active.innerText||"").split("\\n")[0].trim();
        const labels = [...active.querySelectorAll(".hspotcrd_action")]
          .map(a => (a.innerText||"").replace(/\\s+/g," ").trim()).filter(Boolean);
        return { baseTst, position: pos, labels };
      })()`
    );
    if (!raw) return null;
    const parsed = raw.labels.map((label) => ({ label, parsed: parseBetLabel(label) }));
    // a first-in betting node has Check + Bet options; facing nodes
    // (Fold/Call/Raise/Allin) must NOT qualify
    const kinds = new Set(parsed.map((p) => p.parsed?.kind));
    if (!kinds.has("check") || !kinds.has("bet")) return null;

    // Some solution sets label bets as pure bb amounts ("Bet 2") with no
    // percentage; derive the pot-fraction from the amount and the current
    // pot so size matching still works. The pot at a first-in node is the
    // pot BEFORE any bet on this street.
    const pot = await this.potAtActiveStreet();
    const bets = parsed
      .filter((b) => b.parsed && (b.parsed.kind === "bet" || b.parsed.kind === "allin"))
      .map((b) => {
        let pct = b.parsed!.pct ?? null;
        if (pct == null && b.parsed!.amount != null && pot && pot > 0) {
          pct = Math.round((b.parsed!.amount / pot) * 1000) / 10;
        }
        return pct != null ? { label: b.label, pct } : null;
      })
      .filter((b): b is { label: string; pct: number } => b !== null);
    if (!bets.length) return null;
    return { baseTst: raw.baseTst, position: raw.position, bets };
  }

  /**
   * Sync the solutions-menu Stacks filter to exactly `depth` (unchecking
   * other depths). The loaded solution is already depth-specific via the URL
   * and the header says so ("Cash 50bb…") — this makes the PICKER's Stacks
   * filter agree instead of showing "Any". Call it AFTER a walk finishes:
   * opening/closing the picker mid-walk races the tree clicks.
   */
  async syncStacksFilter(depth: number): Promise<void> {
    // The filter rows only exist while the solution PICKER is open (the
    // header's "Change" button, gmf_selector_opener) — open it if needed,
    // set the filter, and close it again. Entirely best-effort: the loaded
    // solution is already depth-specific via the URL; this just makes the
    // picker's Stacks filter agree instead of showing "Any".
    try {
      const hasRows = await this.evaluate<boolean>(`!!document.querySelector("[data-tst=chrow_100]")`);
      let openedPicker = false;
      if (!hasRows) {
        openedPicker = await this.evaluate<boolean>(
          `(() => { const b = document.querySelector("[data-tst=gmf_selector_opener]"); if (!b) return false; b.click(); return true; })()`
        );
        if (!openedPicker) return;
        const up = await this.waitUntil(`document.querySelector("[data-tst=chrow_100]")`, 4000, 200);
        if (!up) return;
      }
      await this.evaluate<unknown>(
        `(() => {
          const DEPTHS = [200, 150, 100, 75, 50, 40, 20];
          const active = (el) => /gw_btn_active/.test((el.className || "").toString());
          for (const d of DEPTHS) {
            const row = document.querySelector("[data-tst=chrow_" + d + "]");
            if (!row) continue;
            if (d === ${depth} ? !active(row) : active(row)) row.click();
          }
        })()`
      );
      await this.sleep(300);
      if (openedPicker) {
        await this.evaluate<unknown>(
          `(() => { const b = document.querySelector("[data-tst=gmf_selector_opener]"); if (b) b.click(); })()`
        );
        await this.waitUntil(`!document.querySelector("[data-tst=chrow_100]")`, 3000, 200);
        await this.sleep(200);
      }
    } catch {
      // never let a cosmetic filter sync break a walk
    }
  }

  /**
   * Wait until the preflop tree stops mutating. After a solution loads, the
   * app re-applies its previously-browsed line a beat later (t+2-3s) — a
   * click made before that lands gets OVERWRITTEN by the restore, which is
   * how walks "click Fold but Fold never becomes taken". Fingerprint = URL
   * params + which actions are marked taken; two identical samples 800ms
   * apart means the restore (if any) has landed.
   */
  private async waitForTreeSettle(maxMs = 8000): Promise<void> {
    let prev = "";
    let stable = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && stable < 2) {
      const fp = await this.evaluate<string>(
        `(() => {
          const acts = [...document.querySelectorAll(".hspot-card .hspotcrd_action")]
            .map(a => /hspotcrd_action_active/.test(a.className) ? "1" : "0").join("");
          return location.search + "|" + acts;
        })()`
      );
      if (fp === prev) stable++;
      else {
        stable = 0;
        prev = fp;
      }
      await this.sleep(800);
    }
  }

  /**
   * Close any lingering dialog (e.g. the SELECT BOARD card picker) that
   * overlays the strategy area. Dialogs persist across in-app navigation via
   * the ?dialogs= URL param, and while one is up the legend doesn't render.
   */
  private async closeStaleDialogs(): Promise<void> {
    const hadDialog = await this.evaluate<boolean>(
      `(() => {
        const c = document.querySelector("[data-tst=dialog_cards-dialog_close]")
          || document.querySelector(".dialog_content_close");
        if (!c) return false;
        c.click();
        return true;
      })()`
    );
    if (hadDialog) {
      await this.waitUntil(`!document.querySelector(".dialog_content_close")`, 3000, 200);
      await this.sleep(300);
    }
  }

  /** Click GTO Wizard's own solve action inside a blocking overlay — the
   * "Solve using ⚡ Fast Mode" recovery button (see `isFastModeRecoverable`),
   * or any solve offer the app shows on an off-tree node. Prefers an explicit
   * fast-mode button when both are present. */
  private async clickFastModeSolve(): Promise<boolean> {
    return this.evaluate<boolean>(
      `(() => {
        const btns = [...document.querySelectorAll(".gw_mesblock .gw_btn-v1, .gw_mesblock .gw_btn_primary, .gw_mesblock button")];
        const btn = btns.find(b => /fast mode/i.test(b.innerText||""))
          ?? btns.find(b => /\\bsolve\\b/i.test(b.innerText||"") && !/unsolve/i.test(b.innerText||""));
        if (!btn) return false;
        btn.click();
        return true;
      })()`
    );
  }

  /**
   * Off-tree postflop escape hatch: if the current blocking overlay offers a
   * solve (⚡ Fast Mode — seconds, not the minutes-long custom AI dialog),
   * click it and wait for the strategy grid. Returns true only when the grid
   * actually rendered — i.e. the node now has a usable solution in place.
   * Returns false untouched when no solve is offered (preflop off-tree spots
   * never get one: GTO Wizard AI solves are heads-up postflop only).
   */
  async tryFastSolveOverlay(): Promise<boolean> {
    if (!(await this.clickFastModeSolve())) return false;
    return this.waitUntil(
      `document.querySelectorAll(".study-combos_cell").length > 0 && document.querySelectorAll(".sab_btn_name").length > 0`,
      20000,
      500
    );
  }

  /** The action legend as one string — a fingerprint of the rendered node. */
  private async legendFingerprint(): Promise<string> {
    return this.evaluate<string>(
      `[...document.querySelectorAll(".sab_btn_name")].map(e => (e.innerText||"").replace(/\\s+/g," ").trim()).join("|")`
    );
  }

  /**
   * Click an action on a node and wait until the view has ACTUALLY advanced:
   * a different node is active AND — when a strategy grid is expected — the
   * legend changed (the grid, aside, and legend all lag together after
   * navigation, so the legend fingerprint is the freshness signal). Pass
   * requireLegend: false when the strategy panel may legitimately be empty —
   * e.g. walking preflop on the strategy tab with no board chosen, where the
   * panel shows "Choose board first" and no legend ever renders. Handles the
   * already-taken case: re-clicking the taken action is a no-op, so navigate
   * to the following node card instead.
   */
  private async advanceViaAction(
    baseTst: string,
    label: string,
    { requireLegend = true }: { requireLegend?: boolean } = {}
  ): Promise<{ ok: boolean; err?: string }> {
    const legendBefore = await this.legendFingerprint();
    const clicked = await this.evaluate<{ ok: boolean; wasTaken?: boolean }>(
      `(() => {
        const card = document.querySelector('[data-tst^="${baseTst}"]');
        const act = card && [...card.querySelectorAll(".hspotcrd_action")].find(a => (a.innerText||"").replace(/\\s+/g," ").trim() === ${JSON.stringify(label)});
        if (!act) return { ok:false };
        const wasTaken = /hspotcrd_action_active/.test(act.className);
        act.click();
        return { ok:true, wasTaken };
      })()`
    );
    if (!clicked.ok) return { ok: false, err: `Couldn't click "${label}".` };
    // Without a legend requirement, the unambiguous signal that the app
    // accepted the click is the action becoming the TAKEN one on its own
    // card — independent of which card is active, the legend, or any empty
    // board placeholders a restored line leaves lying around.
    const advCond = requireLegend
      ? `(() => {
          const a = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className));
          if (!a || (a.getAttribute("data-tst")||"").startsWith("${baseTst}")) return false;
          const legend = [...document.querySelectorAll(".sab_btn_name")].map(e => (e.innerText||"").replace(/\\s+/g," ").trim()).join("|");
          return legend.length > 0 && legend !== ${JSON.stringify(legendBefore)};
        })()`
      : `(() => {
          const card = document.querySelector('[data-tst^="${baseTst}"]');
          if (!card) return false;
          const act = [...card.querySelectorAll(".hspotcrd_action")].find(a => (a.innerText||"").replace(/\\s+/g," ").trim() === ${JSON.stringify(label)});
          return !!act && /hspotcrd_action_active/.test(act.className);
        })()`;
    let advanced = await this.waitUntil(advCond, clicked.wasTaken ? 4000 : 10000);
    if (!advanced && clicked.wasTaken) {
      const jumped = await this.evaluate<boolean>(
        `(() => {
          const cards = [...document.querySelectorAll(".hspot-card")];
          const i = cards.findIndex(c => (c.getAttribute("data-tst")||"").startsWith("${baseTst}"));
          if (i < 0) return false;
          const next = cards.slice(i + 1).find(c => c.querySelectorAll(".hspotcrd_action").length > 0);
          if (!next) return false;
          next.click();
          return true;
        })()`
      );
      if (jumped) advanced = await this.waitUntil(advCond, 8000);
    }
    if (!advanced) {
      return { ok: false, err: `View didn't advance to the response node after "${label}".` };
    }
    await this.sleep(500);
    return { ok: true };
  }

  /** Advance via a villain bet, read hero's response, return to the villain node. */
  private async navReadReturn(baseTst: string, betLabel: string, heroHand: string) {
    const adv = await this.advanceViaAction(baseTst, betLabel);
    if (!adv.ok) return { ok: false, err: adv.err };
    const resp = await this.readComboAuto(heroHand);
    // return to the villain node and confirm we're back
    await this.evaluate(
      `(() => { const c = document.querySelector('[data-tst^="${baseTst}"]'); if (c) c.click(); return !!c; })()`
    );
    await this.waitUntil(
      `(() => { const a=[...document.querySelectorAll('.hspot-card')].find(c=>/hspotcrd_active/.test(c.className)); return a && (a.getAttribute('data-tst')||'').startsWith('${baseTst}'); })()`
    );
    return resp;
  }

  /** Pot (bb) on the current street, from the last street group's label. */
  private async potAtActiveStreet(): Promise<number | null> {
    return this.evaluate<number | null>(
      `(() => {
        const ms = [...document.querySelectorAll(".hspot-card")]
          .map(c => (c.innerText||"").match(/\\b(FLOP|TURN|RIVER)\\s*([\\d.]+)/))
          .filter(Boolean);
        return ms.length ? parseFloat(ms[ms.length-1][2]) : null;
      })()`
    );
  }

  /**
   * Full current line for tier-2 replay: every street's dealt cards, pot, and
   * decision points with the action actually taken (the highlighted one).
   */
  async lineState(): Promise<LineState> {
    return this.evaluate<LineState>(
      `(() => {
        const cards = [...document.querySelectorAll(".hspot-card")];
        const streets = [];
        let current = { street: "preflop", cards: [], pot: null, actions: [] };
        streets.push(current);
        for (const c of cards) {
          const tst = (c.getAttribute("data-tst")||"").replace(/_active$/, "");
          if (c.querySelector(".card-row_card")) {
            const m = (c.innerText||"").match(/\\b(FLOP|TURN|RIVER)\\s*([\\d.]+)?/i);
            current = {
              street: m ? m[1].toLowerCase() : "?",
              // exact card incl. suit from the slot's data-tst ("Qh_0" → "Qh")
              cards: [...c.querySelectorAll(".card-row_card")]
                .filter(s => !/poker-card_empty/.test(s.className))
                .map(s => ((s.getAttribute("data-tst")||"").split("_")[0] || "")),
              pot: m && m[2] ? parseFloat(m[2]) : null,
              actions: [],
            };
            streets.push(current);
            continue;
          }
          const acts = [...c.querySelectorAll(".hspotcrd_action")];
          if (!acts.length) continue;
          const taken = acts.find(a => /hspotcrd_action_active/.test(a.className));
          current.actions.push({
            tst,
            position: (c.innerText||"").split("\\n")[0].trim(),
            active: /hspotcrd_active/.test(c.className),
            taken: taken ? (taken.innerText||"").replace(/\\s+/g," ").trim() : null,
            options: acts.map(a => (a.innerText||"").replace(/\\s+/g," ").trim()),
          });
        }
        const active = cards.find(c => /hspotcrd_active/.test(c.className));
        return {
          streets,
          activeTst: active ? (active.getAttribute("data-tst")||"").replace(/_active$/, "") : null,
          activePosition: active ? (active.innerText||"").split("\\n")[0].trim() : null,
          board: (location.search.match(/board=([^&]*)/)||[])[1] || null,
        };
      })()`
    );
  }

  /**
   * Tier 1 — pseudo-harmonic translation of an off-tree villain bet size.
   * At the active villain betting node, reads hero's response at the two
   * bracketing library sizes, then translates/measures agreement (the
   * exploitability proxy). Does not solve; navigates and restores in place.
   */
  async facingBet(heroHand: string, sizePct: number) {
    const node = await this.villainBetNode();
    if (!node) {
      return { ok: false, err: "The active node isn't a villain betting decision." };
    }
    const sizes = node.bets.map((b) => b.pct / 100);
    const x = sizePct / 100;
    const b = bracket(x, sizes);
    const labelFor = (frac: number) =>
      node.bets.find((bt) => Math.abs(bt.pct / 100 - frac) < 1e-9)?.label ?? null;
    const lowLabel = labelFor(b.low);
    const highLabel = labelFor(b.high);
    if (!lowLabel || !highLabel) {
      return { ok: false, err: `Couldn't map bracket sizes to villain bet actions.` };
    }

    const respLow = await this.navReadReturn(node.baseTst, lowLabel, heroHand);
    if (!respLow.ok) return { ok: false, err: `Low bracket read failed: ${respLow.err}` };
    const respHigh = b.clamped
      ? respLow
      : await this.navReadReturn(node.baseTst, highLabel, heroHand);
    if (!respHigh.ok) return { ok: false, err: `High bracket read failed: ${respHigh.err}` };

    // canonicalize labels (kind + pot %) — bb amounts differ between brackets
    // because the pot differs, but "Raise 100%" is the same action in both
    const aLow = canonicalizeActions((respLow.actions ?? []) as ActionFreq[]);
    const aHigh = canonicalizeActions((respHigh.actions ?? []) as ActionFreq[]);
    if (!aLow.length && !aHigh.length) {
      return {
        ok: true,
        tier: 1 as const,
        hand: respLow.hand,
        villain: node.position,
        sizePct,
        heroInRange: false,
        note: `${respLow.hand} isn't in hero's range at this node (folded earlier).`,
      };
    }
    const probLow = b.clamped ? 1 : pseudoHarmonicProbLow(x, b.low, b.high);
    const disagreement = totalVariation(aLow, aHigh);
    const blended = blend(aLow, aHigh, probLow);
    // pot-scaled tolerance: translation errors cost more in big pots. baseTol
    // 40 with pot in bb ≈ the old flat 8% in a 5bb SRP pot, tighter as it grows.
    const potBb = await this.potAtActiveStreet();
    const agreed = b.clamped || (potBb ? agrees(aLow, aHigh, potBb, 40) : agrees(aLow, aHigh));
    const decision = pickWeightedAction(blended);

    return {
      ok: true,
      tier: 1 as const,
      hand: respLow.hand,
      villain: node.position,
      sizePct,
      potBb,
      heroInRange: true,
      bracket: { low: b.low, high: b.high, clamped: b.clamped },
      probLow,
      disagreement,
      agreed,
      responseLow: { size: b.low, actions: aLow },
      responseHigh: { size: b.high, actions: aHigh },
      blended,
      decision,
    };
  }

  /**
   * Fully-automatic off-tree routing for the Combo Trainer. Given the size
   * villain bets at the active node, returns hero's correct response, choosing
   * the cheapest sound method:
   *   - `library`   : the size matches a preset within max(1.5pp, 6% of the
   *                   size) — the relative part absorbs rake-shaded sizes
   *                   (a "33%" bet of a raked 5.2bb pot reads ~31.5%) →
   *                   click it and ADVANCE the real line (free).
   *   - `translated`: off-tree, but the two bracketing library responses agree
   *                   (pot-scaled tolerance), so pseudo-harmonic translation
   *                   is exact (Tier 1, free).
   *   - `resolved`  : off-tree AND the brackets disagree → a live AI re-solve
   *                   of the CURRENT LINE with the size fixed into the tree —
   *                   flop, turn, or river — then replay to villain's node,
   *                   take the bet, and read hero per-combo (Tier 2, ~seconds
   *                   to ~a minute). The walkthrough continues in that tree.
   * Degrades gracefully: if a Tier-2 escalation can't complete, the Tier-1
   * translated answer is returned with `escalationError` set.
   */
  async respondToBet(heroHand: string, sizePct: number) {
    const node = await this.villainBetNode();
    if (!node) {
      return { ok: false as const, err: "The active node isn't a villain betting decision." };
    }
    const line = await this.lineState();
    // postflop responses are per-combo — suits matter, demand an exact combo
    if (line.board && !parseExactCombo(heroHand)) {
      return {
        ok: false as const,
        err: `Postflop needs an exact combo (e.g. "AhKs") — "${heroHand}" is a class, and suits matter once there's a board.`,
        needsExactCombo: true,
      };
    }

    // library-size match → villain genuinely bets an in-tree size, so ADVANCE
    // the real line — hero's node becomes active and the trainer reads there.
    const tol = Math.max(1.5, sizePct * 0.06);
    const match = node.bets.reduce(
      (best, b) =>
        best === null || Math.abs(b.pct - sizePct) < Math.abs(best.pct - sizePct) ? b : best,
      null as { label: string; pct: number } | null
    );
    if (match && Math.abs(match.pct - sizePct) <= tol) {
      const adv = await this.advanceViaAction(node.baseTst, match.label);
      if (!adv.ok) {
        return { ok: false as const, err: adv.err };
      }
      return {
        ok: true as const,
        route: "library" as const,
        advanced: true,
        villain: node.position,
        sizePct,
        matchedLabel: match.label,
        matchedPct: match.pct,
      };
    }

    // off-tree → Tier 1 translation (also gives the disagreement signal)
    const facing = await this.facingBet(heroHand, sizePct);
    if (!facing.ok) return facing;
    if (facing.heroInRange === false) {
      return { ...facing, route: "translated" as const };
    }
    if (facing.agreed) {
      return { ...facing, route: "translated" as const };
    }

    // brackets disagree → auto-escalate to a full-line AI re-solve (Tier 2),
    // works on flop, turn, and river
    let plan: LinePlan;
    try {
      plan = buildLinePlan(line, node.position);
    } catch (e) {
      return {
        ...facing,
        route: "translated" as const,
        escalationError: `Can't set up the AI re-solve (${e instanceof Error ? e.message : e}); showing the translated answer.`,
      };
    }
    const solve = await this.aiSolveLine(heroHand, sizePct, plan);
    if (!solve.ok) {
      return {
        ...facing,
        route: "translated" as const,
        solveMs: solve.solveMs,
        solvedBets: solve.solvedBets,
        escalationError: `AI re-solve failed (${solve.error}); showing the translated answer.`,
      };
    }
    const actions2 = (solve.actions ?? []) as ActionFreq[];
    if (!actions2.length) {
      return {
        ...facing,
        route: "translated" as const,
        solveMs: solve.solveMs,
        solvedBets: solve.solvedBets,
        escalationError: solve.notInRange
          ? `${solve.hand} isn't in hero's range at this node of the re-solved tree.`
          : "Re-solved, but hero's response couldn't be read — inspect it in GTO Wizard.",
      };
    }
    return {
      ok: true as const,
      route: "resolved" as const,
      tier: 2 as const,
      villain: node.position,
      sizePct,
      street: plan.offTreeStreet,
      board: solve.board,
      solveMs: solve.solveMs,
      solvedBets: solve.solvedBets,
      matchedLabel: solve.matchedLabel,
      hand: solve.hand,
      heroInRange: true,
      actions: actions2,
      decision: pickWeightedAction(actions2),
      // the walkthrough continues inside the re-solved tree from here
      continuedInTree: true,
      // keep the translated view too, for the "before/after" teaching comparison
      translated: { blended: facing.blended, disagreement: facing.disagreement },
    };
  }

  /**
   * Completion signal for AI solves and on-demand street solves: the strategy
   * signature (populated grid cells + action legend) staying stable across two
   * consecutive polls. Stale prior data makes single reads unreliable.
   */
  private async waitForStrategyStable(timeoutMs = 25000): Promise<boolean> {
    const sigExpr = `(() => {
      const grad = [...document.querySelectorAll(".ra_table_cell")].filter(c => (c.style.backgroundImage||"").includes("gradient")).length;
      const sab = [...document.querySelectorAll(".sab_btn_name")].map(e => (e.innerText||"").replace(/\\s+/g," ").trim()).join("|");
      return grad + "::" + sab;
    })()`;
    let prev = "";
    let stable = 0;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && stable < 2) {
      await this.sleep(700);
      const sig = await this.evaluate<string>(sigExpr);
      if (sig === prev && sig.length > 5 && !sig.endsWith("::")) stable++;
      else stable = 0;
      prev = sig;
    }
    return stable >= 2;
  }

  /**
   * Tier 2 — run a live GTO Wizard AI solve for a flop board. Drives the
   * "New solution" flow (spot selector → Custom solutions → Create solution →
   * green solve button → board picker), sets the board (which triggers the
   * solve), and waits for the fresh solution to load. Solves take ~2-20s.
   * The current spot's positions/stack/rake are inherited.
   *
   * If `betSizePct` is given, the bet tree is restricted to that single fixed
   * size (Option 1 for off-tree handling: solve the equilibrium where villain's
   * only bet size is the observed size, giving hero the GTO response to it).
   * Otherwise the AI picks sizes automatically.
   */
  async aiSolve(boardInput: string, betSizePct?: number) {
    const cards = parseCards(boardInput);
    if (cards.length !== 3) {
      return { ok: false, error: `AI solve needs a 3-card flop, got ${cards.length}.` };
    }
    const target = cards.join(""); // e.g. "QhJh2s"

    // 0. clear any stale dialog / drawing overlay first
    await this.evaluate(
      `(() => { const c = document.querySelector("[data-tst=dialog_solfigr-create-custom-solution-dialog_close]") || document.querySelector(".dialog_content_close"); if (c) c.click(); })()`
    );
    await this.sleep(300);

    // 1. open the custom-solution config: spot selector → Custom solutions tab → New solution
    await this.evaluate(`(() => { document.querySelector("[data-tst=gmf_selector_opener]")?.click(); })()`);
    await this.waitUntil(`document.querySelector("[data-tst=tab_ai_sols]")`, 4000);
    await this.evaluate(`(() => { document.querySelector("[data-tst=tab_ai_sols]")?.click(); })()`);
    await this.waitUntil(`document.querySelector("[data-tst=create_new_custom_solution]")`, 4000);
    await this.evaluate(`(() => { document.querySelector("[data-tst=create_new_custom_solution]")?.click(); })()`);
    const dialogOpen = await this.waitUntil(`document.querySelector("[data-tst^=dialog_solfigr]")`, 6000);
    if (!dialogOpen) return { ok: false, error: "Couldn't open the AI solution config dialog." };

    // 1b. Option 1: restrict the bet tree to a single fixed size = the observed
    // off-tree size. Switch both seats to Fixed mode and set the bet-size inputs.
    if (betSizePct && betSizePct > 0) {
      await this.evaluate(
        `(() => { [...document.querySelectorAll("[data-tst=bet_size_fixed]")].forEach(e => e.click()); })()`
      );
      await this.sleep(500);
      // Grab the visible flop bet-size inputs. These are Vue-model bound, so a
      // plain `.value =` is silently reverted by the framework (the solve then
      // uses the 60% default). Real keystrokes DO stick — we focus+select each
      // input and type the size with CDP Input.insertText.
      const n = await this.evaluate<number>(
        `(() => {
          const sec = document.querySelector("[data-tst=solfigr_betsizes]");
          if (!sec) return 0;
          const ins = [...sec.querySelectorAll("input")].filter(i => i.offsetWidth > 0).slice(0, 6);
          window.__betInputs = ins;
          return ins.length;
        })()`
      );
      if (!n) return { ok: false, error: "Couldn't find the fixed bet-size inputs in the config." };
      for (let k = 0; k < n; k++) {
        await this.evaluate(`(() => { const i = window.__betInputs[${k}]; i.focus(); i.select(); })()`);
        await this.rpc("Input.insertText", { text: String(betSizePct) });
        await this.evaluate(
          `(() => { const i = window.__betInputs[${k}]; i.dispatchEvent(new Event("change", { bubbles: true })); i.blur(); })()`
        );
      }
      // confirm the typed value actually landed before spending the solve
      const applied = await this.evaluate<boolean>(
        `(() => { const i = window.__betInputs && window.__betInputs[0]; return !!i && String(i.value) === String(${betSizePct}); })()`
      );
      if (!applied) return { ok: false, error: "Fixed bet size didn't apply to the config inputs." };
      await this.sleep(200);
    }

    // 2. click the GREEN solve button (btn_..., not the transparent wrapper).
    // Retry — the click can race the dialog render, and the board picker won't appear.
    let pickerUp = false;
    for (let attempt = 0; attempt < 3 && !pickerUp; attempt++) {
      await this.evaluate(`(() => { document.querySelector("[data-tst=btn_create_custom_solution]")?.click(); })()`);
      pickerUp = await this.waitUntil(`document.querySelector("[data-tst^=cards_dialog_available]")`, 3500);
    }
    if (!pickerUp) {
      return { ok: false, error: "Board picker didn't open after the solve button." };
    }

    // 3. set the board — picking 3 cards triggers the solve. The picker's cards
    // need a beat to become interactive after it appears; set + verify + retry.
    await this.sleep(600);
    const t0 = Date.now();
    let boardShown = false;
    for (let attempt = 0; attempt < 3 && !boardShown; attempt++) {
      await this.evaluate(
        `(() => { ${JSON.stringify(cards)}.forEach(c => document.querySelector("[data-tst=cards_dialog_available_"+c+"]")?.click()); })()`
      );
      // the title switching to the board confirms the pick registered
      boardShown = await this.waitUntil(
        `document.title.replace(/\\s/g,"").includes(${JSON.stringify(target)})`,
        5000,
        300
      );
      if (!boardShown) await this.sleep(600);
    }
    if (!boardShown) {
      return { ok: false, error: `Board ${target} never loaded — the board picker didn't take.`, solveMs: Date.now() - t0 };
    }

    // 4. wait for the solve to finish. The title/grid update to the new board
    // immediately (stale data lingers), so completion = the strategy SIGNATURE
    // (populated grid + action frequencies) staying stable across two polls.
    let loaded = await this.waitForStrategyStable(25000);

    // When a fixed size was requested, the stale prior solution can hold the
    // signature stable for a beat before the new grid renders. Confirm the
    // loaded strategy's bet label actually shows the requested size — that's a
    // direct, unambiguous signal the fresh solve (not stale data) is on screen.
    if (loaded && betSizePct && betSizePct > 0) {
      loaded = await this.waitUntil(
        `[...document.querySelectorAll(".sab_btn_name")].some(e => /Bet\\s+${betSizePct}(?:\\.0)?%/.test(e.innerText||""))`,
        8000,
        400
      );
    }
    const solveMs = Date.now() - t0;

    // 5. exit drawing mode if it lingers
    await this.evaluate(
      `(() => { const c = document.querySelector("[data-tst=dialog_cards-dialog_close]") || document.querySelector(".dialog_content_close"); if (document.querySelector(".canvas-paint_container.active") && c) c.click(); })()`
    );

    if (!loaded) {
      return { ok: false, error: `Solve didn't load within 30s (board ${target}).`, solveMs };
    }
    // read back the solved bet label so callers can confirm the size took
    const solvedBets = await this.evaluate<string[]>(
      `[...document.querySelectorAll(".sab_btn_name")].map(e => (e.innerText||"").replace(/\\s+/g," ").trim())`
    );
    return { ok: true, board: target, betSizePct: betSizePct ?? null, solvedBets, solveMs };
  }

  /** Open the custom-solution config: spot selector → Custom solutions → New solution. */
  private async openCreateDialog(): Promise<{ ok: boolean; error?: string }> {
    await this.evaluate(
      `(() => { const c = document.querySelector("[data-tst=dialog_solfigr-create-custom-solution-dialog_close]") || document.querySelector(".dialog_content_close"); if (c) c.click(); })()`
    );
    await this.sleep(300);
    await this.evaluate(`(() => { document.querySelector("[data-tst=gmf_selector_opener]")?.click(); })()`);
    await this.waitUntil(`document.querySelector("[data-tst=tab_ai_sols]")`, 4000);
    await this.evaluate(`(() => { document.querySelector("[data-tst=tab_ai_sols]")?.click(); })()`);
    await this.waitUntil(`document.querySelector("[data-tst=create_new_custom_solution]")`, 4000);
    await this.evaluate(`(() => { document.querySelector("[data-tst=create_new_custom_solution]")?.click(); })()`);
    const ok = await this.waitUntil(`document.querySelector("[data-tst^=dialog_solfigr]")`, 6000);
    return ok ? { ok: true } : { ok: false, error: "Couldn't open the AI solution config dialog." };
  }

  /**
   * Prefill positions/ranges/pot/stack/rake via the shortcuts dialog:
   * select the two seats on the table graphic, pick the preflop scenario
   * (SRP/3bet/...), confirm. GTO Wizard fills the config from its own library.
   */
  private async prefillScenario(
    seats: [string, string],
    scenario: LinePlan["scenario"]
  ): Promise<{ ok: boolean; error?: string }> {
    // the create dialog renders its content async — wait for the button, and
    // retry the click in case it lands before the handler is attached
    const btnUp = await this.waitUntil(`document.querySelector("[data-tst=solfigr_prefill_button]")`, 8000);
    if (!btnUp) return { ok: false, error: "Prefill button never appeared in the config dialog." };
    let open = false;
    for (let attempt = 0; attempt < 3 && !open; attempt++) {
      await this.evaluate(`(() => { document.querySelector("[data-tst=solfigr_prefill_button]")?.click(); })()`);
      open = await this.waitUntil(`document.querySelector("[data-tst=solfigr_shortcutdialog]")`, 4000);
    }
    if (!open) return { ok: false, error: "Prefill shortcuts dialog didn't open." };
    const chrow =
      scenario === "SRP" ? "chrow_SRP"
      : scenario === "3bet" ? "chrow_3bet"
      : scenario === "4bet" ? "chrow_4bet"
      : scenario === "5bet" ? "chrow_5bet"
      : "chrow_limp";
    const result = await this.evaluate<{ ok: boolean; error?: string }>(
      `(async (seatA, seatB, chrowTst) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const dlg = document.querySelector("[data-tst=solfigr_shortcutdialog]")?.closest(".dialog_container") || document;
        for (const pos of [seatA, seatB]) {
          const seat = dlg.querySelector("[data-tst=shortcuts_ptabl_seat_" + pos + "] .player");
          if (!seat) return { ok:false, error: "No seat control for " + pos + " in the prefill dialog." };
          seat.click();
          await wait(400);
        }
        let row = dlg.querySelector("[data-tst=" + chrowTst + "]");
        // seat clicks TOGGLE selection — if a stale selection left the scenario
        // disabled, re-click both seats once to flip them back on.
        for (let retry = 0; retry < 2 && (!row || /gw_btn_disabled/.test(row.className)); retry++) {
          for (const pos of [seatA, seatB]) {
            dlg.querySelector("[data-tst=shortcuts_ptabl_seat_" + pos + "] .player")?.click();
            await wait(400);
          }
          row = dlg.querySelector("[data-tst=" + chrowTst + "]");
        }
        if (!row) return { ok:false, error: "No scenario row " + chrowTst + " in the prefill dialog." };
        if (/gw_btn_disabled/.test(row.className)) return { ok:false, error: chrowTst + " unavailable for seats " + seatA + "/" + seatB + "." };
        row.click();
        await wait(400);
        const confirm = [...dlg.querySelectorAll("*")].find(e => (e.innerText||"").trim() === "CONFIRM" && e.children.length === 0);
        if (!confirm || /disabled/.test(confirm.className)) return { ok:false, error: "Prefill CONFIRM unavailable." };
        confirm.click();
        return { ok:true };
      })(${JSON.stringify(seats[0])}, ${JSON.stringify(seats[1])}, ${JSON.stringify(chrow)})`,
      true
    );
    if (!result.ok) return result;
    await this.waitUntil(`!document.querySelector("[data-tst=solfigr_shortcutdialog]")`, 5000);
    await this.sleep(600);
    return { ok: true };
  }

  /**
   * Fill a seat's Fixed bet-size list on the currently-open street tab:
   * add/remove slots to match, then type each size (the inputs are Vue-model
   * bound, so values must arrive as real keystrokes via Input.insertText).
   */
  private async setFixedSizes(
    seat: "oop" | "ip",
    sizes: number[]
  ): Promise<{ ok: boolean; error?: string }> {
    const blockSel = `document.querySelector("[data-tst=solfigr_betsizes] .solfigrssz_player_${seat} [data-tst=bet_sizes]")`;
    const counted = await this.evaluate<number>(
      `(async (want) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const block = ${blockSel};
        if (!block) return -1;
        for (let guard = 0; guard < 12; guard++) {
          const inputs = [...block.querySelectorAll("input")].filter(i => i.offsetWidth > 0);
          if (inputs.length === want) break;
          if (inputs.length < want) block.querySelector("[data-tst=add_size]")?.click();
          else [...block.querySelectorAll("[data-tst=remmove_size]")].pop()?.click();
          await wait(250);
        }
        const inputs = [...block.querySelectorAll("input")].filter(i => i.offsetWidth > 0);
        window.__betInputs = inputs;
        return inputs.length;
      })(${sizes.length})`,
      true
    );
    if (counted !== sizes.length) {
      return {
        ok: false,
        error: `Couldn't get ${sizes.length} fixed size slot(s) for ${seat.toUpperCase()} (got ${counted}).`,
      };
    }
    for (let k = 0; k < sizes.length; k++) {
      await this.evaluate(`(() => { const i = window.__betInputs[${k}]; i.focus(); i.select(); })()`);
      await this.rpc("Input.insertText", { text: String(sizes[k]) });
      await this.evaluate(
        `(() => { const i = window.__betInputs[${k}]; i.dispatchEvent(new Event("change", { bubbles: true })); i.blur(); })()`
      );
    }
    const applied = await this.evaluate<boolean>(
      `(() => {
        const want = ${JSON.stringify(sizes.map(String))};
        return window.__betInputs.length === want.length && window.__betInputs.every((i, k) => String(i.value) === want[k]);
      })()`
    );
    return applied
      ? { ok: true }
      : { ok: false, error: `Fixed sizes didn't stick for ${seat.toUpperCase()}.` };
  }

  /**
   * Configure one street tab of the bet-sizes section. Per seat:
   * number[] → Fixed with exactly those sizes, null → Automatic. Any
   * "Using Flop settings" / "Apply same settings" inheritance is disabled
   * first so the street's config is explicit.
   */
  private async configureStreetSizes(
    street: PostflopStreet,
    oopSizes: number[] | null,
    ipSizes: number[] | null
  ): Promise<{ ok: boolean; error?: string }> {
    const tabOk = await this.evaluate<boolean>(
      `(() => {
        const sec = document.querySelector("[data-tst=solfigr_betsizes]");
        const tab = sec && [...sec.querySelectorAll("*")].find(e => (e.innerText||"").trim().toLowerCase() === ${JSON.stringify(street)} && e.offsetWidth > 0 && e.children.length === 0);
        if (!tab) return false;
        tab.click();
        return true;
      })()`
    );
    if (!tabOk) return { ok: false, error: `No ${street} tab in the bet-sizes config.` };
    await this.sleep(500);

    for (const [seat, sizes] of [
      ["oop", oopSizes],
      ["ip", ipSizes],
    ] as const) {
      // break street/seat inheritance ("Using Flop settings" / "Apply same
      // settings as …") so this street's mode is explicit for this seat
      await this.evaluate(
        `(async () => {
          const wait = ms => new Promise(r => setTimeout(r, ms));
          const block = document.querySelector("[data-tst=solfigr_betsizes] .solfigrssz_player_${seat}");
          if (!block) return;
          for (let guard = 0; guard < 4; guard++) {
            const dis = [...block.querySelectorAll("*")].find(e => (e.innerText||"").trim() === "Disable" && e.offsetWidth > 0 && e.children.length <= 1);
            if (!dis) break;
            dis.click();
            await wait(400);
          }
        })()`,
        true
      );
      const modeTst = sizes === null ? "bet_size_automatic" : "bet_size_fixed";
      const modeOk = await this.evaluate<boolean>(
        `(() => {
          const block = document.querySelector("[data-tst=solfigr_betsizes] .solfigrssz_player_${seat}");
          const btn = block && block.querySelector("[data-tst=${modeTst}]");
          if (!btn) return false;
          btn.click();
          return true;
        })()`
      );
      if (!modeOk) {
        return { ok: false, error: `Couldn't set ${seat.toUpperCase()} ${street} bet mode.` };
      }
      // verify the mode actually activated — a click on a hidden/inert button
      // "succeeds" silently and the street would keep its inherited config
      const modeActive = await this.waitUntil(
        `(() => { const b = document.querySelector("[data-tst=solfigr_betsizes] .solfigrssz_player_${seat} [data-tst=${modeTst}]"); return !!b && /gw_btn_active/.test(b.className); })()`,
        4000
      );
      if (!modeActive) {
        return {
          ok: false,
          error: `${seat.toUpperCase()} ${street} bet mode didn't activate (inheritance not disabled?).`,
        };
      }
      await this.sleep(400);
      if (sizes !== null) {
        const fill = await this.setFixedSizes(seat, sizes);
        if (!fill.ok) return fill;
      }
    }
    return { ok: true };
  }

  /** Click the green solve button, pick the flop, await the fresh solution. */
  private async createSolutionAndAwait(flopCards: string[], expectPct?: number) {
    let pickerUp = false;
    for (let attempt = 0; attempt < 3 && !pickerUp; attempt++) {
      await this.evaluate(`(() => { document.querySelector("[data-tst=btn_create_custom_solution]")?.click(); })()`);
      pickerUp = await this.waitUntil(`document.querySelector("[data-tst^=cards_dialog_available]")`, 3500);
    }
    if (!pickerUp) return { ok: false as const, error: "Board picker didn't open after the solve button." };

    await this.sleep(600);
    const target = flopCards.join("");
    const t0 = Date.now();
    // picking all 3 cards closes the picker and starts the solve — the picker
    // disappearing is the acceptance signal (the title can't be trusted: the
    // library view often already shows the same board)
    let accepted = false;
    for (let attempt = 0; attempt < 3 && !accepted; attempt++) {
      await this.evaluate(
        `(() => { ${JSON.stringify(flopCards)}.forEach(c => document.querySelector("[data-tst=cards_dialog_available_"+c+"]")?.click()); })()`
      );
      accepted = await this.waitUntil(
        `!document.querySelector("[data-tst^=cards_dialog_available]")`,
        5000,
        300
      );
      if (!accepted) await this.sleep(600);
    }
    if (!accepted) {
      return { ok: false as const, error: `Board picker didn't accept ${target}.`, solveMs: Date.now() - t0 };
    }
    // creation signal: the app switches to the custom solution…
    const custom = await this.waitUntil(`location.search.includes("solution_type=custom")`, 30000, 500);
    if (!custom) {
      return { ok: false as const, error: "Custom solution never loaded after the solve.", solveMs: Date.now() - t0 };
    }
    // …and an active decision node appears once the flop solve finishes
    const nodeUp = await this.waitUntil(
      `[...document.querySelectorAll(".hspot-card")].some(c => /hspotcrd_active/.test(c.className) && c.querySelectorAll(".hspotcrd_action").length > 0)`,
      60000,
      600
    );
    if (!nodeUp) {
      return { ok: false as const, error: `Solve of ${target} didn't produce a decision node within 60s.`, solveMs: Date.now() - t0 };
    }

    let loaded = await this.waitForStrategyStable(25000);
    if (loaded && expectPct != null) {
      // stale data can hold the signature stable — demand the requested size on screen
      loaded = await this.waitUntil(
        `[...document.querySelectorAll(".sab_btn_name")].some(e => /Bet[^%]*\\b${expectPct}(?:\\.0)?%/.test(e.innerText||""))`,
        8000,
        400
      );
    }
    const solveMs = Date.now() - t0;
    await this.evaluate(
      `(() => { const c = document.querySelector("[data-tst=dialog_cards-dialog_close]") || document.querySelector(".dialog_content_close"); if (document.querySelector(".canvas-paint_container.active") && c) c.click(); })()`
    );
    if (!loaded) return { ok: false as const, error: `Solve didn't load within 30s (board ${target}).`, solveMs };
    const solvedBets = await this.evaluate<string[]>(
      `[...document.querySelectorAll(".sab_btn_name")].map(e => (e.innerText||"").replace(/\\s+/g," ").trim())`
    );
    return { ok: true as const, board: target, solvedBets, solveMs };
  }

  /**
   * Click one taken-action label on the ACTIVE node during replay. Exact
   * normalized text first; else match by action kind + pot % within 1.5pp —
   * bb amounts can shift with pot rounding between the library and the
   * re-solved tree, but the pot fraction is what identifies the action.
   */
  private async clickActiveAction(label: string) {
    const want = parseBetLabel(label);
    const clicked = await this.evaluate<{ ok: boolean; err?: string; clicked?: string }>(
      `(async (wantLabel, wantKind, wantPct) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const norm = s => (s||"").replace(/\\s+/g," ").trim().toLowerCase();
        // the next node renders a beat after the previous click — poll for it
        let active = null;
        for (let i = 0; i < 15 && !active; i++) {
          active = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className) && c.querySelectorAll(".hspotcrd_action").length > 0);
          if (!active) await wait(700);
        }
        if (!active) return { ok:false, err: "replay: no active node for '" + wantLabel + "'" };
        const acts = [...active.querySelectorAll(".hspotcrd_action")].map(a => ({ el:a, txt:(a.innerText||"").replace(/\\s+/g," ").trim() }));
        let hit = acts.find(a => norm(a.txt) === norm(wantLabel));
        if (!hit && wantKind) {
          const kindRe = new RegExp("^" + wantKind, "i");
          const cands = acts.filter(a => kindRe.test(a.txt));
          if (wantPct == null) hit = cands[0];
          else {
            let best = null, bestD = 1e9;
            for (const c of cands) {
              const m = (c.txt.match(/(\\d+(?:\\.\\d+)?)\\s*%/) || [])[1];
              if (m == null) continue;
              const d = Math.abs(parseFloat(m) - wantPct);
              if (d < bestD) { bestD = d; best = c; }
            }
            if (best && bestD <= 1.5) hit = best;
          }
        }
        if (!hit) return { ok:false, err: "replay: no action matching '" + wantLabel + "' (have: " + acts.map(a=>a.txt).join(", ") + ")" };
        hit.el.click();
        return { ok:true, clicked: hit.txt };
      })(${JSON.stringify(label)}, ${JSON.stringify(want?.kind ?? null)}, ${JSON.stringify(want?.pct ?? null)})`,
      true
    );
    if (!clicked.ok) return clicked;
    await this.sleep(900);
    return clicked;
  }

  /**
   * Deal one turn/river card during replay, then wait out the on-demand
   * street solve the custom solution runs for newly-reached streets.
   */
  private async dealStreetCard(card: string) {
    const res = await this.evaluate<{ ok: boolean; err?: string }>(
      `(async (card) => {
        const wait = ms => new Promise(r => setTimeout(r, ms));
        const groups = [...document.querySelectorAll(".hspot-card")].filter(c => c.querySelector(".poker-card_empty"));
        const slotCard = groups.length ? groups[groups.length-1] : null;
        if (!slotCard) return { ok:false, err: "no empty card slot — is the betting round closed?" };
        slotCard.querySelector(".card-row_card").click();
        await wait(400);
        const el = document.querySelector('[data-tst="cards_dialog_available_' + card + '"]');
        if (!el) {
          const c = document.querySelector('[data-tst="dialog_cards-dialog_close"]') || document.querySelector(".dialog_content_close");
          if (c) c.click();
          return { ok:false, err: "card unavailable in picker: " + card };
        }
        el.click();
        await wait(300);
        const close = document.querySelector('[data-tst="dialog_cards-dialog_close"]') || document.querySelector(".dialog_content_close");
        if (document.querySelector(".dialog_container") && close) close.click();
        return { ok:true };
      })(${JSON.stringify(card)})`,
      true
    );
    if (!res.ok) return res;
    const stable = await this.waitForStrategyStable(60000);
    return stable
      ? { ok: true as const }
      : { ok: false as const, err: `Strategy didn't stabilize after dealing the ${card}.` };
  }

  /** Replay the actual line inside the re-solved tree, street by street. */
  private async replayLine(plan: LinePlan): Promise<{ ok: boolean; err?: string }> {
    for (const seg of plan.replay) {
      if (seg.street === "turn" || seg.street === "river") {
        const card = seg.street === "turn" ? plan.boards.turn : plan.boards.river;
        if (!card) return { ok: false, err: `Missing ${seg.street} card for replay.` };
        const dealt = await this.dealStreetCard(card);
        if (!dealt.ok) return dealt;
      }
      for (const label of seg.labels) {
        const clicked = await this.clickActiveAction(label);
        if (!clicked.ok) return clicked;
      }
    }
    return { ok: true };
  }

  /**
   * Tier 2, any street — re-solve the CURRENT LINE with villain's off-tree
   * size fixed into the tree at the off-tree street (hero keeps automatic
   * sizes there; completed streets are fixed to the sizes actually taken so
   * the line replays), then replay to villain's node, take the bet, and read
   * hero's per-combo response. Leaves GTO Wizard in the re-solved tree so the
   * walkthrough continues there.
   */
  async aiSolveLine(heroHand: string, sizePct: number, plan: LinePlan) {
    const open = await this.openCreateDialog();
    if (!open.ok) return { ok: false as const, error: open.error };
    const pre = await this.prefillScenario(plan.seats, plan.scenario);
    if (!pre.ok) return { ok: false as const, error: pre.error };

    const villainSeat = plan.villainIsOOP ? ("oop" as const) : ("ip" as const);
    const order: PostflopStreet[] = ["flop", "turn", "river"];
    const oIdx = order.indexOf(plan.offTreeStreet);
    for (const street of order) {
      const sIdx = order.indexOf(street);
      let oop: number[] | null;
      let ip: number[] | null;
      if (sIdx < oIdx) {
        // completed street: both seats fixed to the sizes actually taken
        // (check-through streets have none → automatic, checks always exist)
        const sizes = plan.lineSizes[street] ?? null;
        oop = sizes;
        ip = sizes;
      } else if (sIdx === oIdx) {
        oop = villainSeat === "oop" ? [sizePct] : null;
        ip = villainSeat === "ip" ? [sizePct] : null;
      } else {
        oop = null;
        ip = null;
      }
      const cfg = await this.configureStreetSizes(street, oop, ip);
      if (!cfg.ok) return { ok: false as const, error: cfg.error };
    }

    const created = await this.createSolutionAndAwait(
      plan.boards.flop,
      plan.offTreeStreet === "flop" && plan.villainIsOOP ? sizePct : undefined
    );
    if (!created.ok) return created;
    // a fresh solve briefly leaves the previous spot's strip in the DOM
    await this.sleep(1200);

    const replayed = await this.replayLine(plan);
    if (!replayed.ok) {
      return { ok: false as const, error: replayed.err, solveMs: created.solveMs, solvedBets: created.solvedBets };
    }

    // villain's off-tree size is now a real tree action — take it
    await this.waitUntil(
      `[...document.querySelectorAll(".hspot-card")].some(c => /hspotcrd_active/.test(c.className) && c.querySelectorAll(".hspotcrd_action").length > 0)`,
      10000,
      500
    );
    const node = await this.villainBetNode();
    const bet = node?.bets.reduce(
      (best, b) =>
        best === null || Math.abs(b.pct - sizePct) < Math.abs(best.pct - sizePct) ? b : best,
      null as { label: string; pct: number } | null
    );
    if (!node || !bet || Math.abs(bet.pct - sizePct) > 1.5) {
      return {
        ok: false as const,
        error: `Re-solved, but villain's ${sizePct}% bet wasn't available at the replayed node.`,
        solveMs: created.solveMs,
        solvedBets: created.solvedBets,
      };
    }
    const adv = await this.advanceViaAction(node.baseTst, bet.label);
    if (!adv.ok) {
      return {
        ok: false as const,
        error: `${adv.err} (in the re-solved tree)`,
        solveMs: created.solveMs,
        solvedBets: created.solvedBets,
      };
    }
    await this.waitForStrategyStable(15000);

    const resp = await this.readComboExact(heroHand);
    if (!resp.ok) {
      return {
        ok: false as const,
        error: `Re-solved and advanced, but couldn't read hero: ${resp.err}`,
        solveMs: created.solveMs,
        solvedBets: created.solvedBets,
      };
    }
    return {
      ok: true as const,
      board: created.board,
      solveMs: created.solveMs,
      solvedBets: created.solvedBets,
      matchedLabel: bet.label,
      hand: resp.hand,
      actions: resp.actions,
      notInRange: resp.notInRange,
    };
  }

  /**
   * Street-gating state: whether cards can be set right now, mirroring GTO
   * Wizard — a street's empty card slots exist in the DOM only once the prior
   * street's action is closed. No slots ⇒ setting is blocked.
   */
  async boardState(): Promise<BoardState> {
    return this.evaluate<BoardState>(
      `(() => {
        const street = (document.title.match(/\\b(Preflop|Flop|Turn|River)\\b/i)||[])[1] || null;
        // Each street's cards live in a separate group; the settable one is the
        // deepest group with empty slots (deal), else the deepest dealt group (repick).
        const groups = [...document.querySelectorAll(".hspot-card")].filter(c => c.querySelector(".card-row_card"));
        const withEmpty = groups.filter(c => c.querySelector(".poker-card_empty"));
        const slotCard = withEmpty.length ? withEmpty[withEmpty.length-1] : (groups.length ? groups[groups.length-1] : null);
        const slots = slotCard ? [...slotCard.querySelectorAll(".card-row_card")] : [];
        const emptyCount = slots.filter(s => /poker-card_empty/.test(s.className)).length;
        const totalSlots = slots.length;
        // filledCards = the whole board so far (all groups), for display
        const filledCards = groups.flatMap(g => [...g.querySelectorAll(".card-row_card")].filter(s => !/poker-card_empty/.test(s.className)).map(s => (s.querySelector(".card-value")?.innerText||"").trim()));
        const slotLabel = slotCard ? ((slotCard.innerText.match(/\\b(FLOP|TURN|RIVER)\\b/i)||[])[0]||null) : null;
        const board = (location.search.match(/board=([^&]*)/)||[])[1] || null;
        const mode = totalSlots === 0 ? "locked" : (emptyCount > 0 ? "deal" : "repick");
        const expects = mode === "deal" ? emptyCount : mode === "repick" ? totalSlots : 0;
        const blockedReason = mode !== "locked" ? null
          : (street ? street + " action isn't closed yet — finish the betting round before dealing the next street." : "No board in this view.");
        return { street, slotLabel, settable: mode !== "locked", mode, emptyCount, totalSlots, expects, filledCards, board, blockedReason };
      })()`
    );
  }

  /**
   * Set the current street's card(s), gated by GTO Wizard's own state:
   *  - "deal": fill empty slots (fresh flop, or a newly-opened turn/river slot),
   *  - "repick": replace an already-dealt current street (reset + choose again).
   * The next street stays blocked until GTO Wizard exposes its slot (i.e. the
   * prior street's action has closed).
   */
  async setCards(input: string) {
    const cards = parseCards(input);
    const expr = `(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const groups = [...document.querySelectorAll(".hspot-card")].filter(c => c.querySelector(".card-row_card"));
      const withEmpty = groups.filter(c => c.querySelector(".poker-card_empty"));
      const slotCard = withEmpty.length ? withEmpty[withEmpty.length-1] : (groups.length ? groups[groups.length-1] : null);
      if (!slotCard) return { ok:false, blocked:true, reason:"No settable board — the current betting round isn't closed in GTO Wizard." };
      const label = (slotCard.innerText.match(/\\b(FLOP|TURN|RIVER)\\b/i)||["this street"])[0];
      const slots = [...slotCard.querySelectorAll(".card-row_card")];
      const empty = slots.filter(s => /poker-card_empty/.test(s.className));
      const cards = ${JSON.stringify(cards)};

      let clickTarget, needReset;
      if (empty.length > 0 && cards.length === empty.length) { clickTarget = empty[0]; needReset = false; }
      else if (empty.length === 0 && cards.length === slots.length) { clickTarget = slots[0]; needReset = true; }
      else if (empty.length === 0) {
        return { ok:false, blocked:true, reason:"The "+label+" is fully dealt — the next card unlocks only after its betting round closes (re-pick takes "+slots.length+" cards)." };
      } else {
        return { ok:false, err:"The "+label+" expects "+empty.length+" card(s) to deal, got "+cards.length+"." };
      }

      const closeDialog = () => { const c = document.querySelector('[data-tst="dialog_cards-dialog_close"]') || document.querySelector(".dialog_content_close"); if (document.querySelector(".dialog_container") && c) c.click(); };
      clickTarget.click();
      await wait(160);
      if (needReset) { const r = document.querySelector('[data-tst="btn_reset_cards"]'); if (r) { r.click(); await wait(120); } }
      for (const c of cards) {
        const el = document.querySelector('[data-tst="cards_dialog_available_'+c+'"]');
        if (!el) { closeDialog(); return { ok:false, err:"card not available (already on board or blocked): "+c }; }
        el.click();
        await wait(90);
      }
      await wait(150);
      closeDialog();
      const filled = [...document.querySelectorAll(".hspot-card")].filter(c=>c.querySelector(".card-row_card"))
        .flatMap(g => [...g.querySelectorAll(".card-row_card")].filter(s=>!/poker-card_empty/.test(s.className)).map(s=>(s.querySelector(".card-value")?.innerText||"").trim()));
      return { ok:true, mode: needReset ? "repick" : "deal", set: cards, filledCards: filled, board: (location.search.match(/board=([^&]*)/)||[])[1]||null };
    })()`;
    return this.evaluate<{
      ok: boolean;
      blocked?: boolean;
      reason?: string;
      err?: string;
      mode?: string;
      set?: string[];
      filledCards?: string[];
      board?: string | null;
    }>(expr, true);
  }

  /** Remove any action-filter pills from the strategy grid (idempotent). */
  async clearActionFilters(): Promise<boolean> {
    const cleared = await this.evaluate<boolean>(
      `(() => { const b = document.querySelector(".clear-all-btn"); if (b) { b.click(); return true; } return false; })()`
    );
    if (cleared) await this.waitUntil(`!document.querySelector(".filter-pills_pill")`, 3000);
    return cleared;
  }

  /**
   * Legend + per-hand strategy for every hand class at the current node.
   * Same layered-gradient parsing as readCombo, applied to all 169 cells.
   */
  async readNodeStrategy() {
    return this.evaluate<{
      board: string | null;
      position: string | null;
      potLabel: string | null;
      url: string;
      actions: { action: string; rangePct: number | null; combos: number | null; color: string | null }[];
      cells: { hand: string; inRange: boolean; actions: Record<string, number> }[];
    }>(`(() => {
      const normColor = c => (c||"").replace(/\\s+/g,"");
      const legend = [...document.querySelectorAll(".sab_btn")].map(b => {
        const raw = (b.querySelector(".sab_btn_name")?.innerText || b.innerText || "").replace(/\\s+/g," ").trim();
        const m = raw.match(/^(.*?)(\\d+(?:\\.\\d+)?)%$/);
        const action = (m ? m[1] : raw).trim();
        const rangePct = m ? parseFloat(m[2]) : null;
        const cm = ((b.querySelector(".sab_btn_combos")?.innerText||"").match(/([\\d.]+)/)||[])[1];
        const back = b.querySelector(".sab_btn_back");
        return { action, rangePct, combos: cm ? parseFloat(cm) : null, color: back ? normColor(getComputedStyle(back).backgroundColor) : null };
      }).filter(l => l.action);

      // The DOM can hold a second (hidden) grid copy; keep the copy that parsed data.
      const seen = new Map();
      for (const cell of document.querySelectorAll('[data-tst^="range_table_cell"]')) {
        const tst = cell.getAttribute("data-tst") || "";
        const hand = tst.slice(tst.lastIndexOf("_") + 1);
        if (!hand) continue;
        const prevCell = seen.get(hand);
        if (prevCell && (prevCell.inRange || Object.keys(prevCell.actions).length)) continue;
        const folded = /rtc_folded/.test(cell.className);
        const colors = ((cell.style.backgroundImage||"").match(/linear-gradient\\(to right, rgb\\([^)]+\\)/g) || [])
          .map(layer => (layer.match(/rgb\\([^)]+\\)/)||[])[0]);
        const sizes = (getComputedStyle(cell).backgroundSize||"").split(",").map(s => parseFloat(s));
        let prev = 0;
        const actions = {};
        colors.forEach((c, i) => {
          const cum = isNaN(sizes[i]) ? 100 : sizes[i];
          const freq = Math.max(0, cum - prev);
          prev = cum;
          const lg = legend.find(l => l.color === normColor(c));
          if (lg && freq >= 0.05) actions[lg.action] = Math.round(freq * 10) / 10;
        });
        seen.set(hand, { hand, inRange: !folded && colors.length > 0, actions });
      }

      const active = [...document.querySelectorAll(".hspot-card")].find(c => /hspotcrd_active/.test(c.className));
      const potM = [...document.querySelectorAll(".hspot-card")].map(c => (c.innerText||"").match(/\\b(FLOP|TURN|RIVER)\\s*([\\d.]+)/)).find(Boolean);
      return {
        board: (location.search.match(/board=([^&]*)/)||[])[1] || null,
        position: active ? (active.innerText||"").split("\\n")[0].trim() : null,
        potLabel: potM ? potM[2] : null,
        url: location.href,
        actions: legend,
        cells: [...seen.values()],
      };
    })()`);
  }

  /**
   * GTO Wizard's HANDS/DRAWS composition popup for one action's range,
   * opened via its tile's breakdown icon (hover-driven, so we synthesize
   * mouseenter/mouseleave) and parsed from the popup rows.
   */
  async readActionBuckets(actionLabel: string) {
    const expr = `(async (label) => {
      const wait = ms => new Promise(r => setTimeout(r, ms));
      const clean = s => (s||"").replace(/\\s+/g," ").trim();
      const btn = [...document.querySelectorAll(".sab_btn")].find(b => {
        const raw = clean(b.querySelector(".sab_btn_name")?.innerText || b.innerText);
        const m = raw.match(/^(.*?)(\\d+(?:\\.\\d+)?)%$/);
        return ((m ? m[1] : raw).trim()) === label;
      });
      if (!btn) return { ok: false, err: "action tile not found: " + label };
      const targets = [btn.querySelector(".gw_pop_menu_opener"), btn.querySelector(".sab_btn_breakdown")].filter(Boolean);
      for (const el of targets) {
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      }
      await wait(500);
      const pop = [...document.querySelectorAll("div")]
        .filter(e => e.offsetWidth > 100 && /HANDS/.test(e.innerText||"") && (e.innerText||"").length < 800)
        .sort((a,b) => (a.innerText||"").length - (b.innerText||"").length)[0];
      const rows = [];
      if (pop) {
        const lines = (pop.innerText||"").split("\\n").map(s => s.trim()).filter(Boolean);
        let section = null;
        for (let i = 0; i < lines.length; i++) {
          if (/^[A-Z ]{4,}$/.test(lines[i]) && !/%/.test(lines[i])) { section = lines[i]; continue; }
          const pm = (lines[i+1]||"").match(/^([\\d.]+)%$/);
          if (section && pm) { rows.push({ section, name: lines[i], pct: parseFloat(pm[1]) }); i++; }
        }
      }
      for (const el of targets) {
        el.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
      }
      return { ok: true, rows };
    })(${JSON.stringify(actionLabel)})`;
    return this.evaluate<{
      ok: boolean;
      err?: string;
      rows?: { section: string; name: string; pct: number }[];
    }>(expr, true);
  }
}

/**
 * Blocking overlays that navigation can clear ITSELF: "choose board first" is
 * just the no-board state, and the "something went wrong with this solution"
 * error goes away when setupSpot navigates to a fresh solution URL. Only true
 * outages (e.g. the 429 daily browsing limit) should stop a setup flow.
 */
export const isRecoverableBlocker = (b: {
  blocked: boolean;
  code?: string | null;
  message?: string;
}): boolean => {
  if (!b.blocked) return true;
  return b.code === "select_board_strategy";
};

/** GTO Wizard's own "Something went wrong with this solution" overlay — this
 * does NOT clear on its own; confirmed manually that clicking its "Solve
 * using Fast Mode" action is the actual fix. */
const isFastModeRecoverable = (b: { blocked: boolean; message?: string }): boolean =>
  b.blocked && /something went wrong with this solution/i.test(b.message ?? "");

export const gtowCdp = new GtowCdp();
