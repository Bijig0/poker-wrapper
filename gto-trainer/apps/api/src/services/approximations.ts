/**
 * approximations — the register of places the strategy is KNOWINGLY not exact.
 *
 * WHY THIS EXISTS (2026-09-21, Brady: "do we have somewhere where we are
 * creating a list of these sorts of 'imperfections' we have in our strategy
 * that isn't fully/properly solved?"). We had three partial answers and no
 * whole one:
 *
 *   - the Sources registry cards carry `caveats[]` — authoritative, but one
 *     card at a time, so you cannot see them side by side or rank them;
 *   - the miss queue (services/missQueue.ts) counts what actually happened —
 *     but only the chart-walk family, and only states we have already seen;
 *   - each answer carries its own `warning` — perfect for one hand, useless
 *     for "what is costing us the most".
 *
 * None of them could answer the question that matters: *which of our
 * approximations fires most often?* So this is the list, with the joins. Each
 * entry names what we do INSTEAD of the exact thing, why it cannot be exact
 * yet, and what would close it — and carries the keys that let the endpoint
 * attach live volume: `missKinds` (rows + live hits in the miss queue) and
 * `warn` (how many logged answers actually said it).
 *
 * THE HONEST PART IS `measured`. An entry with neither key is an approximation
 * we make with NO telemetry at all — we know we do it, we cannot say how often.
 * Those are listed too, and marked, because "unmeasured" is the finding: it is
 * the difference between a known cost and an unknown one, and it is the queue
 * of things worth instrumenting next.
 *
 * DRIFT: `coversCaveat` claims a card's caveat line. The endpoint reports any
 * card caveat no entry claims, so this register going stale is visible on the
 * page rather than silent. Operational caveats ("desktop locked = no answers")
 * are deliberately NOT here — they are availability, not approximation.
 */

/** Where an approximation stands. */
export type ApproxStatus =
  /** the vendor's tree cannot express the spot — no solve of ours closes it */
  | "vendor-ceiling"
  /** a solve would close it; the miss queue usually carries the job */
  | "solvable"
  /** a modelling choice we would keep even with unlimited compute */
  | "by-design";

export interface Approximation {
  id: string;
  /** the Sources registry card this belongs to */
  source: string;
  title: string;
  /** what the answer is actually read from, instead of the exact node */
  what: string;
  /** why it cannot be exact today */
  why: string;
  /** what would close it — a solve, a vendor change, or nothing */
  fix: string;
  status: ApproxStatus;
  /** miss-queue kinds that count this firing */
  missKinds?: string[];
  /** a distinctive substring of the answer warning this writes */
  warn?: string;
  /** the caveat line(s) on the source card(s) this entry accounts for — a
   *  distinctive substring each. Several, because one approximation is often
   *  printed on both cards it sits between, and because some caveats are
   *  composed at runtime (the MES drift lines name the family and the class
   *  count) so only a stable fragment can be claimed. */
  coversCaveat?: string | string[];
  /** what it costs, when someone has actually measured it */
  cost?: string;
  /** where it lives */
  code?: string;
}

