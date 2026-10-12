# Live step feedback in the answer panel — investigation + build plan (2026-10-12)

Brady, 2026-10-12: the panel's states ("folded", "next hand", "no answer", "solving your spot…") should say exactly
what is happening, live, at every stage of a decision — "Reading the HRC chart" while it really is, "Asking GTO Wizard
AI (preflop)", … "Ready to execute" while the action buttons are not up yet — in plain words, never internal functions.
Example lines approved. **Build after the live session**; this is the investigation (read-only, done during a live
session: no tests, no API calls, bounded log reads).

## 1. What the panel can say today, and why

The decision is invisible between capture and answer. The API's study poller pulls the wrapper's `/state` (via
`/api/ingest`) about once a second, makes ONE loopback `POST /fast-solver` call (`studyPoller.ts:880`), and only when
it returns pushes `POST /panel/answer` to the wrapper. Every step inside that call — chart read, GTO Wizard tree, node
polls, locks, re-trees, account failover — happens out of sight; its trace (`answerTrace.ts`, ~50 events) leaves only
at the end in the `X-Answer-Trace` header.

Main answer line (`panel.html:1126`), first match wins: answer · "— you win, hand over —" · "— folded, next hand —" ·
"waiting for your turn…" · "press SOLVE…" · "no answer — couldn't solve this spot" · "try N came back empty (…) —
asking again…" · "solving your spot live (GTO Wizard AI)…" · "solving your spot…".

### Things that are wrong or missing today (found on the way)

| # | Gap | Where |
|---|---|---|
| G1 | Nothing says which solver step is running | no data on either side |
| G2 | "Ready to execute, buttons not up yet" reads as a REFUSAL: `sa-ready` shows "not your turn (no turn buttons on the table)" | `relay.ts:552`, `panel.html:1770` |
| G3 | "✓ executed CALL" is shown at SEND, not when the table confirms (`outcome: "pending"`) | `relay.ts:913`, `panel.html:1778` |
| G4 | An AUTO press in flight (typing the size, read-back) shows nothing | `relay.ts:411-487, 652-771` |
| G5 | A no-answer fold / check is invisible on the panel (feed only) — "folded, next hand" looks the same as hero's own fold | `relay.ts:1363` `lastNoAnswerFold` not on `/state` |
| G6 | Hero clock / time bank left not shown (deliberately off `/state`) | `state.ts:140-152`, `relay.ts:1255` |
| G7 | Showdown never detected: a hand at showdown reads "waiting — action-on unknown"; "won" only when all villains fold | `ws.ts:916` `w.handOver` not exported, `hand.ts:534` |
| G8 | When pushes stop, the 3 s answer expiry flips a real answer back to "solving your spot…" (a stall reads as work) | `relay.ts:27,48-53` |
| G9 | Buy-panel closes, sit-back-in, net drop/disconnect, reader stall (`feedStalled`) never reach the panel | `reader.ts:434`, `sitback.ts:97`, `/state.net` undrawn, `loops.ts:41-50` |
| G10 | **Hidden ~2 s before solving starts**: the poller's ingest is slow (p50 2.1 s, p90 7.3 s, >1.5 s on 2,193 ticks in 4 days); hero's turn → "decision seen" is not measured anywhere | `studyPoller.ts:438`, `tickSteps` |
| G11 | Sitting out / waiting for BB only on the /table card, not the study card | `panel.html:827-829` |

## 2. Measured (last 4 days: 3,077 answers, ~3,050 auto presses; `poker.sqlite` answers / poller_events, indexed reads)

| Route | n | seen → answer p50 / p90 / p99 |
|---|---|---|
| HRC chart (`hrc-6max-preflop`) | 1,746 | 0.07 / 0.14 / 0.7 s |
| GTO Wizard AI preflop | 366 | 4.7 / 8.1 / 15 s |
| — of which pool-limp lock | 69 | 7.1 / 10.4 s |
| — fit-empties | 10 | 12 s |
| GTO Wizard postflop chain | 920 | 3.9 / 12.4 / 22.5 s |
| — cached trees | ~790 | 3.1-3.7 / 9-11 s |
| — one fresh cloud solve (re-tree), 13% | 120 | flop 9.2 / 19 s, turn 5.6 / 14, river 5.7 / 10 |
| No answer | 45 | 25 no-probe, 12 GTO Wizard timeout (p50 16 s), 8 other |

