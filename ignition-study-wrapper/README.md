# Ignition Study wrapper (skeleton)

**STUDY / PRACTICE-MONEY ONLY.** A one-click Windows wrapper that opens the
Ignition web client and the study panel side by side:

```
┌─────────────────────────────┬───────────────┐
│  Ignition web client        │  Study panel  │
│  (Chrome app-mode window,   │  status, live │
│   --remote-debugging-port)  │  mirror, DOM  │
│                             │  probe        │
└─────────────────────────────┴───────────────┘
        └── CDP :9333 ──► launch.py panel server (:7700)
```

## Run

```
launch.cmd
```

Log into Ignition in the left window (the dedicated `.profile-table` Chrome
profile keeps the session across launches) and open a **practice-money** table.

## What the skeleton already proves

- One command → table window + panel beside it, sized to the work area
  (`TABLE_FRAC`, default 70/30).
- CDP connectivity to the table window — the same channel the live feed
  (phase 2) and Remote Play clicks use. No screen-capture APIs anywhere.
- **Live mirror**: the panel shows a CDP screenshot of the table page every
  ~2.5s — the exact frame source the OCR pipeline would consume.
- **Dump DOM sample**: extracts visible text nodes from every frame and gives a
  verdict — DOM-readable (CoinPoker-style feed, phase 2 gets cheap) vs
  canvas-rendered (OCR path, port the assistive-play vision pipeline).

## Phases

1. ✅ this skeleton
2. live hand feed: CDP frames → OCR (`winocr`) / DOM → assistive-play
   `HandTracker` → large-print panel feed
3. Study Answers: gto-trainer (`localhost:2000`) verdicts in the panel —
   practice tables only, per the assistive-play bright line

Reuses `aof-model/scout/cdp.py` (Windows-validated) for all CDP access.
Env overrides: `IGNITION_URL`, `CDP_PORT`, `PANEL_PORT`, `CHROME_EXE`,
`TABLE_FRAC`.
