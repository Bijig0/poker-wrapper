/**
 * HOW A STRATEGY ANSWERS EVERY SPOT (2026-09-22, Brady: "in the sources section for our strategy ... make it clear"
 * which piece answers which spot, what the borrow means, what it costs against equilibrium, and where the holes are;
 * then "break up the preflop pieces into more granular pieces so it's clearer to see what specifically needs work").
 *
 * One map per whole-hand strategy, rendered on its Sources page (/sources/strategies/<id>). Each row is ONE class of
 * spot with a STATE — exact (the solved spot itself), approx (a nearby solved spot, labelled) or none (refused) —
 * the piece that answers it, how, what that costs, and what would make it exact. The rows are AUTHORED here because
 * they describe code paths, but they never carry a live number: how often each approximation fires comes from the
 * approximations register (services/approximations.ts) through `approx` ids, joined in routes/sources.ts. The HOLES
 * list on the page is that register filtered to this strategy's sources — not a second list — so a hole is added in
 * one place (the register) and appears here and on /sources/approx at once.
 *
 * Cost fields say whether a number was MEASURED (and how), or is UNMEASURED. Never guess a number into one.
 */

/** What the player gets in this spot, assuming every piece is up. */
export type CoverageState = "exact" | "approx" | "none";

export interface CoverageCost {
  /** a short headline, e.g. "0.008 bb / decision" or "unmeasured" */
  value: string;
  measured: boolean;
  /** how it was measured, or what would measure it */
  note: string;
}

export interface CoverageRow {
  id: string;
  /** exact = the solved spot itself; approx = a nearby solved spot, labelled; none = refused, no answer */
  state: CoverageState;
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
  /** miss-queue rows whose chart starts with this belong to the strategy (its WORK QUEUE on the page) */
  missChartPrefix?: string;
  /** solves queued or running for this strategy; progress is read from each plan dir, never typed in */
  solves?: StrategySolve[];
}

export interface StrategySolve {
  label: string;
  /** poker-zenbook/hrc-api/solves/sixmax_grid/<planDir>/plan_6max.json — done = a charts.json.gz per job there */
  planDir: string;
  boxes: string;
  status: "running" | "queued";
  started?: string;
  /** which row(s) of the map it serves, and what changes when it lands */
  serves: string;
}

const EXACT_TREE: CoverageCost = { value: "exact for the tree it solves", measured: false,
  note: "an equilibrium of the tree we build from the table, with GTO Wizard's fixed sizes." };

