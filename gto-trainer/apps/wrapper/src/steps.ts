/**
 * LIVE STEPS (2026-10-12, Brady: "make it more exact … live feedback on what is happening … at every action"; design in
 * docs/2026-10-12-live-step-feedback.md). The panel's one line saying what is happening on THIS decision right now, in
 * plain words, with how long it has been going on and the details that tell whether that is normal:
 *
 *   reading the table → your turn, sending the spot to the solver → (the API's own steps: the HRC chart, GTO Wizard AI,
 *   locks, re-trees, failover …) → ready to execute, waiting for the buttons → pressed, waiting for the table → landed →
 *   hand over / folded / no answer in time …
 *
 * Two halves:
 *   - the CURRENT step is DERIVED on every /state from what the wrapper already keeps (the hand, pickReady, the pending
 *     press, the hold, the clock) — nothing new has to be kept right for it to be right;
 *   - the TRAIL (what happened on the decision, with times) is the API's solve steps (pushed to POST /panel/steps while
 *     the solve runs, so they are live) plus the wrapper's own milestones, marked where they already happen (the answer
 *     arriving, the press, the table's confirmation, a hold, a no-answer fold).
 *
 * Off when answers are off: /state then carries no `steps` key (the reader goldens compare /state key by key).
 * A decision here is `${handId}|${street}|${actions}` — the no-answer fold's key (relay.maybeFoldNoAnswer); the API's
 * decision key `[street, board, heroCards, toCall, n]` converts to it (keyFromApi).
 */
import { nowMs, time } from "./clock";
import { pyStr } from "./py";
import { S } from "./state";
import { handState } from "./ignition/hand";
import { currentAnswer, currentNote, decisionActions, heroTimeLeft, pickReady } from "./relay";

export type Level = "info" | "ok" | "warn" | "bad";

/** One step as the panel draws it. `at` = when it started (epoch ms); `tick` = show the seconds counting. */
export interface Step {
  id: string;
  phase: "seat" | "read" | "solve" | "exec" | "end";
  text: string;
  level: Level;
  at: number;
  detail?: string[];
  /** typical length, past which nothing is wrong yet (shown as "usually ~X s") */
  usualMs?: number | null;
  /** past this the line turns amber: slower than usual */
  slowMs?: number | null;
  /** the give-up limit ("gives up at N s"); the line turns red at 80% of it */
  limitMs?: number | null;
  tick?: boolean;
}

/** A milestone in a decision's trail. */
export interface Mark { text: string; at: number; ms?: number | null; level: Level }

/** A step of the API's solve, as POST /panel/steps carries it (the API's answerTrace.tstep). */
export interface SolveStep {
  id?: string; text: string; detail?: string[]; at: number; endAt?: number | null;
  status: "active" | "done" | "failed" | "skipped"; lane?: string | null;
  usualMs?: number | null; slowMs?: number | null; limitMs?: number | null;
}

/** The wrapper's part of the steps state (S.study.steps*), kept per decision. */
function box(): Record<string, any> {
  const st = S.study;
  if (!st.steps) st.steps = { key: null, turnAt: 0, marks: [] as Mark[], solve: null as Record<string, any> | null };
  return st.steps;
}

/** The wrapper's decision key for a hand at a decision. */
export function decisionKeyOf(h: Record<string, any> | null | undefined): string | null {
  if (!h) return null;
  return `${pyStr(h.handId ?? null)}|${pyStr(h.street ?? null)}|${decisionActions(h).length}`;
}

/** The API's decision key (`[street, board, heroCards, toCall, n]`, JSON) at hand `handId` → the wrapper's key. */
export function keyFromApi(handId: unknown, apiKey: unknown): string | null {
  if (typeof apiKey !== "string" || handId === null || handId === undefined) return null;
  try {
    const k = JSON.parse(apiKey);
    if (!Array.isArray(k) || typeof k[0] !== "string") return null;
    return `${pyStr(handId)}|${k[0]}|${Number(k[4])}`;
  } catch {
    return null;
  }
}

