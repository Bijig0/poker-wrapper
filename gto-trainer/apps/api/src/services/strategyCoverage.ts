/**
 * HOW A STRATEGY ANSWERS EVERY SPOT (2026-09-22, Brady: "in the sources section for our strategy ... make it clear"
 * which piece answers which spot, what the borrow means, what it costs against equilibrium, and where the holes are).
 *
 * One map per whole-hand strategy, rendered on its Sources page (/sources/strategies/<id>). Each row is a CLASS of
 * spot: which piece answers it, how, what that costs, and what would make it exact. The rows are AUTHORED here
 * because they describe code paths, but they never carry a live number: how often each approximation fires comes
 * from the approximations register (services/approximations.ts) through `approx` ids, joined in routes/sources.ts.
 * The HOLES list on the page is that register filtered to this strategy's sources — not a second list — so a hole
 * is added in one place (the register) and appears here and on /sources/approx at once.
 *
 * Cost fields say whether a number was MEASURED (and how), or is UNMEASURED. Never guess a number into one.
 */

export interface CoverageCost {
  /** a short headline, e.g. "0.008 bb / decision" or "unmeasured" */
  value: string;
  measured: boolean;
  /** how it was measured, or what would measure it */
  note: string;
}

export interface CoverageRow {
  id: string;
  /** the spot class, in the reader's words */
  spot: string;
  /** which piece answers it */
  source: string;
  /** plain-language mechanics */
  how: string;
  example?: string;
  cost: CoverageCost;
  /** what would make it more exact, when anything would */
  future?: string;
  /** approximations-register ids this row leans on (their live fire counts are joined in) */
  approx?: string[];
}

export interface CoverageSection {
  title: string;
  rows: CoverageRow[];
}

export interface StrategyCoverage {
  sections: CoverageSection[];
  /** approximations-register `source` values whose entries are this strategy's holes */
  holeSources: string[];
  /** future work that is not one register entry — the bigger decisions */
  roadmap: { title: string; detail: string }[];
}

