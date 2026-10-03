/**
 * THE REPLAY GATE'S SEAM in fastSolve (scripts/replayGate.ts, 2026-10-04): the flop-entering ranges a postflop
 * decision starts from can be replaced by the ones the LIVE solve used, so a hand's postflop decisions replay against
 * the cached trees whatever the preflop charts have become since (re-baked charts, a neighbouring rung picked from a
 * re-read stack). fastSolve carries it (null = the live path, untouched); the gate puts the same text into a control
 * checkout of an older commit, so the control and the candidate replay the same way. One text, two uses — keep
 * `withReplaySeam` the only writer of it.
 */
export const SEAM_MARK = "export const replaySeams";

export const SEAM_TS = `/**
 * THE REPLAY GATE'S SEAM (scripts/replayGate.ts + replayGateSeam.ts, 2026-10-04). NEVER SET IN PRODUCTION: \`arrival\`
 * null is the live path, untouched. Set, it gives a hand's flop-entering ranges as the LIVE solve used them (class
 * weights by position, from the stored traces): the arrival is computed as always and its ranges replaced; when the
 * computation fails and the stored ranges cover every flop seat, they are the arrival. \`computingArrival\` tells the
 * gate a request belongs to the arrival (an old preflop tree), not to the decision.
 */
export const replaySeams: {
  arrival: ((hand: ParsedHand) => { ranges: Record<string, Record<string, number>>; complete: boolean } | null) | null;
  computingArrival: number;
} = { arrival: null, computingArrival: 0 };
async function flopArrival(
  hand: ParsedHand, heroPos: string | null, heroPosName: string, set: (typeof SOLUTION_SETS)[number], depth: number,
  sixMax: boolean, huCp: boolean, pinnedDealt: Record<number, number> | undefined, cpRing = false,
): Promise<{ ok: true; a: FlopArrival } | { ok: false; why: string }> {
  const ov = replaySeams.arrival ? replaySeams.arrival(hand) : null;
  if (!ov) return flopArrivalLive(hand, heroPos, heroPosName, set, depth, sixMax, huCp, pinnedDealt, cpRing);
  replaySeams.computingArrival++;
  let r: { ok: true; a: FlopArrival } | { ok: false; why: string };
  try { r = await flopArrivalLive(hand, heroPos, heroPosName, set, depth, sixMax, huCp, pinnedDealt, cpRing); }
  catch (e) { r = { ok: false, why: String((e as Error)?.message ?? e) }; }
  finally { replaySeams.computingArrival--; }
  const stored = (k: string): Record<string, number> | undefined => {
    const u = k.toUpperCase();
    const hit = Object.entries(ov.ranges).find(([p]) => p.toUpperCase() === u)?.[1];
    if (hit) return hit;
    const alias = u === "BTN" ? "SB" : u === "SB" ? "BTN" : null;   // heads-up the dealer is the tree's SB
    return alias && Object.keys(ov.ranges).length === 2 ? Object.entries(ov.ranges).find(([p]) => p.toUpperCase() === alias)?.[1] : undefined;
  };
  if (r.ok) {
    const ranges: Record<string, Record<string, number>> = {};
    for (const [k, v] of Object.entries(r.a.recon.ranges)) ranges[k] = stored(k) ?? v;
    return { ok: true, a: { ...r.a, recon: { ...r.a.recon, ranges } } };
  }
  if (!ov.complete) return r;
  return { ok: true, a: { recon: { ok: true, ranges: ov.ranges }, preTokens: buildPreflopTokens(hand, heroPos), seatOrder: undefined,
    rangeSource: "replay: the flop ranges the live solve used", note: null, prov: { how: "designed", producer: "replay-stored" } } };
}

`;

/** fastSolve's source with the seam in (unchanged when it already has it): the live flopArrival becomes flopArrivalLive */
export function withReplaySeam(src: string): string {
  if (src.includes(SEAM_MARK)) return src;
  const anchor = "async function flopArrival(";
  if (src.split(anchor).length !== 2) throw new Error("replay seam: fastSolve has no single `async function flopArrival(` to wrap");
  const nl = src.includes("\r\n") ? "\r\n" : "\n";
  return src.replace(anchor, SEAM_TS.replace(/\n/g, nl) + "async function flopArrivalLive(");
}