/** The relay's pick key (`${handId}|${apiKey}`) → the wrapper's key. */
export function keyFromRelay(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const i = key.indexOf("|");
  if (i < 0) return null;
  const hid = key.slice(0, i);
  return keyFromApi(/^-?\d+$/.test(hid) ? Number(hid) : hid, key.slice(i + 1));
}

/** Start a decision's trail (a new key) — the previous decision's trail is kept until then, so a finished hand's
 *  trail stays on the panel until hero's next decision. */
function openDecision(key: string, at: number): Record<string, any> {
  const b = box();
  if (b.key !== key) Object.assign(b, { key, turnAt: at, marks: [], solve: b.solve && b.solve.key === key ? b.solve : null });
  return b;
}

/** Mark a milestone on decision `key` (wrapper key). Never throws: a mark is a record, not a reason for anything. */
export function stepMark(key: string | null, text: string, level: Level = "info", ms: number | null = null): void {
  try {
    if (!S.study.on || !key) return;
    const b = box();
    if (b.key !== key) openDecision(key, nowMs());
    const marks: Mark[] = b.marks;
    const last = marks[marks.length - 1];
    if (last && last.text === text) return;
    marks.push({ text, at: nowMs(), ms, level });
    if (marks.length > 12) marks.splice(0, marks.length - 12);
  } catch {}
}

/** The relay-key form of stepMark. */
export const stepMarkRelay = (key: unknown, text: string, level: Level = "info", ms: number | null = null): void =>
  stepMark(keyFromRelay(key), text, level, ms);

/** Milliseconds since hero's turn on decision `key` started (null = not known). */
export function sinceTurnMs(key: string | null): number | null {
  const b = box();
  return key && b.key === key && b.turnAt ? Math.max(0, nowMs() - b.turnAt) : null;
}

/** POST /panel/steps: the API's solve steps for one decision (replaces the previous push for it). */
export function noteSolveSteps(body: Record<string, any>): { ok: boolean; why?: string } {
  if (!S.study.on) return { ok: false, why: "answers are off" };
  const key = keyFromApi(body.handId, body.decisionKey);
  if (!key) return { ok: false, why: "no decision key / hand id" };
  const steps: SolveStep[] = (Array.isArray(body.steps) ? body.steps : [])
    .filter((s: any) => s && typeof s.text === "string" && Number.isFinite(Number(s.at)))
    .slice(-40)
    .map((s: any) => ({
      id: typeof s.id === "string" ? s.id : undefined, text: s.text.slice(0, 200),
      detail: Array.isArray(s.detail) ? s.detail.filter((d: unknown) => typeof d === "string" && d).map((d: string) => d.slice(0, 120)).slice(0, 8) : undefined,
      at: Number(s.at), endAt: Number.isFinite(Number(s.endAt)) && s.endAt !== null ? Number(s.endAt) : null,
      status: ["active", "done", "failed", "skipped"].includes(s.status) ? s.status : "active",
      lane: typeof s.lane === "string" ? s.lane : null,
      usualMs: num(s.usualMs), slowMs: num(s.slowMs), limitMs: num(s.limitMs),
    }));
  const b = box();
  // one for a NEW decision (the API saw the turn first) opens it
  if (b.key !== key) openDecision(key, steps.length ? Math.min(...steps.map((s) => s.at)) : nowMs());
  // A RETRY (the poller asks the same decision again after a failed try) is a new run: the earlier try stays on the trail
  const run = num(body.run);
  const prev = b.solve && b.solve.key === key ? b.solve : null;
  let tries = prev ? prev.tries ?? 1 : 1;
  if (prev && run !== null && prev.run !== null && prev.run !== run) {
    const last: SolveStep | undefined = prev.steps[prev.steps.length - 1];
    if (last) (b.marks as Mark[]).push({ text: `Try ${tries}: ${last.text}`, at: last.at, ms: null, level: last.status === "failed" ? "bad" : "info" });
    tries += 1;
  }
  if (tries > 1) for (const s of steps) if (s.status === "active") s.detail = [...(s.detail || []), `try ${tries}`];
  b.solve = { key, steps, run, tries, at: time() };
  return { ok: true };
}