const RING_6MAX: StrategyCoverage = {
  sections: [
    {
      title: "Preflop · raised pots",
      rows: [
        {
          id: "pre-raised", state: "exact",
          spot: "Raised pots at 4-6 seats, even stacks, sizes on (or within ~1.5x of) the chart's menu",
          source: "Our HRC charts",
          how: "Opens, 3-bets, 4-bets, cold calls, squeezes and three-way pots, read straight from the chart. 28 even-stack " +
            "charts: 30/50/75/100/125/150bb, one per open size (2x, 2.5x, 3x, 3.5x), plus the limp charts. A size within " +
            "~1.5x of the menu snaps to it silently. NL200 rake: 5%, cap by players dealt.",
          cost: { value: "~0.02 bb mixed-action gap", measured: true,
            note: "ev_gap_sweep.py on the refined pass: 0.017-0.026 bb (3-max baseline 0.018). Backtest: 99.5% of 72,414 ring " +
              "decisions answered by the charts. A clean snap costs under 0.01% of the pot." },
        },
        {
          id: "pre-size-snap", state: "approx",
          spot: "A raise size 1.5x-2x away from anything on the menu",
          source: "Our HRC charts, snapped to the nearest size",
          how: "Read at the nearest size on the menu and labelled \"OFF-TREE SIZE\".",
          cost: { value: "up to 0.5-1.8% of the pot", measured: true, note: "the translation error at the 2x ceiling; most snaps cost far less." },
          future: "Add that size to the chart's menu and re-solve — the miss queue carries the job.",
          approx: ["far-size-snap"],
        },
        {
          id: "pre-size-far", state: "exact",
          spot: "A raise size more than 2x away from the menu (no limper in the pot)",
          source: "GTO Wizard AI preflop (Ultra)",
          how: "The chart refuses; a tree is built from the actual table with the real sizes and solved in the cloud (1-5 s per node).",
          cost: EXACT_TREE,
          approx: ["size-refused"],
        },
      ],
    },
    {
      title: "Preflop · stack depth and table shape",
      rows: [
        {
          id: "pre-rung", state: "approx",
          spot: "Effective stack between two solved depths",
          source: "Our HRC charts, nearest depth",
          how: "The chart is picked by hero's EFFECTIVE stack (against the raiser he faces, else the deepest live seat) and " +
            "snapped to the nearest of 30/50/75/100/125/150bb.",
          cost: { value: "unmeasured", measured: false, note: "the depths are 20-25bb apart; the backtest's median gap between real and charted effective stack is 4bb." },
        },
        {
          id: "pre-deep", state: "approx",
          spot: "Effective stack deeper than 150bb (165bb and up)",
          source: "Our HRC charts, the 150bb chart",
          how: "Answered from the 150bb chart as if the stacks were 150bb, and flagged.",
          cost: { value: "unmeasured", measured: false, note: "about 4% of ring decisions are past the 150bb rung (backtest)." },
          future: "175 / 200 / 250bb charts.",
          approx: ["beyond-ladder"],
        },
        {
          id: "pre-one-short", state: "exact",
          spot: "One short stack at a 100bb table, raised pot",
          source: "Our HRC uneven charts",
          how: "36 charts: one seat short at 30, 50 or 70bb, in each of the six seats, for 2.5x and 3x opens. A short stack between those depths snaps to the nearest.",
          cost: { value: "exact at 30 / 50 / 70bb", measured: false, note: "snapped in between." },
        },
        {
          id: "pre-uneven-open", state: "approx",
          spot: "One short stack, and an open size other than 2.5x or 3x",
          source: "Our HRC uneven charts, nearest open size",
          how: "The uneven set was only solved for 2.5x and 3x opens; other opens read the nearest one.",
          cost: { value: "unmeasured", measured: false, note: "" },
          future: "Uneven charts for the 2x and 3.5x opens.",
          approx: ["open-not-in-set"],
        },
        {
          id: "pre-two-short", state: "approx",
          spot: "Two or more short stacks at the table",
          source: "Our HRC uneven charts, the short stack that matters most",
          how: "The chart for the raiser, the first short stack still to act, or the shortest caller; any other short stack is " +
            "treated as full-stacked, and the answer says so.",
          cost: { value: "unmeasured", measured: false, note: "about 12% of ring decisions have a second short stack the chart ignores (backtest)." },
          future: "Uneven charts with two short seats — a large grid; price it with the wizard probe before anything is queued.",
        },
      ],
    },
    {
      title: "Preflop · limped and multiway pots",
      rows: [
        {
          id: "pre-limp", state: "exact",
          spot: "Limped pots within the caps: up to two limpers, up to two callers of the iso, up to four players in — even stacks, 30-100bb",
          source: "Our HRC limp charts",
          how: "Four limp charts (30/50/75/100bb): open-limp, over-limp, SB complete, iso-raise (2.5/3/4/5bb at 100bb), " +
            "3-bets over the iso, limp-reraise, and all-in as the only 4-bet.",
          cost: { value: "~0.02 bb (same solve quality)", measured: true, note: "the same refined pass as the raise charts." },
        },
        {
          id: "pre-limp-deep", state: "approx",
          spot: "Limped pot with stacks of 125bb or more",
          source: "Our HRC limp charts, the 100bb one",
          how: "HRC refused 125bb and 150bb limp charts with the full menu, so these read the 100bb limp chart.",
          cost: { value: "unmeasured", measured: false, note: "" },
          future: "They FIT with a leaner iso menu (wizard probe, 2026-09-22: 125bb with 2 or 3 iso sizes, 150bb with 2). " +
            "Two solves, ~10-15 h each on a Windows box.",
        },
        {
          id: "pre-limp-uneven", state: "approx",
          spot: "Limped pot with a short stack at the table",
          source: "Our HRC limp charts, the even-stack one",
          how: "There are no limp charts for uneven tables, so an even-stack limp chart answers.",
          cost: { value: "unmeasured", measured: false, note: "the most-fired approximation on the chart side." },
          future: "Limp charts for the uneven set (~18 charts, ~3-4 days on two boxes).",
          approx: ["no-limp-uneven"],
        },
        {
          id: "pre-limp-3plus", state: "approx",
          spot: "Three or more limpers",
          source: "Our HRC limp charts, through the LINE FIT",
          how: "The line fit: while the chart refuses the line, fold the EARLIEST plain limper or caller — never hero, never " +
            "anyone who raises later in the hand (his raise is the spot) — drop his later actions, and read the nearest spot " +
            "the chart holds. Everyone else keeps his real seat. Villains' flop ranges are fitted the same way, one villain at " +
            "a time, each keeping his own seat and line. Labelled \"LINE FITTED TO THE TREE\".",
          example: "UTG, HJ and CO limp; hero on the BTN. Read at UTG FOLDS, HJ limps, CO limps, BTN to act — still the button " +
            "facing two limpers, one player lighter. For the flop, UTG's range is read with the HJ folded instead, so UTG " +
            "keeps his own limping range.",
          cost: { value: "unmeasured (errs slightly tight)", measured: false,
            note: "the folded player's chips and presence are missing, so pot odds look worse and multiway hands are " +
              "under-played. The borrowed flop ranges measured 0.008 bb (240 nodes)." },
          future: "A three-limper chart needs 20-37 GB against HRC's 20 GB limit — a bigger-memory machine. First, measure " +
            "this cost against the maxactive-6 test chart.",
          approx: ["limp-3plus", "line-fit-borrow"],
        },
        {
          id: "pre-caller-3plus", state: "approx",
          spot: "Three or more cold callers of a raise or an iso",
          source: "Our HRC charts, through the LINE FIT",
          how: "The same line fit: the earliest plain caller is folded. When hero is the third caller himself, his decision is " +
            "read one caller fewer (\"CALLER CAP\").",
          cost: { value: "unmeasured (errs slightly tight)", measured: false, note: "as for three limpers." },
          future: "A three-caller chart needs 29-34 GB — the same memory decision.",
          approx: ["coldcall-3plus", "caller-cap-chart"],
        },
        {
          id: "pre-fifth-in", state: "approx",
          spot: "A fifth or sixth player putting money in",
          source: "Our HRC charts, through the LINE FIT",
          how: "The charts let at most four players in; HRC folds the rest with no decision. The line fit folds the earliest " +
            "plain caller to make room.",
          cost: { value: "unmeasured", measured: false, note: "" },
          future: "Letting all six in DOES fit in memory. A 100bb limp chart built that way is solving on hrc-1 now (since " +
            "2026-09-22 06:05 UTC); if it matters, re-solve the four limp charts that way.",
        },
        {
          id: "pre-untrained-node", state: "approx",
          spot: "A limped-pot node the chart never trained — since 2026-09-24 only below the 100bb rung (D30-D75 equilibrium limp charts) or a non-blind over-limp behind two limps; at 100bb the pool-locked trees answer — or a size past the snap tolerance",
          source: "GTO Wizard AI preflop (Ultra), exact sizes; a second limper folded out with his chips kept as dead money",
          how: "The chart node is refused by the trust map (reach and regret precomputed per node) and the spot is solved as its own tree from the table.",
          example: "BB with KJs behind CO + BTN limps and an SB complete: the chart's untrained node said raise 98%; the exact tree (CO folded out, 1bb dead) raises 3bb 100%.",
          cost: { value: "the fitted-out limper's range (his chips stay)", measured: false, note: "the exact tree cannot hold a second limper." },
          approx: ["untrained-chart-node"],
        },
        {
          id: "pre-last-resort", state: "approx",
          spot: "A preflop line neither the charts nor the exact GTO Wizard tree can walk (every extra limper raises later, a 4-bet size the limp tree cannot snap, three cold-callers who re-raise each other)",
          source: "GTO Wizard AI preflop (Ultra), heads-up against the last aggressor",
          how: "Hero and the last aggressor stay; everyone else is folded out with their chips left in the pot as dead money, and that heads-up tree is solved at the real sizes and stacks.",
          example: "UTG, HJ and CO limp, BTN isos 5, UTG 3-bets 15, HJ 4-bets 35, CO jams; hero BTN with AA: hero vs CO with 51.5bb dead — call 100%.",
          cost: { value: "unmeasured (ignores the folded players' ranges and anyone still to act)", measured: false, note: "a last resort: always an answer while GTO Wizard is up, always flagged." },
          approx: ["last-resort-heads-up"],
        },
        {
          id: "pre-limp-4bet", state: "approx",
          spot: "A named 4-bet or 5-bet size inside a limped pot",
          source: "GTO Wizard AI preflop (Ultra), through the LINE FIT",
          how: "The limp charts' only 4-bet is all-in, so a 38bb cold 4-bet is more than 2x from the jam and the chart refuses. " +
            "GTO Wizard AI takes it with the real sizes, but its tree holds ONE limper — so the line fit folds the earliest " +
            "limper who does not raise later, and the rest is solved exactly.",
          example: "UTG limps, HJ limps, CO isos to 5, BTN 3-bets 17, SB 4-bets 38, UTG jams, HJ folds; hero CO with AA. Solved " +
            "with the HJ folding at his limp (he folds later anyway): all-in 99%.",
          cost: { value: "unmeasured (one limper fewer)", measured: false,
            note: "eso-14 was the one failing spot of the esoteric stress run; answered since 2026-09-22. Still refused when two " +
              "limpers BOTH stay in to the 4-bet — the fit cannot fold a player who raises later." },
          future: "A limp chart with two iso sizes and a named 4-bet FITS in memory (wizard probe, 2026-09-22: the full four-size " +
            "iso menu plus a 30bb 4-bet is 21.3 GB, just over; two iso sizes fit). Solving it would answer this from our own chart.",
          approx: ["limp-4bet-menu"],
        },
      ],
    },
    {
      title: "Preflop · short-handed and special tables",
      rows: [
        {
          id: "pre-shorthanded", state: "exact",
          spot: "A table down to 2 or 3 seats",
          source: "GTO Wizard AI preflop (Ultra)",
          how: "The 6-max charts cover 4-6 seats; a thinner table gets a tree built from the table itself. GTO Wizard's " +
            "position names are mapped onto ours in order.",
          cost: EXACT_TREE,
          approx: ["position-relabel", "solver-noise"],
        },
        {
          id: "pre-straddle", state: "exact",
          spot: "A straddle",
          source: "GTO Wizard AI preflop (Ultra)",
          how: "The straddle is modelled as a third blind.",
          cost: EXACT_TREE,
        },
        {
          id: "pre-dead-sb", state: "approx",
          spot: "A dead small blind",
          source: "GTO Wizard AI preflop (Ultra)",
          how: "The API refuses a blind of 0, so the empty SB seat is modelled as a player holding exactly his blind (a forced all-in).",
          cost: { value: "unmeasured", measured: false, note: "" },
          approx: ["dead-sb"],
        },
        {
          id: "pre-ai-limps", state: "approx",
          spot: "Two or more limpers in a spot only GTO Wizard can answer (2-3 seats, or a size more than 2x off in a limped pot)",
          source: "GTO Wizard AI preflop (Ultra), through the LINE FIT",
          how: "GTO Wizard's engine allows one limper (plus the SB completing). The line fit folds the extra limpers — never " +
            "hero, never a later raiser — for hero's decision and, seat by seat, for the flop ranges.",
          cost: { value: "unmeasured (errs slightly tight)", measured: false,
            note: "refused only when every extra limper also raises later, so none may be folded." },
          approx: ["gtow-limp-cap"],
        },
        {
          id: "pre-rekeyed", state: "approx",
          spot: "A node lost from one of the 26 re-keyed charts",
          source: "GTO Wizard AI preflop, when the chart walk fails",
          how: "26 charts had their node keys fixed in place but lack the few nodes the old converter lost; a walk that needs " +
            "one falls to GTO Wizard AI.",
          cost: { value: "unmeasured", measured: false, note: "never a wrong seat — a missing node is a refused walk." },
          future: "Re-solve those 26 charts (~3 days on two boxes).",
          approx: ["rekeyed-in-place"],
        },
      ],
    },
    {
      title: "Postflop",
      rows: [
        {
          id: "post-hu", state: "exact",
          spot: "Heads-up",
          source: "GTO Wizard AI — Elite first, Ultra once Elite's daily allowance is spent",
          how: "Solved in the cloud from the ranges OUR preflop produced, at Ignition rake, street by street. Elite goes first " +
            "because Ultra's 1,275 requests a day are the only ones that can do multiway; if Elite hits its wall mid-hand the " +
            "solve is re-made on Ultra.",
          cost: { value: "exact for the ranges it is given", measured: true,
            note: "automatic sizing vs a full size grid measured ≈0 regret. River MES (the exploit) runs in SHADOW: logged, never played yet." },
        },
        {
          id: "post-3way", state: "exact",
          spot: "Three-way",
          source: "GTO Wizard AI, 3-player trees (Ultra)",
          how: "The same chain with three seats: every seat's effective stack, a fixed bet grid, and a check that the tree's " +
            "seat order matches the table.",
          cost: { value: "exact for its tree and bet grid", measured: false, note: "" },
        },
        {
          id: "post-4way", state: "approx",
          spot: "Four-way",
          source: "GTO Wizard AI on a COLLAPSED field, blended (Ultra)",
          how: "Nothing solves four seats, so the field is cut to three in every legal way, each version solved, and combined. " +
            "A GHOST drops a villain who has only checked or folded (his chips stay as dead money); a MERGE fuses two " +
            "neighbouring villains into one seat. Two or more ghosts: BLEND — fold as often as the most-folding version, bet " +
            "as often as the least-betting one. Otherwise a merge, otherwise the one ghost.",
          example: "Four-way flop checked to hero: three ghosts are legal, three 3-way solves (~26 s), blended.",
          cost: { value: "0.008 bb checked-to / 0.05-0.07 bb facing a bet", measured: true,
            note: "528 nodes, one player down (3→2, an upper bound for 4→3): blend 0.0079, merge 0.021 / 0.046, one ghost " +
              "0.020 / 0.066 bb, against 0.16 / 0.68 bb for no information. Worst case: hero in the middle facing a bet with " +
              "a player behind, 0.12 bb." },
          approx: ["field-cap-3"],
        },
        {
          id: "post-5way", state: "approx",
          spot: "Five-way",
          source: "Collapsed field, two steps per collapse, blended",
          how: "The same primitives applied twice (five seats to three); up to three collapses solved and blended (~17 s).",
          cost: { value: "unmeasurable today", measured: false,
            note: "two steps down has no truth to score against — three seats is the deepest any solver goes." },
          approx: ["field-cap-3"],
        },
        {
          id: "post-6way", state: "approx",
          spot: "Six-way (a fully limped pot)",
          source: "Collapsed field, three steps per collapse, blended",
          how: "Six seats to three; the villains' ranges come from the line fit.",
          example: "Four limpers, SB completes, BB checks, 7h4s2d checked to hero on the BTN: ~11 s, three collapses blended.",
          cost: { value: "unmeasurable today", measured: false, note: "as five-way, one step further." },
          approx: ["field-cap-3", "limped-multiway-postflop"],
        },
        {
          id: "post-reroot", state: "approx",
          spot: "4+ way turn or river where no collapse fits from the flop (every villain put chips in earlier, hero between them)",
          source: "GTO Wizard AI, RE-ROOTED at the current street, collapsed and blended (Ultra)",
          how: "Walked from the flop, a villain who bet or called there can never be dropped — his chips are in a street the " +
            "tree has to play. So the solve starts at the CURRENT street instead: every earlier chip becomes plain pot (exact), " +
            "and a villain who has only checked, or not acted yet, THIS street can be dropped again. The ranges entering the " +
            "street are narrowed through the earlier streets by three-seat walks that each keep hero, every earlier bettor, " +
            "and some of the callers.",
          example: "SB bets the flop, hero (BB), UTG and CO call; SB checks the turn. Re-rooted: 26bb pot, 93.5bb behind, " +
            "narrowed by 2 walks, then three turn collapses blended — KQ on K84 checks 99.6% (~19 s).",
          cost: { value: "unmeasured", measured: false,
            note: "the pot and stacks are exact; the approximation is the ranges — in each narrowing walk the callers left " +
              "out play as if they had folded. Never seen in 425 real 4+ way decisions." },
          future: "Price it the way the collapse was priced: re-root 3-way spots where the full tree exists and score the difference.",
          approx: ["no-legal-collapse"],
        },
        {
          id: "post-last-resort", state: "approx",
          spot: "4+ way where every villain has put chips in on the CURRENT street, none sit next to each other, and hero is between",
          source: "GTO Wizard AI heads-up, re-rooted at the current street against the last aggressor",
          how: "The other villains' chips stay in the pot as dead money; hero faces the aggressor's bet at the real price from the flop-arrival ranges.",
          example: "4-way limped flop Jd8c3s: SB bets 2, hero (BB) calls, CO raises 7, BTN and SB call; hero vs CO with 14bb dead — JTs raises.",
          cost: { value: "unmeasured (the other villains' ranges and hands are gone)", measured: false, note: "a subset of a shape seen 0 times in 425 real 4+ way decisions; it used to be refused." },
          approx: ["postflop-last-resort"],
        },
        {
          id: "post-after-refusal", state: "none",
          spot: "Any flop after a preflop line that got no answer",
          source: "none",
          how: "No preflop answer means no ranges to solve from.",
          cost: { value: "no answer", measured: false, note: "follows the preflop \"no answer\" rows." },
        },
      ],
    },
  ],
  holeSources: ["hrc-6max", "gtow-ai", "gtow-ai-preflop"],
  missChartPrefix: "ign200_6max_",
  solves: [
    { label: "18 limp charts for uneven tables (one short seat at 30/50/70bb, every seat)", planDir: "limp-uneven",
      boxes: "hrc-2 + hrc-3", status: "running", started: "2026-09-22 10:02 UTC",
      serves: "Limped pot with a short stack — approximate → exact once wired into the chart picker" },
    { label: "100bb limp chart, all six players allowed in (TEST)", planDir: "limpfull-test",
      boxes: "hrc-1", status: "running", started: "2026-09-22 06:05 UTC",
      serves: "A fifth or sixth player putting money in — measures what the line fit costs; decides whether to re-solve the four limp charts" },
    { label: "24 short-stack charts at 60 and 80bb (one short seat, every seat, 2.5x/3x opens)", planDir: "short-rungs-6080",
      boxes: "hrc-l1..l4 (Hetzner, Linux)", status: "running", started: "2026-09-22 10:57 UTC",
      serves: "Short stack between solved depths — the most-hit approximation (75-85bb stacks read as 70bb) → exact at 60/80bb once wired" },
    { label: "36 uneven charts for 2x and 3.5x opens (short seat 30/50/70bb)", planDir: "uneven-opens-2-35",
      boxes: "hrc-l1..l4, after the short-stack charts", status: "queued",
      serves: "One short stack and an open other than 2.5x/3x → exact once wired" },
    { label: "100bb limp chart with two iso sizes and a named 4-bet (30bb)", planDir: "limp-4bet",
      boxes: "hrc-3 (pre-empted its uneven shard, 2026-09-22)", status: "running",
      serves: "A named 4-bet inside a limped pot — approximate (GTO Wizard + line fit) → our own chart, including two limpers who both stay in" },
  ],
  roadmap: [
    { title: "Limp charts that now fit in memory",
      detail: "Wizard probe 2026-09-22: a 100bb limp chart with two iso sizes and a named 4-bet, and 125bb / 150bb limp charts " +
        "with a leaner iso menu, all fit under HRC's 20 GB. They turn the approximate named-4-bet and deep-limp rows into our own charts." },
    { title: "Measure the borrow",
      detail: "Score the line fit's preflop decisions against a chart that holds both nodes (the maxactive-6 test chart first), " +
        "the same way the collapse was scored, so the preflop borrow gets a number instead of \"unmeasured\"." },
    { title: "maxactive 6 on the limp charts",
      detail: "The one wider tree that fits in memory. If the test chart shows it matters: re-solve the four limp charts " +
        "(30/50/75/100bb, ~1-2 days on three boxes); each is probed through the wizard first." },
    { title: "Idle boxes: limp charts for uneven tables, or the 26 re-keyed charts",
      detail: "hrc-2 and hrc-3 are idle. Uneven limp charts close the most-fired chart-side approximation (~3-4 days); the " +
        "26 re-solves restore the lost nodes (~3 days)." },
    { title: "The memory ceiling",
      detail: "Three limpers, three callers, or a named 4-bet in the limp charts need 20-70+ GB. Options: a bigger machine " +
        "(an HRC licence-seat decision), resizing a licensed box in place (reboots a box that must never go down), or a " +
        "coarser postflop abstraction (cheap to test: the wizard probe reports the size without solving)." },
  ],
};

export const STRATEGY_COVERAGE: Record<string, StrategyCoverage> = {
  "ign200-ring-6max-equilibrium": RING_6MAX,
};
