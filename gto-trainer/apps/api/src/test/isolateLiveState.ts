// Preloaded by bunfig.toml before ANY test file loads. `bun test` runs every file in one process and module
// singletons are built by whichever file imports them first, so an env assignment inside one test file is too
// late for the rest of the run. Point live-state stores at throwaway locations here instead.
//
// answerLog: see assertTestSafePath in services/answerLog.ts — it refuses any non-temp path under bun test.
process.env.ANSWERS_DB_PATH ??= ":memory:";
// handFacts: the chain ledger's per-hand facts (services/handFacts.ts) — same refusal of non-temp paths under bun test.
process.env.HAND_FACTS_DB_PATH ??= ":memory:";