const num = (v: unknown): number | null => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Number(v));
const secs = (ms: number): string => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`;
const PICK = (p: unknown): string => String(p ?? "").trim().toUpperCase();

/** The hero clock as a detail: once a step has run past ~5 s, or the time bank is in play. */
function clockDetail(elapsedMs: number): string | null {
  const left = heroTimeLeft();
  if (!left) return null;
  if (elapsedMs < 5000 && !left.bank) return null;
  return left.bank ? `your clock ${left.clock} s + ${left.bank} s bank` : `your clock ${left.clock} s`;
}

/** From the feed loop: when hero's turn on a decision starts (the base of "sending the spot to the solver N s"). */
export function stepsTick(): void {
  if (!S.study.on) return;
  try {
    const h = handState();
    if (!h || h.ended || h.heroFolded || !(h.currentNode || {}).toActIsHero) return;
    const key = decisionKeyOf(h);
    if (key && box().key !== key) openDecision(key, nowMs());
  } catch {}
}

/** The readiness refusal pickReady gave, as the step it means (an answer is in, it is just not pressable YET). */
function readyStep(pick: string, reason: string): Pick<Step, "id" | "text" | "level"> {
  if (/no turn buttons|has not asked you to act/.test(reason)) return { id: "ready-wait-buttons", text: `Ready to execute ${pick} — waiting for the action buttons`, level: "info" };
  if (/strip reading is stale/.test(reason)) return { id: "ready-stale", text: `Ready to execute ${pick} — the table read is stale, waiting for it to recover`, level: "warn" };
  if (/client notice/.test(reason)) return { id: "ready-notice", text: `Ready to execute ${pick} — waiting for the client's notice to close`, level: "warn" };
  if (/Buy-chips panel/.test(reason)) return { id: "ready-buy-panel", text: `Ready to execute ${pick} — closing the Buy-chips panel first`, level: "warn" };
  if (/pick was for|decision key|stale \(poller/.test(reason)) return { id: "ready-moved", text: `The answer (${pick}) is for an earlier spot — waiting for this one`, level: "info" };
  return { id: "ready-blocked", text: `Answer ${pick} — not pressed: ${reason}`, level: "bad" };
}

