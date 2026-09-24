# Hardening verdicts — 472 hero decisions in 317 hands

| verdict | decisions | distinct hands |
|---|---|---|
| OK | 202 | 141 |
| SKIPPED(cloud budget) | 163 | 150 |
| NOT-REPLAYED | 52 | 33 |
| CORRECT-REFUSAL | 20 | 8 |
| FIXED | 17 | 12 |
| NEVER-ASKED | 9 | 4 |
| STILL(capture/street-stamp) | 4 | 1 |
| STILL(capture/line-desync) | 3 | 3 |
| STILL(capture/rotation) | 2 | 2 |

## By street (decisions → verdict)

- **preflop**: SKIPPED(cloud budget) 163, OK 127, NOT-REPLAYED 30, FIXED 5, NEVER-ASKED 2, STILL(capture/rotation) 2
- **flop**: OK 42, NOT-REPLAYED 12, CORRECT-REFUSAL 11, FIXED 3, NEVER-ASKED 2, STILL(capture/line-desync) 1, STILL(capture/street-stamp) 1
- **turn**: OK 21, NOT-REPLAYED 6, CORRECT-REFUSAL 6, FIXED 5, STILL(capture/line-desync) 1, STILL(capture/street-stamp) 1, NEVER-ASKED 1
- **river**: OK 12, FIXED 4, NOT-REPLAYED 4, NEVER-ASKED 4, CORRECT-REFUSAL 3, STILL(capture/street-stamp) 2, STILL(capture/line-desync) 1

## Still failing, by root-cause class (distinct hands)

- capture/line-desync: 3 hands — dbIds [425, 441, 621]
- capture/rotation: 2 hands — dbIds [557, 583]
- capture/street-stamp: 1 hands — dbIds [489]

## Capture (WS-only snapshot vs archive at hero's turn)

- ws-identical: 346
- ws-extra-actions: 57
- no-dump: 26
- ws-divergent: 19
- ws-no-turn-frame: 16
- ws-missing-actions: 6
- ws-not-exported: 2

## Execution

- executed:auto: 318
- MANUAL-OR-MISSED: 18
- auto armed, no answer: 62
- manual session: 71
- refused: 3
- outcomes: {'confirmed': 227, 'diverged': 2, 'unknown': 1}
- hero followed the pick (answered decisions): {'True': 338, 'False': 12}
- manual-or-missed under auto: 18 → [(366, 4, 'preflop', 'Fold', 'fold'), (410, 3, 'preflop', 'Fold', 'fold'), (411, 2, 'preflop', 'Fold', 'raise 2.5'), (411, 8, 'flop', 'FOLD', 'fold'), (425, 12, 'turn', 'CHECK', 'check'), (432, 6, 'preflop', 'Fold', 'fold'), (439, 9, 'preflop', 'All-in', 'raise 96.5'), (501, 12, 'river', 'CALL 18.8', 'call 18.75'), (539, 7, 'preflop', 'Fold', 'fold'), (662, 4, 'preflop', 'Fold', 'fold'), (687, 3, 'preflop', 'Raise 9.5', 'fold'), (691, 4, 'preflop', 'Fold', 'fold'), (693, 8, 'turn', 'FOLD', 'check'), (694, 6, 'flop', 'BET 1.4', 'check'), (694, 8, 'turn', 'FOLD', 'fold')]
- RE-ROLLED LIVE (more than one distinct pick shown for one decision): 13 decisions in 9 hands — [(365, 5, 'Call | Raise 7.5'), (365, 9, 'BET 7 | CHECK'), (370, 6, 'Call | Fold'), (390, 10, 'CALL 1.7 | RAISE 4.5'), (471, 7, 'Call | Raise 9'), (471, 9, 'BET 2.4 | CHECK')]
- hero did NOT follow any shown pick: 12 → [(411, 2, 'preflop', 'Fold', 'raise 2.5', 'MANUAL-OR-MISSED', None), (438, 6, 'preflop', 'Raise 10.5', 'raise 4.0', 'executed:auto', None), (441, 3, 'preflop', 'Raise 2.5', 'raise 2.0', 'executed:auto', None), (471, 11, 'turn', 'FOLD', 'check', 'executed:auto', 'confirmed'), (479, 8, 'flop', 'CALL 4.6 | FOLD', 'check', 'executed:auto', 'confirmed'), (497, 11, 'turn', 'FOLD', 'check', 'executed:auto', 'confirmed'), (513, 5, 'preflop', 'Raise 2.5', 'raise 2.0', 'executed:auto', 'diverged'), (523, 13, 'turn', 'FOLD', 'check', 'executed:auto', 'confirmed'), (641, 10, 'flop', 'FOLD', 'check', 'executed:auto', 'confirmed'), (687, 3, 'preflop', 'Raise 9.5', 'fold', 'MANUAL-OR-MISSED', None), (693, 8, 'turn', 'CALL 3.5 | FOLD', 'check', 'MANUAL-OR-MISSED', None), (695, 11, 'flop', 'FOLD', 'check', 'executed:auto', 'confirmed')]
- then-vs-now pick disagreement (both answered; rolls differ on mixed spots): 30
- GTO Wizard requests spent by the replay so far: 629
