import { timed } from "../../services/answerTrace";
import {
  parsePanelFeed,
  rowsFromText,
  type PanelRow,
  type ParsedHand,
} from "../parsePanelFeed/parsePanelFeed";
import { normalizeHand } from "../normalizeHand/normalizeHand";
import { withStartStacks } from "../../utils/archivedHand/archivedHand";
import { StateReply } from "../../../../wrapper/src/contract";

/**
 * Resolve a hand from one of the four accepted sources — a Hand-shaped JSON
 * object, a pull from assistive-play's live /state, a panel-feed rows payload,
 * or those same rows pasted as text. Shared by the /ingest and /fast-solver
 * routes so both accept an identical body.
 */

export const DEFAULT_LIVE_URL = "http://localhost:7700";

export interface ResolveBody {
  rows?: PanelRow[] | { ok?: boolean; rows: PanelRow[] };
  text?: string;
  hand?: unknown;
  live?: boolean | { url?: string; table?: string };
}

export interface ResolvedHand {
  ok: true;
  /** The parsed hand (may be null when a live table has no active hand yet). */
  hand: ParsedHand | null;
  source: "live" | "rows" | "text" | "hand";
  warnings: string[];
  tableStatus: string | null;
  heroSittingOut: boolean;
  studyAnswersOn: boolean | null;
  /** The session's DECLARED strategy (services/strategies.ts id). The preflop piece
   *  that answers is resolved from this — never from a mode flag or an env var. */
  strategyId?: string | null;
  /** The wrapper's DECLARED session (sessions.py) — stamped on answers and solves. */
  sessionId?: string | null;
  /** STATE PROVENANCE from the wrapper's /hand (2026-09-19): the independent views of
   *  "hero to act", why the export says it is not hero's turn, hero's status word, and
   *  which betting line the export carries and whether it can be trusted. Live source
   *  only; absent for pasted/authored hands. */
  liveExtras?: LiveExtras;
}

export interface LiveExtras {
  buttonsUp: boolean;
  toActSources: { buttons?: boolean; ws?: boolean; actionOn?: boolean; wsAt?: number | null; timeBank?: number | null } | null;
  heroStatus: string | null;
  notToActWhy: string | null;
  lineSource: string | null;
  lineUncertain: string | null;
  lineNote: string | null;
}

const liveExtrasOf = (raw: unknown): LiveExtras | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const h = raw as Record<string, unknown>;
  if (!("buttonsUp" in h) && !("lineSource" in h)) return undefined;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    buttonsUp: h.buttonsUp === true,
    toActSources: typeof h.toActSources === "object" && h.toActSources !== null ? (h.toActSources as LiveExtras["toActSources"]) : null,
    heroStatus: str(h.heroStatus),
    notToActWhy: str(h.notToActWhy),
    lineSource: str(h.lineSource),
    lineUncertain: str(h.lineUncertain),
    lineNote: str(h.lineNote),
  };
};

export interface ResolveError {
  ok: false;
  status: number;
  error: string;
  /** Extra fields the caller may want to surface (e.g. tableStatus on a 409). */
  extra?: Record<string, unknown>;
}

/**
 * Promote a JSON paste in `text` to its true source (rows vs hand) in place, so
 * a single paste box accepts feed lines, a rows payload, or a whole Hand
 * object. Mutates `body`. Returns an error result if the paste looks like JSON
 * but doesn't parse.
 */
export function promoteTextJson(body: ResolveBody): ResolveError | null {
  if (body.hand != null || body.rows || typeof body.text !== "string") return null;
  const t = body.text.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(t) as unknown;
    if (
      Array.isArray(parsed) ||
      (typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { rows?: unknown }).rows))
    ) {
      body.rows = parsed as ResolveBody["rows"];
    } else {
      body.hand = parsed;
    }
    body.text = undefined;
    return null;
  } catch (e) {
    const tail = t.length > 60 ? `…${t.slice(-60)}` : t;
    return {
      ok: false,
      status: 400,
      error:
        `That paste looks like JSON but doesn't parse: ${e instanceof Error ? e.message : String(e)}. ` +
        `Received ${t.length} chars ending in: ${JSON.stringify(tail)} — ` +
        `if that isn't the end of your JSON, the paste was truncated.`,
    };
  }
}

/**
 * The wrapper's /state checked against the SHARED contract (apps/wrapper/src/contract.ts — the zod schemas the
 * wrapper's own contract suite proves against both its implementations). SOFT on purpose: a reply off the contract
 * is logged (once per distinct problem per wrapper) and carried as a warning, and still read the tolerant way below
 * — answers must not stop because a field changed shape — but the drift shows the moment it happens instead of
 * surfacing later as a wrong or missing answer.
 */