/** The step the decision is on right now — null when there is nothing to say. */
export function currentStep(): Step | null {
  const st = S.study;
  const L = S.liveStatus;
  const now = nowMs();
  const b = box();
  const h = handState();
  const key = decisionKeyOf(h);
  const mk = (s: Omit<Step, "at"> & { at?: number }): Step => ({ ...s, at: s.at ?? now });

  if (S.disconnect) return mk({ id: "disconnected", phase: "seat", text: "Connection to the poker server lost — nothing is pressed on this table", level: "bad", at: num(S.disconnect.at) ?? now });
  if (L.feedStalled) return mk({ id: "reader-stalled", phase: "read", text: "Table reader stopped — not reading the table", level: "bad", at: num(L.feedStalled.since) ?? now, tick: true, detail: L.feedStalled.error ? [String(L.feedStalled.error).slice(0, 100)] : undefined });

  // A HAND THE SOCKET JOINED MID-WAY (2026-10-14, ws.ts CO_TABLE_INFO): its earlier actions were never seen — no export
  // (usually: no deal frame), or one the API refuses; nothing is pressed and no no-answer fold fires (relay.ts). Said
  // here so the player knows this hand is his to play.
  const joined = S.ws.joinedMidHand;
  if (joined && (!h || h.joinedMidHand)) {
    return mk({ id: "joined-mid-hand", phase: "read", level: "warn", at: num(joined.at) ? Math.trunc(joined.at * 1000) : now,
                text: "Joined this hand mid-way — the table's earlier actions were not seen: play it yourself, nothing is answered or pressed in it" });
  }
  if (!h) {
    if (L.hero === "sitting-out") return mk({ id: "sitting-out", phase: "seat", text: "Sitting out — press I AM BACK to rejoin", level: "warn" });
    if (L.hero === "waiting-for-bb") return mk({ id: "waiting-bb", phase: "seat", text: "Waiting for the big blind to be dealt in", level: "info" });
    return mk({ id: "between-hands", phase: "end", text: "Waiting for the next hand", level: "info" });
  }

  // ---- the hand is over for hero ----
  const nf = st.lastNoAnswerFold;
  const thisHandFold = nf && nf.hand === S.handNo && nf.ok;
  if (h.ended || h.heroFolded) {
    if (thisHandFold && h.heroFolded) return mk({ id: "end-noanswer", phase: "end", text: `No answer in time — ${PICK(nf.did)} (${nf.why}) — waiting for the next hand`, level: "bad", at: nf.at });
    if (h.heroWon) return mk({ id: "end-won", phase: "end", text: "You won the pot — waiting for the next hand", level: "ok" });
    if (h.heroFolded) {
      const ex = st.lastExec;
      const byPick = ex && ex.hand === S.handNo && ex.ok && /^fold/i.test(String(ex.pick ?? ""));
      return mk({ id: "end-folded", phase: "end", text: byPick ? "Folded (the answer's FOLD) — waiting for the next hand" : "You folded — waiting for the next hand", level: "info" });
    }
    return mk({ id: "end-over", phase: "end", text: "Hand over — waiting for the next deal", level: "info" });
  }

  // ---- a press on its way to the table (the turn may already read as over) ----
  const pend = st.pendingExec;
  if (pend) {
    const at = Math.trunc((pend.sentAt ?? time()) * 1000);
    return mk({ id: `pressed-${pend.attempts}`, phase: "exec", at, tick: true, level: "info",
                text: `Pressed ${PICK(pend.pick)} — waiting for the table to confirm${pend.attempts > 1 ? ` (press ${pend.attempts} of 2)` : ""}`,
                usualMs: 1000, slowMs: 1400, limitMs: 5000 });
  }

  // an answer for THIS decision means it is hero's turn even while the client has not drawn the buttons yet — that gap
  // is "ready, waiting for the buttons", not "waiting for your turn"
  const answerHere = !!(currentAnswer()?.pick && keyFromApi(st.handId, st.decisionKey) === key);
  const onTurn = !!(h.currentNode || {}).toActIsHero || answerHere;
  if (!onTurn) {
    const ex = st.lastExec;
    if (ex && ex.outcome === "confirmed" && keyFromRelay(ex.key) === b.key && b.key?.startsWith(`${pyStr(h.handId)}|`)) {
      const node = h.currentNode || {};
      const who = node.toActSeatId ? ` — seat ${node.toActSeatId}${(h.positions || {})[node.toActSeatId] ? ` (${h.positions[node.toActSeatId]})` : ""} to act` : "";
      return mk({ id: "landed", phase: "exec", text: `✓ ${PICK(ex.pick)} landed on the table${who}`, level: "ok" });
    }
    if (h.notToActWhy) return mk({ id: "not-trusted", phase: "read", text: `Buttons are up but the read is not trusted yet — ${h.notToActWhy}`, level: "warn", tick: true });
    if (h.lineUncertain) return mk({ id: "line-uncertain", phase: "read", text: "Checking the table — the line on screen disagrees, holding", level: "warn", detail: h.lineNote ? [String(h.lineNote).slice(0, 100)] : undefined });
    const node = h.currentNode || {};
    const pos = node.toActSeatId ? (h.positions || {})[node.toActSeatId] : null;
    return mk({ id: "waiting-turn", phase: "read", level: "info",
                text: node.toActSeatId ? `Waiting for your turn — seat ${node.toActSeatId}${pos ? ` (${pos})` : ""} to act` : "Waiting for your turn" });
  }

  // ---- hero's turn ----
  if (key && b.key !== key) openDecision(key, now);
  const turnAt = b.key === key && b.turnAt ? b.turnAt : now;
  const withClock = (s: Step): Step => {
    const c = clockDetail(now - s.at);
    if (c) s.detail = [...(s.detail || []), c];
    return s;
  };

  if (nf && nf.decision === key) {
    return mk({ id: "noanswer-act", phase: "end", text: `No answer in time — ${PICK(nf.did)}${nf.ok ? "" : " could not be pressed"} (${nf.why})`, level: "bad", at: nf.at });
  }

  const answer = currentAnswer();
  if (answer && answer.pick) {
    const r = pickReady();
    const pick = PICK(answer.pick);
    const ex = st.lastExec;
    if (r.ok) {
      if (st.autoHeld && st.autoHeld.key === r.key) {
        return withClock(mk({ id: "held", phase: "exec", text: `Holding ${pick} — ${st.autoHeld.why}`, level: "warn", at: Math.trunc(st.autoHeld.at * 1000), tick: true }));
      }
      if (ex && ex.key === r.key && ex.outcome === "refused") {
        const n = st.autoRetry && st.autoRetry.key === r.key ? st.autoRetry.n : 0;
        return withClock(mk({ id: `refused-${n}`, phase: "exec", level: "warn", at: ex.at, tick: true,
                              text: `${pick} was refused (${ex.result?.reason ?? "refused"})${st.auto ? ` — retrying ${Math.min(n + 1, 2)} of 2` : " — press again"}` }));
      }
      if (st.auto && st.autoDue && st.autoDue.key === r.key) {
        const left = Math.max(0, st.autoDue.at - time());
        return withClock(mk({ id: "auto-due", phase: "exec", text: `Executing ${pick} in ${left.toFixed(1)} s`, level: "info" }));
      }
      if (st.auto) return withClock(mk({ id: "executing", phase: "exec", text: `Executing ${pick}…`, level: "info", tick: true }));
      return withClock(mk({ id: "ready-press", phase: "exec", text: `Ready — press Enter to ${pick}`, level: "ok", tick: true }));
    }
    if (/already executed/.test(r.reason || "") && ex && ex.key === r.key) {
      if (ex.outcome === "confirmed") return mk({ id: "landed", phase: "exec", text: `✓ ${pick} landed on the table`, level: "ok" });
      if (ex.outcome === "diverged") return mk({ id: "diverged", phase: "exec", text: `⚠ ${pick} was pressed but the table took ${ex.outcomeWhy}`, level: "bad" });
      if (ex.outcome === "unknown" || ex.outcome === "abandoned") return withClock(mk({ id: "unregistered", phase: "exec", text: `⚠ ${pick} was pressed but never showed on the table (${ex.outcomeWhy})`, level: "bad", tick: true }));
    }
    const rs = readyStep(pick, String(r.reason || "not ready"));
    // "waiting for the buttons" counts from when the answer arrived — the gap between the answer and the strip
    const since = rs.id === "ready-wait-buttons" ? Math.trunc((st.at || time()) * 1000) : now;
    return withClock(mk({ ...rs, phase: "exec", at: since, tick: rs.id !== "ready-blocked" }));
  }

  const note = currentNote();
  if (note) return mk({ id: "no-answer", phase: "solve", text: /^no answer\b/i.test(note) ? note.charAt(0).toUpperCase() + note.slice(1) : `No answer — ${note}`, level: "bad" });

  if (st.onDemand && !st.solveRequest) return mk({ id: "press-solve", phase: "solve", text: "Press SOLVE for the equilibrium answer", level: "info" });

  // the API's own solve steps for THIS decision (POST /panel/steps): the active one is the line; the rest are the trail
  const sv = b.solve && b.solve.key === key ? b.solve : null;
  if (sv && sv.steps.length) {
    const active: SolveStep[] = sv.steps.filter((s: SolveStep) => s.status === "active");
    const cur = active.length ? active[active.length - 1]! : sv.steps[sv.steps.length - 1]!;
    const lanes = active.length > 1 ? active.slice(0, -1).map((s) => `also: ${s.text}`) : [];
    // a try that came back empty while the poller asks again (its note says so when it stops asking)
    if (cur.id === "final" && cur.status === "failed") {
      const why = cur.text.replace(/^No answer on this try \([^)]*\)(?: — )?/, "");
      return withClock(mk({ id: "try-empty", phase: "solve", text: "This try came back empty — asking again", at: cur.at, tick: true,
                            level: "warn", detail: why ? [why] : undefined }));
    }
    return withClock(mk({ id: `solve:${cur.id ?? cur.text}`, phase: "solve", text: cur.text, at: cur.at, tick: cur.status === "active",
                          level: cur.status === "failed" ? "bad" : "info", detail: [...(cur.detail || []), ...lanes],
                          usualMs: cur.usualMs ?? null, slowMs: cur.slowMs ?? null, limitMs: cur.limitMs ?? null }));
  }
  return withClock(mk({ id: "sending", phase: "solve", text: "Your turn — sending the spot to the solver", level: "info", at: turnAt, tick: true, slowMs: 3000 }));
}

