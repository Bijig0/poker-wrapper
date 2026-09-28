// Preloaded by bunfig.toml before ANY test file loads. `bun test` runs every file in one process and module
// singletons are built by whichever file imports them first, so an env assignment inside one test file is too
// late for the rest of the run. Point live-state stores at throwaway locations here instead.
//
// answerLog: see assertTestSafePath in services/answerLog.ts — it refuses any non-temp path under bun test.
process.env.ANSWERS_DB_PATH ??= ":memory:";
// handFacts: the chain ledger's per-hand facts (services/handFacts.ts) — same refusal of non-temp paths under bun test.
process.env.HAND_FACTS_DB_PATH ??= ":memory:";
// hhCheck: the per-hand verdicts against Ignition's hand history (services/hhCheck.ts).
process.env.HH_CHECKS_DB_PATH ??= ":memory:";
// hrc6max: which PATCH charts are solved is whatever this machine has baked — tests must not depend on it. Tests that
// exercise the patch overlay supply their own list via setPatchSource.
process.env.HRC6MAX_PATCHES ??= "off";
