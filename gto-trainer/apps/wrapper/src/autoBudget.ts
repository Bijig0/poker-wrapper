/**
 * THE AUTO-EXECUTE BUDGET (Brady, 2026-10-12): one budget per session per table, set at session setup, shown on the
 * panel and changed there by Adjust. It replaces the real-money "test allowance" (granted per arming, thrown away on
 * every untick, practice unbounded).
 *   - practice AND real money are both bounded; the fake table is not (the test rig and the stress harnesses);
 *   - minutes count only WHILE AUTO IS ON, hands are the hands dealt while it is on;
 *   - unticking keeps what is left — ticking again continues it; spent → auto disarms (relay.autoTableOk) and
 *     cannot arm again until Adjust gives it more;
 *   - Adjust sets what is LEFT from now (the panel prefills the fields with what is left).
 * The state lives on S.study (autoBudget, autoUsedS, autoUsedHands, autoArmedAt, autoArmedHand).
 */
import { time } from "./clock";
import { pyInt, pyRound } from "./py";
import { S } from "./state";

export const BUDGET_DEFAULT = { minutes: 30, hands: 50 };
export const BUDGET_MAX = { minutes: 2880, hands: 10000 };

const clampOr = (v: unknown, lo: number, hi: number, dflt: number): number => {
  if (v === null || v === undefined || v === "") return dflt;
  try {
    const n = pyInt(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  } catch {
    return dflt;
  }
};

/** A budget from a config / request, clamped; a missing field keeps `base`'s. */
export function clampBudget(b: any, base: { minutes: number; hands: number } = BUDGET_DEFAULT): { minutes: number; hands: number } {
  return { minutes: clampOr(b?.minutes, 1, BUDGET_MAX.minutes, base.minutes),
           hands: clampOr(b?.hands, 1, BUDGET_MAX.hands, base.hands) };
}

/** A new session's budget: nothing used, not armed. */
export function resetBudget(b: any): void {
  Object.assign(S.study, { autoBudget: clampBudget(b), autoUsedS: 0.0, autoUsedHands: 0, autoArmedAt: 0.0, autoArmedHand: null });
}

/** Start counting (auto just armed). */
export function startCounting(): void {
  Object.assign(S.study, { autoArmedAt: time(), autoArmedHand: S.handNo });
}

/** Stop counting (auto just disarmed, for any reason): what this arming used goes onto the used totals. */
export function stopCounting(): void {
  const st = S.study;
  if (st.autoArmedAt) {
    st.autoUsedS = (st.autoUsedS || 0) + Math.max(0, time() - st.autoArmedAt);
    st.autoUsedHands = (st.autoUsedHands || 0) + Math.max(0, S.handNo - (st.autoArmedHand ?? S.handNo));
  }
  Object.assign(st, { autoArmedAt: 0.0, autoArmedHand: null });
}

/** Used so far, including the running arming. */
function used(): { s: number; hands: number } {
  const st = S.study;
  const armed = !!st.autoArmedAt;
  return { s: (st.autoUsedS || 0) + (armed ? Math.max(0, time() - st.autoArmedAt) : 0),
           hands: (st.autoUsedHands || 0) + (armed ? Math.max(0, S.handNo - (st.autoArmedHand ?? S.handNo)) : 0) };
}

/** The budget's state, as the panel shows it. The fake table is unbounded (granted false, as the allowance was). */
export function budgetState(): Record<string, any> {
  if (S.fakeMode) return { granted: false, live: false, bounded: false, minutesLeft: null, handsLeft: null };
  const st = S.study;
  const b = st.autoBudget ?? BUDGET_DEFAULT;
  const u = used();
  const sLeft = Math.max(0, b.minutes * 60 - u.s);
  const handsLeft = Math.max(0, b.hands - u.hands);
  return {
    granted: true, bounded: true, live: sLeft > 0 && handsLeft > 0,
    minutes: b.minutes, hands: b.hands,
    minutesLeft: pyRound(sLeft / 60, 1), handsLeft,
    minutesUsed: pyRound(u.s / 60, 1), handsUsed: u.hands,
    armed: !!st.autoArmedAt,
  };
}

/** ADJUST: what is left from now = {minutes, hands} (a missing field keeps what is left of it). */
export function adjustBudget(b: any): { before: Record<string, any>; after: Record<string, any> } {
  const before = budgetState();
  const left = { minutes: Math.max(1, Math.ceil(before.minutesLeft ?? BUDGET_DEFAULT.minutes)),
                 hands: Math.max(1, before.handsLeft ?? BUDGET_DEFAULT.hands) };
  const st = S.study;
  const armed = !!st.autoArmedAt;
  Object.assign(st, { autoBudget: clampBudget(b, left), autoUsedS: 0.0, autoUsedHands: 0 });
  if (armed) startCounting();
  return { before, after: budgetState() };
}
