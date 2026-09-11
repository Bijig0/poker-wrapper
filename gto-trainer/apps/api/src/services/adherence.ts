/**
 * Told vs did: comparing a logged study answer with the action hero actually
 * took in the archived hand. Shared by routes/sources (the grading pane) and
 * routes/dashboard (the scoped analytics), which is why it lives here and not
 * in either route — the two routes import each other's helpers already, and a
 * third edge would make that a cycle.
 */
import type { LoggedAnswer } from "./answerLog";

export type Verb = "fold" | "call" | "check" | "bet" | "raise" | "other";

export const verbOf = (label: string | null | undefined): Verb | null => {
  if (!label) return null;
  const s = label.toLowerCase();
  if (s.startsWith("fold")) return "fold";
  if (s.startsWith("check")) return "check";
  if (s.startsWith("call") || s.startsWith("limp")) return "call";
  if (s.startsWith("bet")) return "bet";
  if (s.startsWith("raise") || s.startsWith("all") || s.startsWith("jam") || s.startsWith("rai") || /^r\d/.test(s)) return "raise";
  return "other";
};

export const sizeOf = (label: string | null | undefined): number | null => {
  if (!label) return null;
  if (/%/.test(label)) return null; // pot-fraction sizes are not comparable to bb
  const m = label.match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : null;
};

/** Same action? Verbs must match; when both carry a bb size they must be within 25%. */
export const sameAction = (a: string | null | undefined, b: string | null | undefined): boolean | null => {
  const va = verbOf(a), vb = verbOf(b);
  if (va == null || vb == null) return null;
  if (va !== vb) return false;
  const sa = sizeOf(a), sb = sizeOf(b);
  if (sa != null && sb != null && sa > 0 && sb > 0) return Math.abs(sa - sb) / Math.max(sa, sb) <= 0.25;
  return true;
};

/** Hero's actual action at the logged decision, from the archived hand. The
 *  decision key carries the action count at the moment of the answer, which is
 *  the index of hero's next action in the archived action list. */
export function heroActionAt(
  e: { hand: { actions: unknown[] } },
  a: Pick<LoggedAnswer, "street" | "decision_key">,
): { label: string; verb: Verb } | null {
  let nActs = 0, street: string | null = a.street;
  try {
    const k = JSON.parse(a.decision_key ?? "null");
    if (Array.isArray(k)) { street = k[0] ?? street; nActs = Number(k[4] ?? 0) || 0; }
  } catch { /* fall through */ }
  const acts = e.hand.actions;
  for (let i = nActs; i < acts.length; i++) {
    const x = acts[i] as { hero?: boolean; type?: string; amount?: number; street?: string };
    if (!x.hero) continue;
    if (street && x.street && x.street !== street) return null; // hero never acted again on this street
    if (x.type === "post-sb" || x.type === "post-bb") continue;
    const label = x.amount != null && (x.type === "bet" || x.type === "raise") ? `${x.type} ${x.amount}` : String(x.type ?? "");
    return { label, verb: verbOf(label) ?? "other" };
  }
  return null;
}
