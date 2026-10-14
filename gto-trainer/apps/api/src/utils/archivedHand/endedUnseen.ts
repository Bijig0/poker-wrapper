/**
 * THE WRAPPER'S "ENDED UNSEEN" STAMP (2026-10-14, wrapper ignition/ws.ts endUnseenNote → archive.ts): a record closed
 * before the table's PLAY_STAGE_END_REQ — its socket closed mid-hand (4923409614), the next hand's first frame arrived
 * first, the capture dropped, the session ended with the hand in play. What it holds is all the table sent; the hand's
 * result, maybe hero's last action, maybe the last street never reached the wrapper. Readers: the hand page (says so),
 * the hand-history check (compares as far as the record goes), the reconciler (invents no decision past it).
 */
export interface EndedUnseen { why: string; street: string; actions: number }

/** The stamp on an archived row's JSON, or null for a hand whose end came (and for rows from before the stamp). */
export function endedUnseenOf(e: { raw?: unknown } | null | undefined): EndedUnseen | null {
  const u = (e?.raw as { endedUnseen?: unknown } | null | undefined)?.endedUnseen;
  if (!u || typeof u !== "object") return null;
  const { why, street, actions } = u as Record<string, unknown>;
  return { why: typeof why === "string" ? why : "the record was closed before the table's end-of-hand frame arrived",
           street: typeof street === "string" ? street : "?", actions: typeof actions === "number" ? actions : 0 };
}