/** The decision's trail: the API's finished solve steps and the wrapper's milestones, in time order. */
export function currentTrail(): Mark[] {
  const b = box();
  const out: Mark[] = [];
  const sv = b.solve && b.solve.key === b.key ? b.solve : null;
  const solveSteps = (sv?.steps || []) as SolveStep[];
  for (const s of solveSteps) {
    if (s.status === "active") continue;
    // the route's opening "Working out your flop spot" says nothing once a real stage followed it
    if (/^Working out your /.test(s.text) && solveSteps.some((x) => x !== s)) continue;
    out.push({ text: s.lane ? `${s.lane}: ${s.text}` : s.text, at: s.at, ms: s.id === "final" || !s.endAt ? null : s.endAt - s.at,
               level: s.status === "failed" ? "bad" : s.status === "skipped" ? "info" : "ok" });
  }
  // the API's own "Answered: HRC chart · 0.3 s" names the source — the wrapper's "Answer: CALL · HRC chart" then says the pick only
  const named = out.some((m) => m.text.startsWith("Answered: "));
  out.push(...(b.marks as Mark[]).map((m) => (named && m.text.startsWith("Answer: ") ? { ...m, text: m.text.replace(/ · .*$/, "") } : m)));
  return out.sort((x, y) => x.at - y.at);
}