Answer → press p50 0.3-0.4 s (p90 to 1.8 s); press → table confirmed p50 0.95 s, p90 1.4 s; 3,020/3,034 confirmed, 18
needed a second press; holds ~1 per 15 decisions (mostly pre-action top-up); retries on 2.6% of decisions; hung polls 9,
re-posts 4. **So:** chart answers are too fast for sub-steps (one line, then "Ready"); the AI preflop, the pool locks,
postflop re-trees / node reads, the ingest gap, retries/failover and the ~1 s confirmation are long enough to watch.

Load warning: event-loop stalls appear in 87% of answer traces (p50 0.2 s) and 2,386 `[stall]` lines in 40 min — the
step machinery must be in-memory and tiny (no per-step log lines, no disk).

## 3. The step vocabulary (one line per thing Brady would recognise)

Rule: a step is a user-meaningful stage. Range blends, checkpoints, memo hits, prefetch, chain summaries, served-mix
narrowing → never their own step (they live inside the step that contains them). Account names come from
`gtow-accounts.json` labels ("Ultra", "Elite 1", "Ultra 2"), never session ids.

### A. Reading the table (wrapper)
| Step | Shown when | Source |
|---|---|---|
| New hand — reading the table | `PLAY_STAGE_INFO` → `beginHand` | `ws.ts:800-813` |
| Cards: A♠ K♦ | hole cards from the socket | `ws.ts:928-978` |
| Finding our table… (N s) | capture not bound / frame lost | `view.ts:86-98` |
| Checking the table — pot on screen disagrees, holding | line uncertain / screen check | `hand.ts:441-450`, `shadow.ts:64-81` |
| Buttons are up but the read is stale — not trusted yet | `notToActWhy` | `hand.ts:30-48,545-551` |
| Table reader stopped — not reading | `feedStalled` (G9) | `loops.ts:41-50` |
| Waiting for your turn — seat N to act | not hero's turn | `hand.ts:526-551` |
| **Your turn — sending the spot to the solver (N s)** | hero to act, API has not picked it up yet (G10 made visible) | wrapper, until the first API step arrives |

### B. Solving (API — emitted as each stage STARTS)
Preflop:
| Step | Start point |
|---|---|
| Reading the HRC chart | `solvePreflop6max` `fastSolve.ts:3738` |
| Chart answered | chart node served |
| Chart doesn't cover this spot (‹reason›) → asking GTO Wizard AI (preflop) | refusal branches `:3831-3993`, `:4609-4616` (reason in words: "line not held", "size past the chart", "off the chart", "gap gate"…) |
| Asking GTO Wizard for the exact tree (the chart is the backup) | gap gate / fit rule `:4646-4685` |
| SB completed → asking GTO Wizard AI | `:4605` |
| Using the tree built when the cards came | warm-up joined / solve cache hit (`gtowAiPreflop.ts:875`) |
| Building the preflop tree on GTO Wizard (‹account›) | `postPreflopSolution` `gtowAiPreflop.ts:899` |
| GTO Wizard solving… N s | node read `readNode` `:1214` (panel ticks the seconds) |
| Locking the limper to the pool's range | `solvePreflopPoolLocked` `gtowAiPreflop.ts:2554` |
| Solver plays this limp itself — no lock needed | trigger skipped `:2596` |
| Locking the cold-caller to the pool's range | `gtowAiPreflop.ts:2744` (or "not needed" `:2784`) |
| Locking the limper's reply to your raise | `isoResponseLocks` `:2672` (only when the experiment is on) |
| Your earlier action is off the tree → locking it back in | hero self-lock `:1852-1876` |
| Re-reading the line on GTO Wizard's sizes | NODE_DOES_NOT_EXIST repair `:1777-1818` |

Postflop:
| Step | Start point |
|---|---|
| Getting the preflop ranges into the flop | `flopArrival` `fastSolve.ts:1849` — only shown if it takes >0.5 s |
| Too many players for one tree → solving N three-player trees | `planCollapses` `:2069` |
| Reusing this street's tree | size-free reuse `aiChain.ts:1477-1490` / tree cached |
| Re-building the tree (bet size off the menu) | pinned FIXED re-tree `aiChain.ts:1491-1541` |
| Sending the ‹street› tree to GTO Wizard (‹account›) | `ensureCustomSolution` `aiChain.ts:1542` → `gtowApi.ts:860` (cached → "already solved") |
| GTO Wizard solving the ‹street›… N s | node reads `aiChain.ts:1399-1419` → `gtowApi.ts:910` |
| Villain's bet is off the solver's tree → locking his range | `aiChain.ts:1893-2004` |
| Pot didn't match the table → solving again | seatbelt `fastSolve.ts:1749` |

