/** Hand 729's flop root (4-way limped pot, hero SB first to act) replayed in-process: where do the seconds go now? */
import { fastSolve } from "../services/fastSolve";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
const r = await fetch("http://127.0.0.1:2000/api/dashboard/hand/729").then((x) => x.json());
const raw = { ...r.hand, ended: false, street: "flop", board: ["6h", "4s", "3c"],
  currentNode: { street: "flop", toActSeatId: r.hand.heroSeatId, toActIsHero: true, pot: 4, toCall: 0, legalActions: [], complete: false } };
raw.actions = raw.actions.slice(0, 7);
const hand = normalizeHand(raw).hand;
const t0 = Date.now();
const res = await fastSolve(hand, hand.positions[hand.heroSeatId] ?? null, { strategyId: "ign200-ring-6max-equilibrium", origin: "replay" });
const wall = Date.now() - t0;
console.log(`wall ${wall} ms | ok ${res.ok} | ${res.ok ? `${res.decision?.action} · ${res.actions.map((a) => `${a.action} ${a.frequency}`).join(" / ")}` : (res as any).reason}`);
console.log("warning:", (res.warning ?? "").slice(0, 700));
// the chain's own clock: the newest solve records for this hand
const s = await fetch("http://127.0.0.1:2000/api/dashboard/solves").then((x) => x.json());
const rows = (s.rows ?? s.solves ?? []).filter((x: any) => x.clientHandId === "4919957671" && x.origin === "replay").slice(-3);
console.log("chain records (cumulative solveMs):", rows.map((x: any) => `${x.id}:${x.solveMs}ms`).join("  "), "→ pre-chain ≈", wall - Math.max(0, ...rows.map((x: any) => x.solveMs)), "ms");