/** The /state `steps` key: {now, key, current, trail} — null when answers are off (the key is then omitted). */
export function stepsView(): Record<string, any> | null {
  if (!S.study.on) return null;
  try {
    const cur = currentStep();
    if (!cur) return null;
    return { now: nowMs(), key: box().key, current: cur, trail: currentTrail() };
  } catch {
    return null;
  }
}

/** An answer's `source` in plain words (the API's fastSolve source union). */
export function sourceName(source: unknown, tier: unknown = null): string | null {
  const s = String(source ?? "");
  const names: Record<string, string> = {
    "hrc-6max-preflop": "HRC chart", "gtow-ai-preflop": "GTO Wizard AI (preflop)", "gtow-api-postflop": "GTO Wizard AI (postflop)",
    "hrc-3max-preflop": "HRC 3-handed chart", "pool-exploit-preflop": "pool exploit chart", "hrc-hu-preflop": "HRC heads-up chart",
    "local-preflop": "local chart", "mes-postflop": "MES exploit",
  };
  if (names[s]) return names[s]!;
  const t = String(tier ?? "");
  return s ? s : t || null;
}

/** POST /panel/answer: the first push of an answer for a decision is a milestone ("Answer: CALL · HRC chart · 0.3 s"). */
export function noteAnswerArrived(handId: unknown, apiKey: unknown, pick: unknown, source: unknown, tier: unknown): void {
  const key = keyFromApi(handId, apiKey);
  if (!key) return;
  const b = box();
  if (b.key === key && (b.marks as Mark[]).some((m) => m.text.startsWith("Answer: "))) return;
  const since = sinceTurnMs(key);
  const name = sourceName(source, tier);
  stepMark(key, `Answer: ${PICK(pick) || "(no pick)"}${name ? ` · ${name}` : ""}`, "ok", since);
}

/** Milliseconds since the first mark on `key` starting with `prefix` (null = no such mark). */
export function msSinceMark(key: string | null, prefix: string): number | null {
  const b = box();
  if (!key || b.key !== key) return null;
  const m = (b.marks as Mark[]).find((x) => x.text.startsWith(prefix));
  return m ? Math.max(0, nowMs() - m.at) : null;
}
