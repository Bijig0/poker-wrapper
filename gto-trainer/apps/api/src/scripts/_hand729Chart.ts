/** Hand 729: which limp chart answered the SB's AA-facing-two-limps decision, how fast its nodes come, and what the node holds. */
import { chartFor6max, resolveChart6max } from "../services/hrc6max";
import { fetchNode } from "../services/hrc3max";
import { buildPreflopTokens } from "../feed/buildSolutionUrl/buildSolutionUrl";
import { normalizeHand } from "../feed/normalizeHand/normalizeHand";
const r = await fetch("http://127.0.0.1:2000/api/dashboard/hand/729").then((x) => x.json());
const raw = { ...r.hand, ended: false, currentNode: { ...r.hand.currentNode, toActSeatId: r.hand.heroSeatId, toActIsHero: true, complete: false, street: "preflop" }, board: [], street: "preflop" };
raw.actions = raw.actions.slice(0, 5);
const hand = normalizeHand(raw).hand;
const heroPos = hand.positions[hand.heroSeatId] ?? null;
const tokens = buildPreflopTokens(hand, heroPos);
const choice = chartFor6max(hand, heroPos, tokens);
console.log("tokens", tokens.join("-"), "| choice", JSON.stringify({ id: choice.id, depth: choice.depth, note: choice.note, prefs: (choice as any).prefer ?? (choice as any).candidates }, null, 0).slice(0, 500));
const resolved = await resolveChart6max(choice);
console.log("resolved", JSON.stringify(resolved));
if (resolved && resolved !== "unreachable") {
  for (const line of ["", "F", "F-F", "F-F-C", "F-F-C-C", "F-F-C-C-C", "F-F-C-C-C-X"]) {
    const t0 = Date.now();
    const n = await fetchNode(resolved.id, line);
    const ms = Date.now() - t0;
    if (!n || n === "unreachable") { console.log(`${line || "(root)"} -> ${String(n)} in ${ms} ms`); continue; }
    const acts = (n as any).actions?.map((a: any) => a.token ?? a.action).join(" ");
    console.log(`${line || "(root)"} -> pos ${(n as any).pos} terminal=${(n as any).terminal} actions [${acts}] in ${ms} ms`);
    if (line === "F-F-C-C") {
      const cells = (n as any).cells ?? [];
      const c = cells.find((x: any) => x.hand === "AA");
      console.log("  AA cell:", JSON.stringify(c).slice(0, 600));
      for (const h of ["KK", "QQ", "AKs", "AKo", "A5s", "JJ", "TT", "76s", "K9o"]) {
        const cc = cells.find((x: any) => x.hand === h); console.log("  ", h, JSON.stringify(cc?.actions ?? cc?.mix ?? cc).slice(0, 220));
      }
      // aggregate: how much of the SB range limps vs raises here
      const agg: Record<string, number> = {}; let tot = 0;
      for (const cell of cells) { const w = cell.weight ?? cell.w ?? 1; for (const a of cell.actions ?? []) { agg[a.action ?? a.token] = (agg[a.action ?? a.token] ?? 0) + (a.frequency ?? a.freq ?? 0) * w; } tot += w; }
      console.log("  SB range-wide mix:", Object.fromEntries(Object.entries(agg).map(([k, v]) => [k, +(v / tot).toFixed(2)])), "cells", cells.length, "sample cell keys", Object.keys(cells[0] ?? {}));
    }
  }
}