export const APPROXIMATIONS: Approximation[] = [
  // ---- preflop, chart side ------------------------------------------------
  {
    id: "far-size-snap",
    source: "hrc-6max",
    title: "Villain's raise size is not in the tree",
    what: "the answer is read at the tree's nearest size, in log space, whenever that is within 2x",
    why: "the HRC grid solves a fixed size menu per node; villains use whatever they like",
    fix: "solve the tree with that size in the menu — the miss-queue row carries the job",
    status: "solvable",
    missKinds: ["size-snapped"],
    warn: "OFF-TREE SIZE",
    cost: "under τ (log-dist 0.4) translation costs <0.01% pot; past it, up to 0.5-1.8% pot at the 2x ceiling",
    code: "services/hrc3max.ts walk3max · utils/snapToken SNAP_TAU / SNAP_MAX",
  },
  {
    id: "size-refused",
    source: "hrc-6max",
    title: "Villain's size is more than 2x from anything in the tree",
    what: "nothing — the chart declines, and the spot falls to the AI preflop piece or goes unanswered",
    why: "past ~2x the nearest node no longer resembles the spot, so a snapped answer would be worse than none",
    fix: "the same solve as above; until then this is the class that produces real no-answers",
    status: "solvable",
    missKinds: ["size-off-tree"],
    code: "services/hrc3max.ts walk3max (SNAP_MAX ceiling)",
  },
  {
    id: "beyond-ladder",
    source: "hrc-3max",
    title: "Stacks deeper than the solved ladder",
    what: "the deepest rung answers, as if the stacks were that deep",
    why: "the grid stops at 150bb (NL200) / 200bb (NL25); the pool plays deeper",
    fix: "175 / 200 / 225bb rungs — the largest single block in the miss queue",
    status: "solvable",
    missKinds: ["beyond-ladder"],
    code: "services/hrc3max.ts chartFor (beyondLadder)",
  },
  {
    id: "short-rung-snap",
    source: "hrc-3max",
    title: "The short stack is between solved rungs",
    what: "the nearest solved short rung answers",
    why: "the asymmetric grid is a ladder, not a continuum",
    fix: "finer rungs, or accept it — the rungs are 5bb apart over the busy range",
    status: "by-design",
    missKinds: ["short-rung-snapped"],
    code: "services/hrc3max.ts snapRung",
  },
  {
    id: "open-not-in-set",
    source: "hrc-6max",
    title: "The open size has no tree in the uneven set",
    what: "the nearest open size's tree answers",
    why: "the uneven 6-max set was solved for a subset of the open ladder",
    fix: "extend the uneven set to the full open menu",
    status: "solvable",
    missKinds: ["open-not-in-set"],
    code: "services/hrc6max.ts chartFor6max",
  },
  {
    id: "no-limp-uneven",
    source: "hrc-6max",
    title: "Limped pot at uneven stacks",
    what: "the EVEN 100bb limp chart answers, whatever the real stacks are",
    why: "limp trees were solved for the even set only (Windows boxes, 3-6x the budget)",
    fix: "limp trees for the uneven set",
    status: "solvable",
    missKinds: ["no-limp-uneven"],
    code: "services/hrc6max.ts chartFor6max",
  },
  {
    id: "caller-cap-chart",
    source: "hrc-6max",
    title: "Hero is the third caller and the tree has no call for him",
    what: "his decision is read one caller fewer, with the earliest call folded",
    why: "the 6-max trees cap how many cold-callers a node offers",
    fix: "a tree with the extra caller branch",
    status: "solvable",
    missKinds: ["caller-cap"],
    warn: "CALLER CAP",
    cost: "one caller fewer means a smaller pot, so it calls slightly too tight",
    code: "utils/borrowHeroCall",
  },
  {
    id: "hrc3max-rake",
    source: "hrc-3max",
    title: "3-max grid solved at a rake we no longer play",
    what: "NL25 play reads charts solved at the NL200 1bb cap unless the ign25 grid covers the state",
    why: "the original grid predates the NL25 cutover",
    fix: "the ign25 grid, already built for the covered rungs",
    status: "solvable",
    coversCaveat: "grid solved at the NL200 1bb cap; NL25 play sees a 4bb cap",
    code: "services/hrc3max.ts siteFor",
  },
  {
    id: "no-river-betting",
    source: "hrc-3max",
    title: "Un-resolved rungs have no heads-up river betting",
    what: "those charts come from the original CI-10 auto-solve generation",
    why: "the v2ci re-solve has only reached the traffic-ranked rungs",
    fix: "finish the v2ci re-solve across the ladder",
    status: "solvable",
    coversCaveat: "un-resolved rungs have no HU river betting (CI-10 auto-solve)",
    code: "services/hrc3max.ts V2CI_RUNGS",
  },

  {
    id: "limp-3plus",
    source: "hrc-6max",
    title: "Three or more limpers",
    what: "the line is FITTED: the earliest limper is folded until the line fits the chart (see line-fit-borrow) — answered, one player lighter",
    why: "the limp trees were solved with a two-limper cap; GTO Wizard's engine caps `max_allowed_limps` at 2, which means ONE non-SB limper",
    fix: "a limp tree with a third limper branch — GTO Wizard can never help here, so it has to be ours. HRC sizes a 3-limper 100bb tree at 20-37 GB against its 20 GB limit (wizard probe, 2026-09-22): it needs a bigger-memory machine",
    status: "solvable",
    missKinds: ["action-not-in-tree"],
    cost: "0.21% of NL200 5-6 handed hands (14 of 6,809, measured 2026-09-21); a hard no-answer until the line fit shipped 2026-09-22",
    code: "services/hrc6max.ts (the _olimp charts) · gtowAiPreflop.ts treeBody",
  },
  {
    id: "coldcall-3plus",
    source: "hrc-6max",
    title: "Three or more cold callers",
    what: "the line is FITTED: the earliest plain caller is folded (see line-fit-borrow), or hero's own call is read one caller fewer (caller-cap-chart)",
    why: "both trees cap how many cold callers a node offers; ours at two, GTO Wizard's at one",
    fix: "a tree with the extra caller branch — 29-34 GB for three callers at 100bb against HRC's 20 GB limit (wizard probe, 2026-09-22)",
    status: "solvable",
    missKinds: ["action-not-in-tree"],
    cost: "measured 2026-09-21: 0.10% of NL200 5-6 handed hands (7 of 6,809)",
    code: "services/hrc6max.ts · utils/borrowHeroCall",
  },
  {
    id: "no-legal-collapse",
    source: "gtow-ai",
    title: "A 4+ way street no collapse can reduce",
    what: "RE-ROOTED at the current street (services/multiwayReroot.ts): earlier streets become pot, the entering ranges are narrowed by three-seat walks, and the current street alone is collapsed — refused only when every villain has paid on the current street itself",
    why: "a GHOST needs a villain whose tokens are all checks/folds and a MERGE needs two adjacent villains committing at most once per street; walked from the flop, a villain who paid there can never be dropped",
    fix: "a fourth postflop seat in some solver; meanwhile price the re-root on 3-way spots where the full tree exists",
    warn: "RE-ROOTED",
    status: "vendor-ceiling",
    cost: "measured 2026-09-21 by replaying real hands through the real planCollapses: 0 of 425 NL200 4+ way hero decisions (flop 215 / turn 130 / river 80) — it exists, and the pool has never produced one. scripts/collapseCoverage.ts re-measures it for free",
    code: "services/multiwayCollapse.ts planCollapses / collapseRefusal",
  },
  {
    id: "limped-multiway-postflop",
    source: "hrc-6max",
    title: "Postflop out of a limped-and-isolated multiway pot",
    what: "each villain's arrival range is read from a FITTED line that keeps his own seat and action (see line-fit-borrow)",
    why: "two holes stacked: the chart's limp tree runs out of line, and the fallback AI tree hits the one-limper ceiling, so neither can produce arrival ranges",
    fix: "the same third-limper branch as limp-3plus — it unblocks the ranges as well as the preflop answer",
    status: "solvable",
    cost: "limped pots are 8.4% of NL200 4+ way flops (53 of 632); the failing sub-class within that is not yet measured",
    code: "services/fastSolve.ts recon6max -> arrivalRangesGtowAi",
  },

  {
    id: "line-fit-borrow",
    source: "hrc-6max",
    title: "Lines past the chart's caps are fitted by folding the earliest caller",
    what: "while the chart refuses the line, the EARLIEST plain limper or caller is folded (never hero, never a later raiser), his later actions dropped, and the nearest spot read — everyone else keeps his real seat; flop ranges are fitted per villain the same way",
    why: "every 6-max chart holds at most two limpers, two callers of a raise and four entrants — a limit HRC's 20 GB memory ceiling forces, measured with the wizard probe 2026-09-22",
    fix: "wider trees on a bigger-memory machine; until then, measure the fit against a chart holding both nodes (the maxactive-6 test chart first)",
    status: "solvable",
    warn: "LINE FITTED",
    cost: "unmeasured for the preflop decision (errs tight: the folded player's chips are missing); the borrowed arrival ranges measured 0.008 bb. Esoteric stress run 18/19 answered",
    code: "utils/fitLine/fitLine.ts walkFitted · fastSolve.ts solvePreflop6max / recon6max",
  },
  {
    id: "limp-4bet-menu",
    source: "hrc-6max",
    title: "A named 4-bet inside a limped pot",
    what: "the chart refuses (its 4-bet menu is all-in only); GTO Wizard AI answers with the real sizes after the line fit folds the extra limper — refused only when both limpers stay in to the 4-bet",
    why: "a named 4-bet size is what pushed the 6-max limp tree past HRC's memory limit (2026-09-15); the AI fallback cannot express the limp",
    fix: "a limp chart with two iso sizes and a named 4-bet — it FITS (wizard probe 2026-09-22; the full iso menu + 4-bet is 21.3 GB, just over)",
    status: "solvable",
    warn: "LINE FITTED TO THE TREE: GTO Wizard",
    cost: "eso-14, answered since 2026-09-22 through the AI line fit; corpus rate unmeasured",
    code: "hrc-api/scripts/genSixMaxPlan.ts (limp 4-bet menu)",
  },
  {
    id: "rekeyed-in-place",
    source: "hrc-6max",
    title: "26 charts were re-keyed without their raw output",
    what: "their node keys were corrected in place, but nodes the old converter lost to key collisions are still missing",
    why: "the converter keyed nodes one token short where HRC forced a fold (fixed 2026-09-22); 40 charts were re-exported from raw HRC output, 26 had none left anywhere",
    fix: "re-solve those 26 (D100_o2, D100_o3, D125_o3_5, D150_o2_5, D30_o3, D75_o2, D75_o3_5 and 19 uneven D100 charts)",
    status: "solvable",
    cost: "a missing node is a refused walk (the fallback answers) — never a wrong seat; count unmeasured",
    code: "the chart factory (poker): rekeyCharts.ts · analysis/pipeline/solve/hrc_to_preflop.py",
  },

  // ---- preflop, GTO Wizard AI side ---------------------------------------
  {
    id: "gtow-limp-cap",
    source: "gtow-ai-preflop",
    title: "Two limpers cannot be expressed",
    what: "the line fit folds the extra limpers (never hero, never a later raiser) so the one-limper tree can answer — for hero's decision and, seat by seat, for the flop ranges",
    why: "GTO Wizard's solve engine caps max_allowed_limps at 2, and 2 means ONE non-SB limper plus the SB complete. Measured 2026-09-21: the tree endpoint accepts 3, the engine then refuses it with `Input should be less than or equal to 2`",
    fix: "a vendor change; the line fit (utils/fitLine, gtowAiPreflop fitAiLine) is the stand-in",
    status: "vendor-ceiling",
    coversCaveat: "two-limper pots are not in the tree (the API stops at one limper)",
    code: "services/gtowAiPreflop.ts treeBody (max_allowed_limps)",
  },
  {
    id: "reduced-tree-arrival",
    source: "gtow-ai-preflop",
    title: "Flop ranges read around the last raise",
    what: "when the exact preflop tree cannot hold the line and no per-seat fit mends it, the flop-entering ranges are read around the last raise: the raiser's = his range before it (hero: what the chart told him; a limper: the pool's limp range; otherwise his range on the exact tree) × the share that makes that raise on the exact tree; each caller's = his range before it × the hands that do NOT fold to it on a heads-up GTO Wizard AI tree of him and the raiser where the raise is a forced bet (the raiser posts it, the caller posts the chips he already had in, the rest of the pot is dead money, stacks as dealt, seated by postflop order) — one tree per caller; a caller all in for less is taken as not folding",
    why: "hand 4921846667 (2026-10-01): UTG limps, hero over-limps, the CO isolates, hero limp-reraises on a line fitted to the tree's one-limper cap (UTG read as folded), UTG calls and leads the flop — the tree that answered preflop had no UTG in the pot and nothing fell back: no answer, a timeout, a sit-out. No limp chart trains that corridor either (reached 1 in 2,500,000 hands at UTG's node in the pool-locked tree, 1 in 167,000 in the boosted one)",
    fix: "an HRC tree with every step of the corridor locked or boosted (the limps, the iso, the cold-call), one corridor per tree — only worth a solve if these spots show up in the miss data",
    status: "by-design",
    coversCaveat: "the folded players' cards and the calls between a player's entry and the last raise are not modelled",
    cost: "hand 4921846667 replayed 2026-10-01: 77 on K♠9♠Q♦ facing a 72% pot lead answers FOLD 99.99% in 5.4 s (no answer at the table). Which continuing hands re-raise instead of calling is not applied (the solver shoves most of them; the player called)",
    code: "utils/reducedArrival + services/gtowAiPreflop.ts reducedArrivalRanges",
  },
  {
    id: "dead-sb",
    source: "gtow-ai-preflop",
    title: "A dead small blind",
    what: "the missing SB is modelled as a ghost seat posting a penny whose only action is the fold (blind 0.01, no limp, no calls, no sizes) — a penny of dead money, nobody extra in the pot; the rake cap counts the seats actually dealt",
    why: "the API refuses a player with blind 0 at solve time and refuses a position set without an SB, so a hand where the SB seat emptied has no exact shape; the penny ghost measured closest (2026-09-23: the 0.5bb ghost had hero limping 1.75% of his range from the phantom dead money). Until 2026-10-01 the ghost was all-in for its penny, which took one of the three flop seats the AI allows and removed every cold-call but the BB's (hand 4921843568: no flop ranges after the BTN called hero's open)",
    fix: "nothing on our side",
    status: "vendor-ceiling",
    coversCaveat: "a dead small blind cannot be expressed",
    code: "services/gtowAiPreflop.ts shapeOf (deadSb)",
  },
  {
    id: "untrained-chart-node",
    source: "hrc-6max",
    title: "A chart node the solver never trained is refused",
    what: "per node, reach (the chart's own play) and regret (its mix against its own EVs) are precomputed; a node past the bounds (regret > 0.03 bb/hand or reach < 1 in 10,000) is refused and the exact GTO Wizard tree answers",
    why: "HRC samples in proportion to reach: the SB behind two limps was reached once in 10,000 hands and limped AA 84% from noise; the BB behind two limps and a complete showed a check at −7.8bb in a 4bb pot",
    fix: "WIRED 2026-09-24 at the 100bb rung: limped pots read the pool-locked trees (olimp_pool3; the SB's own complete decision from olimp_pool), whose locks train those nodes — BB behind two limps and a complete reach 1 in 3,400 (was 1 in 147,000). Still fires on the D30-D75 equilibrium limp charts and on a non-blind over-limp behind two limps; the D50/D75 pool re-solves close those",
    status: "solvable",
    code: "services/nodeTrust.ts; analysis/pipeline/solve/node_trust.py writes data/limp_node_trust.json; fastSolve.solvePreflop6max",
  },
  {
    id: "postflop-last-resort",
    source: "gtow-ai",
    title: "A 4+ way street no collapse can reduce is played heads-up against the last aggressor",
    what: "every villain has chips in on this street and no pair is mergeable, so the street is re-rooted heads-up between hero and the last aggressor: the other villains' chips (and hero's own earlier chips this street) stay in the pot as dead money and hero faces the aggressor's bet at the real price",
    why: "the collapse primitives (ghost a seat that committed nothing, merge an adjacent pair) have nothing to work with when everyone committed; this shape was seen 0 times in 425 real 4+ way decisions but a blank is not an answer (Brady, 2026-09-23)",
    fix: "unmodelled: the other villains' ranges and hands, and the narrowing of the two entering ranges by earlier streets — a 4-player postflop solver would be the exact fix and none exists",
    status: "vendor-ceiling",
    code: "fastSolve.ts heroVsAggressor / solvePostflopViaChain (the !picked branch)",
  },
  {
    id: "last-resort-heads-up",
    source: "gtow-ai-preflop",
    title: "A preflop line no tree can walk is played heads-up against the last aggressor",
    what: "everyone but hero and the last aggressor is folded out, their chips stay in the pot as dead money, and GTO Wizard AI solves that heads-up tree at the real sizes and stacks",
    why: "three limpers who all raise later, a 4-bet size the limp tree cannot snap, three cold-callers who re-raise each other: neither the charts nor the exact AI tree hold the line, and a blank is worse than a rough answer (Brady, 2026-09-23)",
    fix: "wider limp trees (a third limper) and named 4-bet sizes in the limp trees remove most of the lines that reach here; the folded players' ranges and seats still to act stay unmodelled by design",
    status: "solvable",
    code: "services/gtowAiPreflop.ts reduceToHeadsUp / solvePreflopLastResort; fastSolve.ts 6-max strategy branch",
  },
  {
    id: "position-relabel",
    source: "gtow-ai-preflop",
    title: "Our seats are relabelled onto the API's fixed position set",
    what: "earlier seats are mapped in order onto the set for that player count (3 = BTN/SB/BB, 4 = CO/BTN/SB/BB, …)",
    why: "the API offers one fixed position set per player count, not arbitrary labels",
    fix: "nothing on our side — the relabel is order-preserving, so the tree shape is right even when the names are not",
    status: "vendor-ceiling",
    code: "services/gtowAiPreflop.ts API_SETS",
  },
  {
    id: "solver-noise",
    source: "gtow-ai-preflop",
    title: "Two identical spots can get different answers",
    what: "each shape is solved fresh in the cloud rather than read from a stored chart",
    why: "that is what a live solve is; the tree is cached per shape for the process's life, not beyond it",
    fix: "nothing — it is the price of exact-shape solving",
    status: "by-design",
    coversCaveat: "solved fresh in the cloud",
    code: "services/gtowAiPreflop.ts solutions cache",
  },

  // ---- postflop -----------------------------------------------------------
  {
    id: "field-cap-3",
    source: "gtow-ai",
    title: "Four and five-way flops are collapsed to three seats",
    what: "the field is collapsed to three in every legal way, each solved, and the results blended",
    why: "GTO Wizard's postflop trees hold three players",
    fix: "nothing on our side",
    status: "vendor-ceiling",
    cost: "a single collapse over-bets by 8-13pp of aggression, which is why they are blended rather than picked",
    code: "services/multiwayCollapse.ts · fastSolve.ts (planCollapses / blendStrategies)",
  },
  {
    id: "borrowed-caller-ranges",
    source: "gtow-ai",
    title: "The range walk borrows past the tree's caller cap",
    what: "a node with too many callers is read from the nearest one the tree has",
    why: "the same caller cap as the chart side, reached while reconstructing arrival ranges",
    fix: "a tree with the extra caller branch",
    status: "solvable",
    code: "services/aiChain.ts (borrowed-caller shortcut)",
  },
  {
    id: "mes-off-list-flop",
    source: "mes-postflop",
    title: "Off-list flops answer from the nearest texture",
    what: "a board that is not one of the solved boards reads its family's nearest stored texture",
    why: "the MES batch solves a board list, not every flop",
    fix: "more boards per family",
    status: "solvable",
    coversCaveat: "off-list flops answer from the nearest texture",
    code: "services/mesPostflop.ts",
  },
  {
    id: "mes-drift",
    source: "mes-postflop",
    title: "The MES solves are conditioned on a preflop layer that has moved",
    what: "the locked solves answer against the hero range they were built with, not the live one",
    why: "the MES batch best-responds to a fixed pool model and hero range; refitting preflop changes the inputs underneath it",
    fix: "re-run the MES batch behind every preflop refit (run_batch_win.py → build_mes_study.py)",
    status: "solvable",
    coversCaveat: [
      "conditioned on the preflop layer",
      // composed per family at request time: "M1 was solved against a hero range that differs … in 30 classes"
      "was solved against a hero range that differs",
      // the same fact, printed on the preflop card it depends on
      "the MES flop solves are conditioned on these ranges",
      // and the pool-model card's version of it
      "the pool model changed after the served MES build was locked against it",
    ],
    code: "routes/sources.ts mesPostflopInfo (the drift check)",
  },
  {
    id: "mes-flop-only",
    source: "mes-postflop",
    title: "Flop and turn stored, nothing beyond",
    what: "every other postflop line goes to the AI chain instead",
    why: "turn/river continuation waits on the .locked.bin extracts",
    fix: "finish the extracts",
    status: "solvable",
    coversCaveat: "flop street only",
    code: "services/mesPostflop.ts",
  },

  {
    id: "gtow-charts-deep",
    source: "gtow-charts",
    title: "Crawled charts stop at 200bb",
    what: "a deeper stack snaps to the 200bb set and finds nothing there",
    why: "the crawl covers 20 / 40 / 50 / 75 / 100 / 150bb — there is no 200bb set to land on",
    fix: "crawl the missing depths, or keep these charts as the :8777-is-down fallback they are",
    status: "solvable",
    coversCaveat: "deep stacks snap to 200bb and find nothing",
    code: "services/preflopDb.ts",
  },
  {
    id: "gtow-charts-no-limp",
    source: "gtow-charts",
    title: "Crawled 6-max charts have no limp lines",
    what: "a limped pot has no node in this set at all — it falls through to another piece",
    why: "the GTO Wizard library's 6-max tree does not contain limps",
    fix: "nothing on our side; our own HRC limp trees are the answer, and this set is only the fallback",
    status: "vendor-ceiling",
    coversCaveat: "limp lines are not in the 6-max tree",
    code: "services/preflopDb.ts",
  },

  // ---- opponent model -----------------------------------------------------
  {
    id: "no-6max-pool-model",
    source: "hrc-6max",
    title: "No pool model at six seats",
    what: "ring spots get the equilibrium mix — no exploit overlay at all",
    why: "the pool-model builder walks a 3-seat tree",
    fix: "pool-model-6max-nl200 (blocked on the builder)",
    status: "solvable",
    coversCaveat: "no pool model at 6-handed yet",
    code: "services/strategies.ts",
  },
  {
    id: "exploit-first-decision-only",
    source: "exploit-preflop",
    title: "The exploit overlay stops after hero's first decision",
    what: "facing a 4-bet, limp lines and every other depth fall back to the equilibrium chart",
    why: "the overlay is five choice nodes derived at one state",
    fix: "locked-root charts — the planned follow-on",
    status: "solvable",
    code: "services/fastSolve.ts (exploit branch)",
  },
  {
    id: "exploit-one-state",
    source: "exploit-preflop",
    title: "One 100bb state, reused at every stake and depth",
    what: "the overlay derived at 100bb ign200 answers wherever it is armed",
    why: "it is a single fitted artifact, not a grid",
    fix: "derive per stake and depth",
    status: "solvable",
    coversCaveat: "one 100bb ign200 state, reused at every stake",
    code: "EXPLOIT_CHART artifact",
  },
  {
    id: "pool-thin-reads",
    source: "pool-model",
    title: "Some pool reads are thin",
    what: "fold-vs-3-bet frequencies rest on n≈266 / 170 and are shrunk 1.5 SE toward equilibrium before use",
    why: "the corpus has that many observations of those spots and no more",
    fix: "more hands, or leave the shrinkage doing its job",
    status: "by-design",
    coversCaveat: "fold-vs-3-bet reads are thin",
    code: "analysis pool model build",
  },
];