Both / failure:
| Step | Start point |
|---|---|
| GTO Wizard ‹account› busy → trying ‹account› | `[gtow-route]` failover (`gtowAiPreflop.ts:930-973`), hung poll / 429 (`gtowApi.ts:1194-1204`, `aiChain.ts:1742-1761`, `relocate` `gtowAiPreflop.ts:779`) |
| Waiting on another solve to finish | `studyPoller.ts:626-634` |
| Try N came back empty (‹reason›) — asking again | `lastNavFailure` (kept) |
| No answer — ‹what failed last, e.g. GTO Wizard timed out twice (40 s)› | final failure |
| Too late — you'd already acted | `abandoned-stale` `studyPoller.ts:683-690` |
| **Answered: ‹HRC chart / GTO Wizard AI preflop / GTO Wizard AI postflop / … pool-locked› · X.X s** | `solveSpot` `:852` |

Source names: `hrc-6max-preflop` HRC chart · `gtow-ai-preflop` GTO Wizard AI (preflop; `:pool-lock` / `:coldcall-lock`
piece → "… limper/cold-caller locked to the pool") · `gtow-api-postflop` GTO Wizard AI (postflop) · `hrc-3max-preflop`
HRC 3-handed chart · `pool-exploit-preflop` pool exploit chart · `hrc-hu-preflop` HRC heads-up chart · `local-preflop`
local chart · `mes-postflop` MES exploit.

### C. Executing (wrapper)
| Step | Today | Source |
|---|---|---|
| **Ready to execute CALL — waiting for the action buttons** | reads as refusal (G2) | `pickReady` reason "no turn buttons" `relay.ts:552` |
| Ready — waiting for the client's notice to close / closing the Buy-chips panel | refusal text | `relay.ts:557-560`, `topup.ts:215-225` |
| Executing CALL in 1.6 s | "auto-execute is armed: fires in N s" | `studyAutoDue` |
| Holding: ‹why› (N s) | "⚠ line uncertain — auto-execute is holding" | `relay.ts:1141-1156` |
| Pressing RAISE — typing 7.5 bb… | nothing for auto (G4) | `actuate` `relay.ts:411-487, 652-771` |
| Pressed CALL — waiting for the table to confirm | "⏱ CALL sent — waiting…" | `pendingExec`, `relay.ts:938-940, 841-896` |
| ✓ CALL landed on the table (0.9 s) | shown at send (G3) | `outcome === "confirmed"` |
| Refused (‹reason›) — retrying 1 of 2 | feed only | `relay.ts:1168-1173` |
| ⚠ The table took X — not the pick / never showed | kept | `panel.html:1744-1746` |
| Clock: 9 s + 45 s bank · taking the time bank | clock hidden (G6) | `heroTimeLeft` `relay.ts:1255`, time-bank (kept) |

### D. Hand end / between hands
| Step | Today |
|---|---|
| You folded — waiting for the next hand | "— folded, next hand —" |
| No answer in time — FOLDED / CHECKED (‹why›) | invisible (G5) |
| Timed out — the table folded you | indistinguishable today |
| Showdown — won / lost ‹amount› | not detected (G7) |
| You won the pot — waiting for the next hand | "— you win, hand over —" |
| Sitting out — press I AM BACK / Waiting for the big blind / deep-stack reset (existing banner) | /table card only (G11) |
| Connection dropped — the session ends at hand end | not drawn (G9) |

## 4. Plumbing (minimal-intrusion)

1. **API step emitter** — `services/answerTrace.ts` already follows every await of a solve (incl. `gtowApi`,
   `gtowAiPreflop`, `gtowSessions.logRoute`). Add `key` to `Trace` + `tsetKey(key)` (call in `routes/fastSolver.ts` right
   after parsing `expectKey`, ~:98) and `tstep(label, info?)`: writes a normal trace event AND updates an in-memory
   `liveSteps: Map<decisionKey, {startedAt, steps:[{label, lane?, at, endAt?, status}]}>` (cap 50 keys, drop 60 s after
   the answer). Untraced contexts (warm-ups) → no-op. Parallel work (pool lock ∥ chart, cold-call lock, collapse walks)
   gets `withLane("pool lock", fn)` so lanes do not interleave.
