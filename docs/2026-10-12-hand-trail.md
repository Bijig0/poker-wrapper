# Hand trail card on the Ignition panel — design (2026-10-12)

Brady, 2026-10-12: CoinPoker's on-demand ring panel shows the ranges at the node; build the same for Ignition, but as a
**complete trail**: per street, the line up to the action; hero's action chart is the main thing shown; any other seat's
range / action chart when that seat is selected on the line; each street its own trail; and **the complete config that
produced hero's chart** (rake, sizes, stacks, where each range came from …), live for the current decision, so a human
can check in real time that the answer was obtained correctly. Investigation done read-only during a live session;
**build after the session**, on a `claude/` branch.

## 1. Decisions (Brady, 2026-10-12)

| # | Question | Answer |
|---|---|---|
| D1 | Show the trail on auto-execute tables too? | **Yes** (card collapsed by default there) |
| D2 | The action AFTER hero's last decision (villain calls the river bet) — its chart is a node we never read | **Chip only, no grid, unless the node is already cached** (never spend GTO Wizard requests for the trail) |
| D3 | Facing a bet: hero only, or side by side? | **Side by side**: hero's action chart + the villain's action chart at the action hero faces |
| D4 | After the hand ends | **Keep the trail until hero's next decision**, with a link to the dashboard hand page |
| D5 | Table-vs-solved flags | ~~Flag every difference~~ → **superseded: no automatic flags.** Brady: "not meant to be some self-checking thing, I am the one end state cross-referencing and verifying that the stuff sent in is correct" — the card shows the inputs exactly as used; he compares them with the table |

## 2. What exists (reuse, don't rebuild)

- Panel card "Ranges at this node" — `ignition-study-wrapper/panel.html:399` (markup), `:1402-1490` (`renderRanges`).
  Gated off for Ignition by ONE line: `if (siteId !== "coinpoker" || !s.onDemand)`. Draws with the dashboard's own
  renderer (`/study/grid169.js` + `.css`, `classGrid`).
- `/state.panelAnswerRef` (`wrapper/src/relay.ts` `answerRef()`, set in `server.ts` `/panel/answer`) — decision key,
  solveId, client hand id. Already populated for Ignition answers; not under the 3 s freshness gate.
- `GET /api/dashboard/live-node` (`api/src/routes/dashboard.ts:2122`) — ONE node: postflop from `solveStore.forAnswer`
  + `expandTrace`; preflop only for an AI pin (`livePreflopNodeView`, `services/gtowAiPreflop.ts:3693`) — **a chart pin
  is refused**, and HRC charts answer ~57% of Ignition decisions (1,746 / 3,077 in 4 days).
- `GET /api/dashboard/preflop-path?dbId=` (`dashboard.ts:1858`) — the whole preflop line walked down the answering chart,
  every seat's strategy and range, each step mapped to the archived action. Needs a `hands` row (= hand over).
- `GET /api/dashboard/chart-setup` (`dashboard.ts:2203`) + `services/chartSetup.ts` `chartSetup(id)` — seats + stacks,
  blinds, ante, rake + cap + nfnd, size menu, generation, the solver's format line; HRC, library and AI-preflop ids.
- `expandTrace` (`dashboard.ts:2029`) — postflop spec (positions, flop pot/stack, rake + `rakeSent`/`rakeDefaulted`,
  `rangeSource`, hero combo), per street (`sentOf`: the tree request + account, `fixedLevels`, `solId`, `solveMs`,
  entering ranges per seat) and every node (actor, actions, `actorStrategy`, taken + %, ranges in/out).
- Preflop pin (`services/preflopPin.ts`) — in memory via `handFacts`, last answer of the hand wins:
  `chart6max` {chartId, depth, rawTokens vs codes, `sizeSnaps`, `foldedSeats`, `picks[]` = every earlier hero decision
  and the mix he was given} or `gtow-ai-preflop` {solId, shape, `reduced`, `poolLocks`, `heroSelfLock`, cacheKey}.
  **Forgotten at hand end** (`forgetPreflopPin`) — D4 needs the trail captured before that (§4.3).
