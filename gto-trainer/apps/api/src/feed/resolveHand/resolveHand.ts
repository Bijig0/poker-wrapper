import {
  parsePanelFeed,
  rowsFromText,
  type PanelRow,
  type ParsedHand,
} from "../parsePanelFeed/parsePanelFeed";
import { normalizeHand } from "../normalizeHand/normalizeHand";

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
}

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

export async function resolveHand(body: ResolveBody): Promise<ResolvedHand | ResolveError> {
  const promoteErr = promoteTextJson(body);
  if (promoteErr) return promoteErr;

  let tableStatus: string | null = null;
  let heroSittingOut = false;
  let studyAnswersOn: boolean | null = null;

  if (body.hand != null) {
    try {
      // /state ships the whole envelope; accept { hand } wrappers too.
      const raw =
        typeof body.hand === "object" && body.hand !== null && "hand" in body.hand
          ? (body.hand as { hand: unknown }).hand
          : body.hand;
      const normalized = normalizeHand(raw);
      return { ok: true, hand: normalized.hand, source: "hand", warnings: normalized.warnings, tableStatus, heroSittingOut, studyAnswersOn };
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
    };
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/state`, { signal: AbortSignal.timeout(3000) });
      state = (await res.json()) as typeof state;
    } catch {
      return { ok: false, status: 502, error: `Couldn't reach the assistive-play server at ${url} — is it running?` };
    }
    if (!state.connected) {
      return { ok: false, status: 409, error: "assistive-play is running but no table is detected." };
    }
    tableStatus = state.snapshot?.status ?? null;
    studyAnswersOn = state.studyAnswers ?? false;
    heroSittingOut = !!state.snapshot?.seats?.find((s) => s.hero)?.sittingOut;
    if (state.hand != null) {
      try {
        const normalized = normalizeHand(state.hand);
        return { ok: true, hand: normalized.hand, source: "live", warnings: normalized.warnings, tableStatus, heroSittingOut, studyAnswersOn };
      } catch (e) {
        return { ok: false, status: 502, error: `Live hand not understood: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
    return { ok: true, hand: null, source: "live", warnings: [], tableStatus, heroSittingOut, studyAnswersOn };
  }

  if (body.rows || body.text) {
    const rawRows = body.rows ? (Array.isArray(body.rows) ? body.rows : body.rows.rows) : rowsFromText(body.text!);
    const source = body.rows ? "rows" : "text";
    if (!Array.isArray(rawRows)) {
      return { ok: false, status: 400, error: "rows must be a PanelRow[] or { rows: PanelRow[] }." };
    }
    const parsed = parsePanelFeed(rawRows);
    return { ok: true, hand: parsed.hand, source, warnings: parsed.warnings, tableStatus, heroSittingOut, studyAnswersOn };
  }

  return { ok: false, status: 400, error: "Body needs one of: hand, rows, text, or live." };
}
