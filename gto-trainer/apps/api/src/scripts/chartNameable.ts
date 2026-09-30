/**
 * CAN THE PICKER NAME THESE CHARTS? Run by the landing script (poker-zenbook/hrc-api/scripts/pullChart.sh) after it bakes
 * a 6-max chart, so a solved tree the picker would never look up is said in pull.log the minute it lands — instead of
 * sitting in the catalog unread (the 20bb single-short set, 2026-09-26..30).
 *   bun src/scripts/chartNameable.ts <id> [<id> ...]
 * Prints one line per id; exits 2 when any id is not nameable, 0 when all are. Pure: no DB, no network.
 */
import { unnameable6max } from "../services/hrc6max";

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: bun src/scripts/chartNameable.ts <chartId> [...]");
  process.exit(1);
}
let bad = 0;
for (const id of ids) {
  const why = unnameable6max(id);
  if (why) { bad += 1; console.log(`${id}: NOT NAMEABLE by the picker — ${why}`); }
  else console.log(`${id}: nameable`);
}
process.exit(bad ? 2 : 0);