- Pool-seat badges (the `answer-node` helper above `dashboard.ts:1547`): which seats' flop ranges are pool floors /
  locks (`arrival.poolSeats` + the answer's `POOL … RANGE:` notes) → `departureForCode` → the departures register.
- Answer log columns per decision: chart, source, tier, depth, set_id, line, decision_json, solve_id, warning,
  path / path_verdict / chain, press, seat_stats, latency_ms.

## 3. The card

```
┌ Hand trail ─ #4921…  A♠K♦  HJ 100bb ─────────────────────── [collapse] ┐
│ PREFLOP ✓ UTG f · [HJ you] 2.5 · CO f · [BTN] 3b 8 · SB f · BB f · [HJ] c   │
│ FLOP K♣7♦2♥ ● [HJ you] x · [BTN] b33% (2.8bb) → [HJ you] ?   ← current    │
├────────────────────────────────────────────────────────────────────────┤
│ HJ (you) — your action chart [grid, AKo ◻]  │ BTN — his action chart     │
│ AKo — call 62% · raise 38%                  │ (took b33%, 41% of range)  │
├ Inputs · FLOP ───────────────────────────────────────────────────────────┤
│ answered by  GTO Wizard AI postflop · tree cached · Ultra · 3.1 s        │
│ pot 17.5bb · stacks HJ 91.5 / BTN 91.5                                   │
│ rake 5% cap 3bb (as sent to GTO Wizard; "defaulted" if the spec had none) │
│ sizes  bet 33/75/125 · raise 3x · fixed levels …                         │
│ ranges in  BTN = his 3-bet-call range off HRC chart X at line Y          │
│            HJ = as answered (hero range as answered)                     │
│ seats in tree  HJ, BTN    (collapsed out: none)                          │
│ experiments on  HERO_RANGE_AS_ANSWERED, POOL_CALLS …                     │
└──────────────────────────────────────────────────────────────────────────┘
```

- **One row per street**, reached streets only. Chips = every action on the street in order, actor + size; hero's
  chips marked. Finished streets show the whole street; the current one stops at hero's decision (`?`).
- **Selection.** Default = hero's latest decision on the latest street. **D3: when hero faces an action on that street,
  the villain's action chart at that action is drawn beside hero's** (CoinPoker's current behaviour). Clicking any chip
  selects that decision: a villain chip = his action chart there (taken action named, % of range); a seat yet to act =
  his range arriving; an earlier hero chip = hero's chart and the mix he was given there (`picks[]` preflop, the solve's
  hero node postflop).
- **D2:** a chip whose node was never read (after hero's last decision, or seats outside the solved tree) is drawn
  but greyed "chart not read — would cost a GTO Wizard request"; a node already in the solve cache draws normally.
- **Inputs block per street** (open for the selected street):
  - Preflop, chart: chart name + id + family + generation, the solve's seats and stacks, blinds,
    ante, rake %/cap/nfnd, size menu, **the line as played vs the line read** (rawTokens vs codes, `sizeSnaps`),
    `foldedSeats`, depth used.
  - Preflop, AI: the tree request (shape: stacks, sizes, limps, rake), account, solId / cached, `reduced`
    (dropped seats), `poolLocks`, `heroSelfLock`, last-resort kind.
  - Postflop (Brady 2026-10-12: "use the configs we send to GTO Wizard postflop AI"): **the tree request exactly as
    sent**, per street — `st.sent` (recorded since 2026-09-24; older solves are rebuilt by `sentOf` and labelled
    "rebuilt"): board, pot, stack(s) per seat, rake + cap, starting street, size menu / pinned wagers (`played` or
    `fixedLevels`), HU grid, positions; plus account, solId, cached vs fresh, solveMs; the answering source + tier +
    latency; pot / stacks in; **where each seat's range came from**
    (GTO arrival off chart/line, pool floor/lock + its departures-register entry, hero-as-answered); seats in the tree vs
    collapsed out (multiway collapse plan); re-tree / off-tree lock notes; the answer's chain verdict and warning.
  - Experiments in force for the answer (the env switches the departures register names for that path).
- **D5 — no automatic judging (Brady 2026-10-12).** The card is the INPUT, verbatim and readable; Brady is the check.
  No ⚠ verdicts, no "table vs solved" section, no computed mismatch list. What the card does show, because it IS an
  input: each chip names the action as the tree read it (size in the tree's terms + bb), and the line block shows the
  tokens read (`codes`) beside the tokens captured (`rawTokens`) and any `sizeSnaps` / `foldedSeats` the piece recorded
  — those are facts of the input, stated, not graded. Rake = the rake the chart was solved with (`chartSetup`) or the
  rake sent to GTO Wizard (AI preflop shape / postflop `sent`); a request that sent none says "GTO Wizard's default
  (NL500)" in words.
- **D1:** shown on every table; on an auto-execute table the card starts collapsed (one summary line: the streets so far), expanded on click; remembered per panel in localStorage.
- **D4:** at hand end the trail stays (header "hand over") until hero's next decision of a new hand, with
  "open in dashboard ↗" to the hand page (`/hand/<dbId>` once archived; the panel resolves dbId by client hand id).
- CoinPoker on-demand keeps "Ranges at this node" (as built, §6: its hands have no row until they end).

## 4. Build

### 4.1 API — `GET /api/dashboard/live-trail?hand=<clientHandId>` (as built: one reply with every grid — §6)
Read-only, never calls GTO Wizard, never creates a tree. Without `node`: the trail (streets, chips, inputs, flags) +
grids for hero's selected decision and (D3) the faced villain action. With `node`: that one chip's grid(s).

Assembled from:
1. the hand's answer-log rows (`answerLog.forHand(clientHandId)`) — every decision so far, source/chart/solve id;
2. `handFacts.get(hand)` — the table's own line, stacks, pot, positions, hero cards (the "table" side of every flag);
3. preflop: the pin. **Refactor `/preflop-path`'s walker into a function taking (chart id, line, hand facts)** so the
   chart case works live, not only from a `hands` row; the AI case = `livePreflopNodeView` generalised from hero's node
   to every prefix node (the pin already pre-fetches them → cache reads, no requests; a missing node = D2 grey chip);
4. postflop: per street, the latest answer's `solveStore` row → `expandTrace` (nodes across streets; take each street's
   nodes from the latest solve that holds them);
5. `chartSetup(id)` for the chart inputs; the pool-seat helper for range provenance; the departures register for names.

Server-side cache by (hand, decisionKey) so four panels / re-renders never recompute; keep the last finished hand per
table so D4 survives `forgetPreflopPin`. Grids are class-level (169) like `live-node` — no 1326 arrays on the wire.

### 4.2 Panel (`ignition-study-wrapper/panel.html`)
Replace `renderRanges` with `renderTrail`: drop the CoinPoker/on-demand gate; fetch once per new
`panelAnswerRef.decisionKey` (no polling); chip clicks fetch `&node=`; collapse state per table in localStorage.

### 4.3 Load safety (the API stalls ~370x / 5 min during sessions today)
- Off switch `PANEL_TRAIL=off` (API route answers 404 → panel hides the card).
- Pure in-memory reads + one cached computation per decision; no disk scans; no GTO Wizard.
- Before merge: time the route offline over a recorded session's hands (p50/p99 ms, payload KB) — target < 20 ms and
  < 60 KB per decision; per-decision cost logged once in the API's `[slow]` line if over 50 ms.

### 4.4 Phases
1. API route + tests (chart pin, AI pin, postflop chain, multiway collapse, hand with no answer yet, finished hand).
2. Panel card behind `PANEL_TRAIL`, CoinPoker parity (its node view must match today's `live-node` output).
3. Offline timing + a replay on a recorded session; Brady merges → live after a wrapper relaunch.

## 5. Open (small, decide while building)
- ~~Ignition's real rake~~ — settled 2026-10-12: show the configs used (chart setup / the request sent), no comparison.
- Hand page link: dbId only exists after archive; until then link the session's hand list.

## 6. Built (2026-10-13, branch claude/hand-trail)

- **API** `GET /api/dashboard/live-trail?hand=<clientHandId>` (`routes/dashboard.ts`, block "the panel's hand trail"):
  read from the hand's row (the Ignition wrapper writes a `live` row on every change — `wrapper/src/archive.ts`
  `liveHandTick`), the answer log, the stored solves, the hand facts and the solve cache. Never a GTO Wizard request.
  Cached per hand until the row (`updated_at`, status) or the answers change. `PANEL_TRAIL=off` → 404.
  - Preflop: each hero decision from the piece that answered it — a chart decision from `/preflop-path`'s walk
    (refactored into `preflopPathOf(e, ai, chartAnswer?)`, the route unchanged), an AI decision from its kept tree
    (`livePreflopNodeView`, which now also returns the seats that folded before hero with their fold chart). A hand
    with both (chart open, AI answer to the 3-bet) draws the nodes before the AI decision from the AI tree.
  - Postflop: nodes from the stored solve that holds the most of the street (a later street's chain walked the
    villain's reply after hero's last decision); inputs from the solve made for that street's own answer — the tree
    request as sent (`st.sent`, recorded since 2026-09-24; older solves rebuilt and labelled so).
  - Hero decisions carry `facing` = the last villain action before him on the street that is not a fold (a bet or
    raise first, else a limp / call / check) — drawn beside hero's chart (D3).
- **Panel** card "Hand trail" (`ignition-study-wrapper/panel.html`, `renderTrail`): Ignition only — CoinPoker keeps
  "Ranges at this node" (its hands have no row until they end). Fetched once per new answer (`panelAnswerRef`) and once
  more when the hand ends; kept until hero's next decision (D4). Folded by default on auto-execute tables, open on
  manual ones, unless the card was folded/opened by hand before (remembered) (D1). Every click target is a span, so
  Enter / Space still execute the pick.
- **Measured offline** (`bun src/scripts/liveTrailBench.ts --hands 100`, the last 100 recorded hands, real env): build
  p50 5 ms, p90 57 ms, p99 226 ms (the first, cold); reply p50 39 KB, max 139 KB; a cached re-ask < 1 ms. 179/179
  hero decisions drew their node. Chips without a chart: streets after hero folded (nothing solved), villain actions
  after hero's last decision of the hand, seats a multiway tree collapsed out, and a chart line past hero's fold that the
  chart does not hold (a limp into an open-only chart) — each said in the street's note.
- Tests: `routes/dashboardLiveTrail.test.ts` (live row + stored solve: chips, pending node, facing, others, inputs,
  cache, 404s, off switch).

## 7. Independent review (2026-10-13) and what changed

A separate reviewer (fresh context) read the branch: no correctness blocker; ten findings, all checked against the
code and fixed:

1. **A folded card fetched anyway** → the panel fetches nothing while the card is folded (auto-execute tables start
   folded) and loads it when opened; the header says "open to load this hand's trail".
2. **Every rebuild re-expanded every earlier solve** → expanded solves kept across rebuilds (64, by answer row), and
   `expandTrace(trace, { lite: true })` skips the per-combo panels and post-action ranges the trail never draws.
3. **A failing build was re-asked every 3 s** → each street is built in its own try/catch (a broken street becomes a
   note, never a 500); the panel backs off 3 → 10 → 30 s and gives up on that decision after four tries.
4. **Last-resort AI trees named the seats SB / BB** → mapped back to the table's seats through the heads-up
   reduction (`reduceToHeadsUp(...).keptPos`), as the flop's resume does; unmappable seats are tied to no chip.
5. **Hero's postflop chart could come from a later street's re-tree** → hero's nodes (and everything up to his last
   decision on the street) come from the street's own answer's solve; only the actions after it from the later solve.
6. **End-of-hand fetch could read the row before the archive finished it** → one more ask while it still reads live.
7. **A later AI tree overwrote an earlier decision's villain charts** → the earlier tree keeps the actions before it.
8. **ClubGG fetched** → the card runs on Ignition only.
9. **No fetch timeout; redraws closed the raw-request section** → 15 s abort; open sections stay open.
10. **Tests missed the risky paths** → `dashboardLiveTrail.paths.test.ts`: own-vs-later solve, a rebuild on a new
    answer, a throwing street, a hand hero folded, a last-resort tree's seat mapping.

After the fixes (last 100 hands, real env): build p50 4.5 ms, p90 35 ms, p99 76 ms (was 226); 179/179 decisions with
their node; chips with a chart 616/949 (was 584). Full API suite and wrapper unit suite green on the merged result.

## 8. The full view — dashboard `/live` (2026-10-15, branch claude/trail-full)

Brady, 2026-10-14: the card shows "slivers"; he wants, per street that has happened and is happening, stacked, per
seat: his range, his action, "super complete … a professional live can have all this info when analysing a hand live",
with "the same UI for the ranges as … the exact node". Decisions (Q&A 2026-10-14/15):

| # | Question | Answer |
|---|---|---|
| F1 | Where | **A full-width dashboard page per table** (`/live`, tab "Live"); the panel card stays as the compact twin and links to it |
| F2 | Layout | Every reached street stacked, all open; one card per seat still in when the street began, hero's highlighted |
| F3 | Per seat | **His range arriving on the street + his action chart at each action** (no "range after") |
| F4 | EV | **Shown**, labelled the solve's: range EV per action and hero's combo EV (postflop; HRC charts carry none) |
| F5 | Numbers | **All**: pot, to call, behind, effective stack, SPR, size as % pot, pot odds, MDF — at every action |
| F6 | Equity | **No** (none computed; the page is the hand page's data, live) |
| F7 | Density | Small grids; hero's latest decision full size; any grid one click to full size |
| F8 | Outside the tree | A seat the street's solve does not hold is kept, labelled — never fetched |
| F9 | Sites | Ignition only (CoinPoker has no row until the hand ends) |

As built:
- **API** `GET /api/dashboard/live-trail?hand=&full=1`: the same trail plus, per postflop node, the per-combo rows with
  each combo's split and EV (`combos`), the range EV per action (`evs`, Σ w·s·ev / Σ w·s over the combos), hero's own
  row (`heroRow`), the tree's pot; per street `seats` (every seat in when it began: the table's stack there, and — the
  street's own solve — his range entering it with its combos) and `potIn`. Every chip carries `math` (TrailMath) from
  the hand's own record (`startStacksOf` + `roundContributions`), light reply too. Pot odds / MDF only facing a bet,
  raise or all-in on the street — the blinds are not one. `&since=<sig>` answers `{unchanged}` when the reply has not
  moved (the page polls every 1.5 s while the hand is live). Full expansions are cached apart (16, by answer row).
- `GET /api/dashboard/live-trail/tables`: per table its live row's hand and its hands answered in the last 12 h (one
  indexed scan, `answerLog.recentHandsByTable`).
- **Page** `dashboard.html` view `live` (`/live?table=N[&hand=ID]`): table tabs, "follow the table" (the hand in play,
  else its last answered one), the table's recent hands, newest-street-first toggle; per street the line with each
  action's size as % pot (hover: the full situation), the seat cards (exact-node `classGrid` with combos, the
  `weightGrid` look for ranges, hero's mix + EV + the answer), and the inputs block per street (chart setup and line read
  vs captured / AI tree / the stored solve, the rake sent, `sentBlock` — "Sent to GTO Wizard").
- **Panel card**: the situation line under hero's decision and "open the full view ↗" (`:2000/live?table=&hand=`).
- Measured (`liveTrailBench.ts --hands 100 --full`, real data): build p50 5 ms, p90 33 ms, p99 120 ms; reply p50
  41 KB, p90 394 KB, max 1.3 MB; light reply unchanged (p99 73 ms, max 137 KB).