2. **Delivery: push on change, not on tick.** The tick is slow (ingest p50 2.1 s), so a step change triggers a
   debounced (~200 ms) fire-and-forget `POST /panel/answer {key, steps}` to that table's wrapper (the poller already
   knows the URL per table). Also on `getStatus()` (`solve: liveSteps.get(lastProbeKey)` + server `now`) for the
   dashboard. A few POSTs per decision — negligible.
3. **Wrapper step tracker** — new `src/steps.ts` in `S` (one process = one table), decision key
   `${handNo}|${street}|${nActs}` (the form `maybeFoldNoAnswer` uses; API key converts via `k[0]`/`k[4]` like `pickReady`,
   `relay.ts:570-581`). The CURRENT step is derived on each `/state` from state that already exists (`pickReady`,
   `pendingExec`, `autoHeld`, `heroTimeLeft`, `hand`, the API's latest steps); a short timeline ring is appended at the
   points that already log (`AUTO.note*`, `verifyDone`, `maybeFoldNoAnswer`, `sayPanelClosed`, `maybeSitBackIn`).
   Published as `/state.steps` only when non-null (like `panelChain`, `view.ts:114-118`) so reader recordings stay
   byte-identical. `/tables` and the multi-table Tables card get it for free (`session.ts:1209-1226`).
4. **Panel** — the main readout becomes ONE live step line with its own seconds counter (client-side from `at` +
   server `now`), today's sub-lines become detail; after the answer, a compact trail under it:
   `HRC chart → doesn't cover (line not held) → GTO Wizard AI preflop (Ultra 2) 7.9 s → ✓ CALL landed 0.9 s`.
   The trail is also stored with the answer record (`answers.path`) so the hand page can show it later.
5. Fix G8 at the same time: when pushes stop with an answer on screen, say "Answer kept — solver connection quiet (N s)"
   instead of falling back to "solving your spot…".

## 5. Build plan (after the session)

| Phase | Content | Risk / gate |
|---|---|---|
| 1 | Wrapper-only: `steps.ts`, `/state.steps`, panel step line + trail; fixes G2, G3, G4, G5, G6, G8, G11; "Your turn — sending to the solver (N s)" | no answer-path change; wrapper tests + `/state` recording byte-identity; quick gate (no rig relaunch without asking) |
| 2 | API: `tstep`/`liveSteps`/lanes in `answerTrace.ts`, step calls at the start points above, push-on-change to the wrapper | touches fastSolve/aiChain/gtowAiPreflop call sites (labels only, no logic) → **replay gate** `replayGate.ts --session <tonight> --control <main>` must show identical answers; full suite, tsc |
| 3 | Hand end: export `w.handOver` → showdown won/lost (G7); net/disconnect + reader stall lines (G9) | reader change → reader recordings re-checked |
| 4 | Measure G10 (hero's turn → decision seen) and decide whether the ingest gap needs its own fix | separate investigation |

Each phase on a `claude/` branch in poker-wrapper, merged to main by Brady (merge = deploy; API restarts itself when
idle; the panel reloads itself on `panel.html` mtime; wrapper changes need the WRAPPER RELAUNCH).

## 6. While waiting: elapsed time + details (Brady 2026-10-12)

Every step that waits on something (GTO Wizard, a lock, the table, the poller) shows its **elapsed seconds, ticking**,
plus the details that tell Brady whether this is normal. One line, details after a `·`:

`GTO Wizard solving the flop tree… 6.2 s · Ultra 2 · new tree (re-built: bet size off the menu) · usually ~9 s · gives up at 40 s · try 1 of 3 · your clock 9 s + 45 s bank`

| Detail | When shown | Source |
|---|---|---|
| Elapsed (ticks client-side from `at` + server `now`) | every waiting step | step `at` |
| Account (friendly name) | any GTO Wizard step | `[gtow-route]` / `logRoute` |
| What is being solved: preflop tree / flop / turn / river tree, 3-way, "N three-player trees" | GTO Wizard steps | chain stage / collapse plan |
| New tree vs already solved / joined a solve already running | GTO Wizard steps | `tree CREATED/cached`, `joined`, solve-cache hit |
| Why a new tree (bet size off the menu, villain off-tree, line repair) | re-trees | step reason |
| "usually ~X s" — p50 for this route, from the answers table at API start (refreshed daily, never on the answer path) | GTO Wizard + lock steps | `answers` latency by route (section 2) |
| Give-up limit ("gives up at 40 s" for locks/gates, node clock 12/15/30 s) | steps with a box | `poolLockMs`, `gapGateAiMs`, node clocks |
| Try N of 3 / "switched from Ultra (hung 8 s)" | after a retry or failover | `lastNavFailure`, relocate |
| Your clock: N s + bank (only once a solve passes ~5 s, or the bank is in play) | any solve step | `heroTimeLeft` |
| "waiting on table 2's solve" | busy slots | `studyPoller.ts:626-634` busyWith |
| Colour: normal → amber past the route's p90 ("slower than usual") → red past 80% of the give-up limit | all waiting steps | p90 per route |

The same elapsed + detail format applies to the wrapper waits: "Ready to execute CALL — waiting for the action buttons
2.1 s", "Pressed CALL — waiting for the table to confirm 1.2 s (usually ~1 s)", "Holding: Buy-chips panel open 4 s",
"Your turn — sending the spot to the solver 1.8 s".

## 7. Decisions (Brady 2026-10-12: "go with your suggestions")

1. Parallel lanes: both shown while running; only the served lane in the trail.
2. Chart answers: trail only, no flash.
3. Hero clock: shown once a solve passes ~5 s or the bank is in play (as in the details table above).
4. Voice: unchanged (answers only).

**Queued: build starts when the live session ends** (phases 1 → 2 → 3 → 4, each on a claude/ branch, Brady merges).

## 8. Built (2026-10-12, branch `claude/live-steps`, after session_20261012_211242 ended)

Phases 1 + 2 in one branch (the step line is only worth having with both halves).

**Wrapper** — `gto-trainer/apps/wrapper/src/steps.ts` (new): the current step derived on every `/state` (reading → your
turn / sending to the solver → the API's solve steps → ready / executing / pressed → landed → hand over), the per-decision
trail (the API's finished steps + the wrapper's milestones: answer in, pressed, landed / diverged / never showed, held,
hold cleared, no-answer fold, time bank). `/state.steps` only while answers are on (goldens untouched). `POST
/panel/steps` (contract `panelSteps`). Milestones marked in `relay.ts` (executePick, verifyDone, maybeAutoAct hold /
resume, maybeFoldNoAnswer, maybeTakeTime) and `server.ts` (/panel/answer: the first push of a decision). `stepsTick()` in
the feed loop dates hero's turn. `/tables` carries each table's step (`session.tableCard`). A retry of the same decision
(new run id) keeps the earlier try on the trail ("Try 1: …") and tags the live step "try 2".

**Panel** — `#sa-step` (the live line: text, seconds ticking every 250 ms off the server's `now`, details after `·`,
"usually ~X s", "gives up at N s", amber "slower than usual" past the route's p90, red at 80 % of the give-up limit),
`#sa-trail` (the trail, `→`-joined, each with its time). With steps on, the answer line holds only the answer, the
readiness line and the "sent — waiting" line give way to the step line; the "try N came back empty" line still shows.
The Tables card shows a table's step when it has no answer.

**API** — `services/liveSteps.ts` (new): `StepRun` per live ask (routes/fastSolver.ts, only when the poller names its
wrapper + decision), `tstep / tstepEnd / tstepDetail / withLane`, debounced fire-and-forget push to the wrapper, final
line "Answered: <source> · X s" / "No answer on this try (X s) — <reason>". Account names via `gtowSessions.logRoute`.
Step calls placed (labels only — no await, ordering or return changed) in fastSolve.ts (chart read + plain-English miss
reason `chartMissWords`, AI ask, gap gate box, pool / cold-call locks in their own lanes, flop ranges, collapse trees in
lanes, seatbelt), gtowAiPreflop.ts (tree built / already solved, solving, re-post, line repair, hero self-lock, lock
re-solves), aiChain.ts (reuse / re-build / send tree, solving with usual + node clock, account reroute, off-tree lock),
gtowApi.ts (details: already solved, joined, new tree, poll hung).

Deviations from §3/§6: usual / slow times are constants measured 2026-10-12 (`liveSteps.USUAL`), not read from the
answer log at start; a cached preflop tree says "tree already built for this hand" (a warm-up tree cannot be told from
one an earlier decision built); the iso-reply lock is a detail of the limper lock, not its own step; one "solving" step
per street, not per node read. Known cosmetic edges: a gap-gate / lock request that outlives its box can still add a step
after the chart answered; parallel last-resort / re-root walks share one lane.

Tests: wrapper `test/unit/live-steps.test.ts` (keys, off when answers off, sending, API steps + trail, ready-not-refusal,
pressed → landed, retry, the panel renderer incl. amber / red); API `src/services/liveSteps.test.ts`.
