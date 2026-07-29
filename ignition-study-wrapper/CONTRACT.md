# Wrapper ⇄ gto-trainer contract

The Ignition study wrapper (this directory, port **7700**) and the gto-trainer
API (port **2000**) talk over four HTTP interfaces. This file is the single
source of truth for their shapes; both sides link here. The wrapper implements
the same live-feed protocol as assistive-play's `RemoteControl`, so
gto-trainer's `resolveHand`/`studyPoller` work against either server unmodified
(consumer: `gto-trainer/apps/api/src/feed/resolveHand/resolveHand.ts`,
`services/studyPoller.ts`).

## 1. `GET :7700/state` — live game state (poller → wrapper, 1 Hz)

Consumed by `resolveHand({ live: true })`. Contract fields (extra keys are
fine — the wrapper also keeps its legacy `cdp` / `ignition` / `targets` keys
for the panel's own connection badges):

```jsonc
{
  "connected": true,          // false → poller reports "no table detected" (409)
  "studyAnswers": false,      // the panel's Study Answers toggle — THE gate:
                              // while false the poller idles and pushes null
  "hand": { … } | null,       // current hand, ParsedHand shape (§1a); null between hands
  "snapshot": {
    "status": "…" | null,     // free-text table status for error messages
    "seats": [ { "hero": true, "sittingOut": false } ]   // hero row only is enough
  }
}
```

### 1a. `hand` — ParsedHand shape

Normalized by `feed/normalizeHand` (forgiving: missing bookkeeping fields get
defaults). Invariants the wrapper guarantees at the export boundary:

| field | shape | invariants |
|---|---|---|
| `handId` | number | wrapper-local counter |
| `heroSeatId` | number | client seat number (face-up cards identify hero) |
| `heroCards` | string[] | `"A♠"`-style; ranks use **`T`, never `10`** |
| `board` | string[] | same card rules; 0/3/4/5 entries |
| `street` | `"preflop"\|"flop"\|"turn"\|"river"` | derived from board length |
| `actions` | ParsedAction[] | in true action order, blinds included |
| `actions[].type` | `post-sb\|post-bb\|fold\|check\|call\|bet\|raise\|all-in` | |
| `actions[].amount` | number (BB) | **raise/bet = the seat's round total** ("raises to"), call = the top-up; omitted until the BB scale is known |
| `positions` | `{seatId: pos}` | gto-trainer vocabulary only: `UTG/UTG1/UTG2/LJ/HJ/CO/BTN/SB/BB` — short tables fill **button-backwards** (5-handed = HJ CO BTN SB BB) |
| `stacks` | `{seatId: bb}` \| absent | from DOM labels; trusted only with an explicit "BB" suffix or a known blind size |
| `committed` | `{seatId: bb}` | this betting round |
| `currentNode` | node | `toActSeatId` from `CO_CURRENT_PLAYER`; `pot`/`toCall` in BB |
| `ended` | boolean | hero folded ⇒ true |

## 2. `POST :7700/panel/answer` — answer push (poller → wrapper)

Body `{ "text": "PREFLOP — Raise 2.5 63% · Fold 37% · roll 81 → FOLD",
"pick": "Fold", "roll": 81 }` or `{ "text": null }` to clear. `pick` is the
RNG-sampled action for mixed strategies (the panel headlines it); `roll` is
the 1-100 sample, `null` when the spot is pure (pick = the ~100% action).
Both are optional — assistive-play's original panel reads only `text`.
The wrapper stores the push with a timestamp; the panel shows it only while
the toggle is on **and** the push is fresher than `STUDY_ANSWER_TTL_MS =
3000` — so a dead poller degrades to a blank card, never a stale verdict.
The poller re-pushes the unchanged answer every tick while the spot stands
(keep-alive), repeating the SAME pick/roll — a decision is rolled once.
`/state.panelAnswer` mirrors the gated answer as `{text, pick, roll} | null`.

## 3. `POST :7700/study-answers` — the toggle (panel → wrapper)

Body `{ "on": true|false }` → `{ "ok": true, "on": … }`. Mirrored into
`/state.studyAnswers`. This local switch is the single control: the poller
reads it every tick and does nothing (no GTO Wizard navigation, no CDP
traffic) while it's off.

## 4. Audit interfaces (Feed section)

- `GET :7700/hand` → `{ ok, hand }` — the same ParsedHand as `/state.hand`,
  standalone for tooling.
- `POST :2000/api/feed-spot` `{ hand }` → `{ ok, actual, shown,
  discrepancies[], warnings[] }` — the observed table beside the solved
  config actually used, every divergence named
  (`gto-trainer/apps/api/src/routes/feedSpot.ts`).

## 5. `GET :2000/api/study-poller/status` — health (panel → gto-trainer)

`{ running, gtoWizardConnected, lastError, lastAnswer, lastPushAt, … }`.
The panel polls this to paint the toggle badge: `ON ●` healthy, `ON ⚠ <reason>`
when the poller can't deliver (GTO Wizard down, feed unreachable, …).

## Ports

7700 wrapper (assistive-play-compatible) · 2000 gto-trainer API ·
9222 GTO Wizard CDP · 9333 Ignition browser CDP (9223 = CoinPoker's, avoid).