const offContractSeen = new Map<string, string>();
export function wrapperContractIssues(state: unknown): string | null {
  const r = StateReply.safeParse(state);
  if (r.success) return null;
  return r.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

export async function resolveHand(body: ResolveBody): Promise<ResolvedHand | ResolveError> {
  const promoteErr = promoteTextJson(body);
  if (promoteErr) return promoteErr;

  let tableStatus: string | null = null;
  let heroSittingOut = false;
  let studyAnswersOn: boolean | null = null;
  let sessionId: string | null = null;
  let strategyId: string | null = null;

  if (body.hand != null) {
    try {
      // /state ships the whole envelope; accept { hand } wrappers too.
      const raw =
        typeof body.hand === "object" && body.hand !== null && "hand" in body.hand
          ? (body.hand as { hand: unknown }).hand
          : body.hand;
      const normalized = normalizeHand(raw);
      // EIP-16 (2026-09-23): normalizeHand does not carry sessionId onto the ParsedHand, so
      // `normalized.hand.sessionId` was always undefined and every hand-JSON resolve (a replayed
      // archived hand, which the wrapper DOES stamp with sessionId at archive time) lost its
      // session. Read it off the raw object; the live path takes state.sessionId below.
      const rawSessionId =
        typeof raw === "object" && raw !== null && typeof (raw as { sessionId?: unknown }).sessionId === "string"
          ? (raw as { sessionId: string }).sessionId
          : null;
      return { ok: true, hand: normalized.hand, source: "hand", warnings: normalized.warnings, tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId: normalized.hand.sessionId ?? rawSessionId };
    } catch (e) {
      return { ok: false, status: 400, error: `Hand JSON not understood: ${e instanceof Error ? e.message : String(e)}` };
    }
  }

  if (body.live) {
    const url = typeof body.live === "object" && body.live.url ? body.live.url : DEFAULT_LIVE_URL;
    let state: {
      connected?: boolean;
      hand?: ParsedHand | null;
      snapshot?: { status?: string; seats?: { hero?: boolean; sittingOut?: boolean }[] };
      studyAnswers?: boolean;
      sessionId?: string | null;
      session?: { strategy?: string | null } | null;
    };
    // EIP-14 (2026-09-23): the LIGHT path. The wrapper's plain /state runs its deep DOM
    // eval (_EXTRACT_DEEP_JS, every text node of every frame) plus a CDP target listing on
    // each call — and this fetch fires on every 1 Hz poller probe AND again on every
    // fast-solve, competing with the wrapper's own 4 Hz feed loop for the same CDP
    // socket. `light=1` (launch.py state(light=True)) skips both and still carries every
    // field read below: connected, hand, snapshot, studyAnswers, sessionId, session, site.
    // What light drops is only the panel's connection card (targets, ignition.textNodes).
    try {
      const res = await timed("wrapper GET /state?light=1", () => fetch(`${url.replace(/\/$/, "")}/state?light=1`, { signal: AbortSignal.timeout(3000) }), (r) => `HTTP ${r.status}`);
      state = (await res.json()) as typeof state;
    } catch {
      return { ok: false, status: 502, error: `Couldn't reach the assistive-play server at ${url} — is it running?` };
    }
    const offContract = wrapperContractIssues(state);
    if (offContract && offContractSeen.get(url) !== offContract) {
      offContractSeen.set(url, offContract);
      console.warn(`[wrapper contract] ${url} /state is off the contract: ${offContract}`);
    }
    const contractWarnings = offContract ? [`wrapper /state off the contract: ${offContract}`] : [];
    if (!state.connected) {
      return { ok: false, status: 409, error: "assistive-play is running but no table is detected." };
    }
    // POKER WRAPPER, 2026-09-22: the wrapper also plays CoinPoker (state.site). Nothing here
    // answers CoinPoker yet — every chart set this resolves to is an Ignition one (siteFor,
    // ign* rake, no antes), so a CoinPoker hand is refused rather than answered from the
    // wrong game. Remove when a CoinPoker strategy exists.
    // 2026-09-22: the CoinPoker 200NL Heads-Up strategy answers CoinPoker (fastSolve CP_HU_STRATEGY, its own
    // charts at its own ante and rake); any OTHER strategy on a CoinPoker table is still the wrong game.
    if ((state as { site?: string }).site === "coinpoker" && state.session?.strategy !== "cp200-hu-equilibrium") {
      return { ok: false, status: 409, error: "CoinPoker table: only the CoinPoker 200NL Heads-Up strategy answers CoinPoker (the Ignition charts are a different rake and structure)." };
    }
    tableStatus = state.snapshot?.status ?? null;
    studyAnswersOn = state.studyAnswers ?? false;
    sessionId = state.sessionId ?? null;
    strategyId = state.session?.strategy ?? null;
    heroSittingOut = !!state.snapshot?.seats?.find((s) => s.hero)?.sittingOut;
    if (state.hand != null) {
      try {
        const normalized = normalizeHand(state.hand);
        // the seats the table's own account covers read their money from it, not the screen (utils/archivedHand)
        return { ok: true, hand: withStartStacks(normalized.hand), source: "live", warnings: [...normalized.warnings, ...contractWarnings], tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId,
                 liveExtras: liveExtrasOf(state.hand) };
      } catch (e) {
        return { ok: false, status: 502, error: `Live hand not understood: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ok: true, hand: null, source: "live", warnings: contractWarnings, tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId };
  }

  if (body.rows || body.text) {
    const rawRows = body.rows ? (Array.isArray(body.rows) ? body.rows : body.rows.rows) : rowsFromText(body.text!);
    const source = body.rows ? "rows" : "text";
    if (!Array.isArray(rawRows)) {
      return { ok: false, status: 400, error: "rows must be a PanelRow[] or { rows: PanelRow[] }." };
    }
    const parsed = parsePanelFeed(rawRows);
    return { ok: true, hand: parsed.hand, source, warnings: parsed.warnings, tableStatus, heroSittingOut, studyAnswersOn, strategyId, sessionId: null };
  }

  return { ok: false, status: 400, error: "Body needs one of: hand, rows, text, or live." };
}