const RING_6MAX: StrategyCoverage = {
  sections: [
    {
      title: "Preflop",
      rows: [
        {
          id: "pre-charts",
          spot: "Standard preflop at a 4-6 seat table: opens, 3-bets, 4-bets, cold calls, squeezes, three-way pots",
          source: "Our HRC charts (Ignition NL200 6-max, 5% rake, cap by players dealt)",
          how: "64 solved charts: even stacks at 30/50/75/100/125/150bb, one tree per open size (2x, 2.5x, 3x, 3.5x) plus a " +
            "limp tree at 30-100bb (28), and uneven tables with one short seat at 30/50/70bb in each of the six seats (36). The " +
            "chart is picked by hero's EFFECTIVE stack (against the raiser he faces, else the deepest live seat). Real bet sizes " +
            "snap to the nearest size in the chart: within about 1.5x it is clean, up to 2x it is answered and flagged, further " +
            "than 2x it is refused and handed to the fallback below. Three-way pots inside a 6-max table (an open, a call, the BB " +
            "defends) are in these charts — they are not a GTO Wizard job.",
          cost: { value: "~0.02 bb mixed-action gap", measured: true,
            note: "ev_gap_sweep.py on the refined second pass: reach-weighted mixed gap 0.017-0.026 bb (the 3-max baseline is 0.018). " +
              "Backtest over the whole ring corpus: 99.5% of 72,414 decisions answered by the charts." },
          approx: ["short-rung-snap", "far-size-snap", "open-not-in-set", "no-limp-uneven", "beyond-ladder", "solver-noise"],
        },
        {
          id: "pre-ai",
          spot: "Preflop the charts cannot place: a table thinned to 2-3 seats, a size more than 2x off the chart's menu, a stack " +
            "past 150bb, a straddle, or a line no chart holds",
          source: "GTO Wizard AI preflop (the Ultra account)",
          how: "A tree is built from the actual table — real stacks, real positions, Ignition rake — and solved in the cloud in " +
            "1-5 s per node. Never the GTO Wizard LIBRARY (NL500, a third of the rake, no limps). Its own limits: fixed sizes " +
            "only, at most ONE limper plus the SB completing, and a dead SB has to be modelled as a forced all-in blind.",
          cost: { value: "by construction (exact for the tree it solves)", measured: false,
            note: "the answer is an equilibrium of the tree we give it; what is lost is only what that tree cannot express (the limits listed)." },
          approx: ["gtow-limp-cap", "dead-sb", "position-relabel"],
        },
        {
          id: "pre-borrow",
          spot: "Limped and multiway preflop past the chart's caps: 3+ limpers, 3+ cold callers of a raise, a 5th player entering",
          source: "Our HRC charts, read through a LINE FIT (the borrow)",
          how: "Every chart is solved under three caps that HRC's memory forces on us: at most two limpers, at most two plain " +
            "callers of a raise, and at most four players putting money in (a fifth seat is folded by the engine). When the real " +
            "line breaks a cap, we fold the EARLIEST plain limper or caller — never hero, never anyone who raises later in the hand " +
            "(his raise is the spot) — drop that player's later actions, and read the nearest spot the chart holds. Everyone else " +
            "stays in their real seat. The villains' flop ranges are fitted the same way, one villain at a time, each keeping his " +
            "own seat and his own line. The answer is labelled \"LINE FITTED TO THE TREE\".",
          example: "UTG limps, HJ limps, CO limps, hero on the BTN with 65s. The chart has no third limp, so the answer is read at " +
            "UTG FOLDS, HJ limps, CO limps, BTN to act: hero is still the button facing two limpers, one player lighter. For the " +
            "flop, UTG's range is read with the HJ folded instead, so UTG keeps his own limping range.",
          cost: { value: "unmeasured (errs slightly tight)", measured: false,
            note: "Direction is known: the folded player's chips and presence are missing, so pot odds look worse and hands that " +
              "want a multiway pot are under-played. The related borrowed ARRIVAL ranges measured 0.008 bb mean (240 nodes, one " +
              "player down, 90% top-action agreement). Measuring the preflop decision itself needs a chart that holds both nodes — " +
              "the maxactive-6 test chart (running on hrc-1 since 2026-09-22) is the first. Esoteric stress run: 18 of 19 of the " +
              "strangest limp/iso spots answered." },
          future: "Wider trees need RAM, not time. HRC's own size check (20 GB limit on our 24 GB boxes), 100bb limp tree: 2 limpers " +
            "/ 2 callers fits at maxactive 4-6; 3 limpers 20-37 GB; 3 callers 29-34 GB; 3+3 69 GB; 4 callers 53-72 GB. Past two " +
            "limpers or two callers needs a bigger-memory machine (a licence-seat question) or a coarser postflop abstraction.",
          approx: ["line-fit-borrow", "limp-3plus", "coldcall-3plus", "caller-cap-chart", "borrowed-caller-ranges"],
        },
        {
          id: "pre-limp-4bet",
          spot: "A named 4-bet or 5-bet size inside a limped pot (limp, iso, 3-bet, cold 4-bet to 38bb)",
          source: "none — refused",
          how: "The limp trees' 4-bet menu is all-in only at 50bb and deeper (a named 4-bet size is what pushed the limp tree past " +
            "HRC's memory limit). A 38bb 4-bet is more than 2x from the 100bb jam, so the snap refuses it, and the AI fallback " +
            "cannot express the limp either.",
          cost: { value: "no answer", measured: true, note: "the one spot of the 19-spot esoteric stress run that still fails (eso-14)." },
          future: "the same RAM decision as the caps above — a named 4-bet roughly quadruples the limp tree.",
          approx: ["limp-4bet-menu"],
        },
      ],
    },
    {
      title: "Postflop",
      rows: [
        {
          id: "post-hu",
          spot: "Heads-up postflop",
          source: "GTO Wizard AI — the Elite account first, the Ultra account once Elite's daily allowance is spent",
          how: "The flop is solved in the cloud from the ranges OUR preflop piece produced (never GTO Wizard's own), at Ignition " +
            "rake, and walked street by street. Elite takes heads-up work first because Ultra's allowance (1,275 requests a day) " +
            "is the only one that can do multiway; if Elite's wall is hit mid-walk the solve is re-made on Ultra.",
          cost: { value: "by construction", measured: true,
            note: "exact for the ranges it is given; the automatic size selection was compared with a full size grid and the regret " +
              "measured ≈0. River MES (the exploit) runs in SHADOW: logged beside every heads-up river answer, never played yet." },
        },
        {
          id: "post-3way",
          spot: "Three-way postflop",
          source: "GTO Wizard AI, 3-player trees (Ultra only)",
          how: "The same chain with three seats: every seat's effective stack, a fixed bet grid, and a rotation cross-check that " +
            "refuses a tree whose seat order disagrees with the table.",
          cost: { value: "by construction", measured: false, note: "exact for its tree and its fixed bet grid." },
        },
        {
          id: "post-4way",
          spot: "Four-way postflop",
          source: "GTO Wizard AI on a COLLAPSED field (Ultra), blended",
          how: "Nothing solves four postflop seats, so the field is collapsed to three in every legal way, each collapse is solved, " +
            "and the results are combined. Two ways to remove a player: a GHOST drops a villain who has only checked or folded " +
            "this far (his chips stay in the pot as dead money); a MERGE fuses two neighbouring villains into one seat holding " +
            "both ranges. When two or more ghosts are legal we BLEND them: fold as often as the MOST folding collapse and bet as " +
            "often as the LEAST betting one (more opponents can only shrink hero's share). Otherwise a merge, otherwise the one ghost.",
          example: "Four-way flop checked to hero: three ghosts are legal, three 3-way solves (~26 s), blended.",
          cost: { value: "0.008 bb checked-to / 0.046-0.066 bb facing a bet", measured: true,
            note: "528 nodes measured one player down (3→2, the only depth where the truth exists — an upper bound for 4→3): blend " +
              "0.0079 bb, merge 0.021 / 0.046 bb, one ghost 0.020 / 0.066 bb, against 0.16 / 0.68 bb for no information. Worst " +
              "case: hero in the middle facing a bet with a player still behind, 0.12 bb. A single collapse over-bets by 8-13pp; " +
              "the blend is the only rule that corrects it." },
          approx: ["field-cap-3", "no-legal-collapse"],
        },
        {
          id: "post-5way",
          spot: "Five-way postflop",
          source: "Collapsed field, two steps per collapse, blended",
          how: "The same primitives applied twice (five seats to three); up to three collapses are solved and blended (~17 s).",
          cost: { value: "unmeasurable today", measured: false,
            note: "two steps down cannot be scored — three seats is the deepest truth anywhere. The per-step error does not grow " +
              "with how much range is removed (dropping the widest range is cheapest), so no 5-way number is extrapolated." },
          approx: ["field-cap-3", "no-legal-collapse"],
        },
        {
          id: "post-6way",
          spot: "Six-way postflop (a fully limped pot)",
          source: "Collapsed field, three steps per collapse, blended",
          how: "Six seats to three. It only happens when everyone limps or completes and the BB checks; the villains' ranges come " +
            "from the line fit above.",
          example: "Four limpers, SB completes, BB checks, flop 7h4s2d checked to hero on the BTN: answered in ~11 s, three collapses blended.",
          cost: { value: "unmeasurable today", measured: false, note: "as five-way, one step further." },
          approx: ["field-cap-3", "limped-multiway-postflop"],
        },
      ],
    },
  ],
  holeSources: ["hrc-6max", "gtow-ai", "gtow-ai-preflop"],
  roadmap: [
    { title: "Measure the borrow",
      detail: "Score the line fit's preflop decisions against a chart that holds both nodes (the maxactive-6 test chart first), " +
        "the same way the collapse was scored, so the preflop borrow gets a number instead of \"unmeasured\"." },
    { title: "maxactive 6 on the limp charts",
      detail: "The one wider tree that fits in memory. If the test chart shows it matters: re-solve the four limp charts " +
        "(30/50/75/100bb, ~1-2 days on three boxes); each is probed through the wizard first." },
    { title: "The memory ceiling",
      detail: "Three limpers, three callers, or a named 4-bet in the limp trees need 20-70+ GB. Options: a bigger machine " +
        "(an HRC licence-seat decision), resizing a licensed box in place (reboots a box that must never go down), or a " +
        "coarser postflop abstraction (cheaper to test: the wizard probe reports the size without solving)." },
    { title: "26 charts re-keyed in place",
      detail: "Their raw HRC output was never kept, so the re-key fixed their node keys but cannot restore the few nodes the old " +
        "converter lost to key collisions. A re-solve of those 26 closes it." },
  ],
};

export const STRATEGY_COVERAGE: Record<string, StrategyCoverage> = {
  "ign200-ring-6max-equilibrium": RING_6MAX,
};
