/** Replay a hands.db hand (dbId, default 732) EXACTLY as the wrapper recorded it — BB poster labelled SB — through fastSolve. */
import { fastSolve } from "../services/fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
const id = Bun.argv[2] ?? "732";
const r = await fetch(`http://127.0.0.1:2000/api/dashboard/hand/${id}`).then((x) => x.json());
const raw = { ...r.hand, ended: false, currentNode: { ...r.hand.currentNode, toActSeatId: r.hand.heroSeatId, toActIsHero: true, complete: false } };
// as recorded, the archive holds hero's later fold; cut the actions back to the decision point (index 2 = hero's turn)
raw.actions = raw.actions.slice(0, Number(Bun.argv[3] ?? 2));
const hand = normalizeHand(raw).hand;
console.log("positions as recorded:", JSON.stringify(hand.positions), "hero seat", hand.heroSeatId, hand.heroCards);
const t0 = Date.now();
const res = await fastSolve(hand, hand.positions[hand.heroSeatId] ?? null, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
console.log(`${Date.now() - t0} ms`);
console.log(JSON.stringify({ ok: res.ok, ...(res.ok ? { source: (res as any).source, tier: (res as any).tier, pos: res.pos, line: res.line, actions: res.actions, decision: res.decision?.action, approx: (res as any).approx, warning: res.warning } : { reason: (res as any).reason }) }, null, 1));
