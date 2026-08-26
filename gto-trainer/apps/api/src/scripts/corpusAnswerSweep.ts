/**
 * THE exhaustive study-answer audit: every decision node in the real HH
 * corpus, fed through the production fastSolve path untouched.
 *
 * Input rows (corpus_nodes.jsonl, from export_corpus_nodes.py) each carry a
 * complete ParsedHand exactly as the live feed parser would have produced it —
 * so what is tested is the real pipeline: line translation, chart selection,
 * range reconstruction, GTOW solve. A node the sweep marks failed is a node
 * the study tool would answer with silence at the table.
 *
 * Resumable: keys already present in the output file are skipped, so the
 * postflop grind can be stopped and relaunched freely.
 *
 * Run:  bun run src/scripts/corpusAnswerSweep.ts [maxRows]
 */
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import { fastSolve } from "../services/fastSolve";
import type { ParsedHand } from "../feed/parsePanelFeed/parsePanelFeed";

const IN = "C:/Users/Brady/poker/analysis/pipeline/limp_study/corpus_nodes.jsonl";
const OUT = "C:/Users/Brady/poker/analysis/pipeline/limp_study/corpus_answers.jsonl";
const MAX = Number(process.argv[2] ?? 0);

const done = new Set<string>();
if (existsSync(OUT)) {
  for (const ln of readFileSync(OUT, "utf-8").split("\n")) {
    if (!ln.trim()) continue;
    try { done.add(JSON.parse(ln).key); } catch { /* partial line */ }
  }
}
console.log(`${done.size} nodes already answered; resuming`);

const rl = createInterface({ input: createReadStream(IN), crlfDelay: Infinity });
const rows: any[] = [];
for await (const ln of rl) {
  if (!ln.trim()) continue;
  const r = JSON.parse(ln);
  if (!done.has(r.key)) rows.push(r);
}
console.log(`${rows.length} nodes to answer`);

let n = 0, ok = 0, bad = 0;
const t0 = Date.now();
for (const r of rows) {
  if (MAX && n >= MAX) break;
  n++;
  const hand = r.hand as ParsedHand;
  let out: any = { key: r.key, street: r.street, pos: r.pos, chart: r.chart,
                   n_live: r.n_live, holder: r.is_account_holder };
  try {
    const sol: any = await fastSolve(hand, r.pos);
    out.ok = sol.ok === true && !!(sol.decision || sol.actions?.length);
    out.source = sol.source ?? null;
    out.decision = sol.decision?.action ?? null;
    if (!out.ok) out.reason = String(sol.reason ?? "no decision").slice(0, 160);
    if (sol.warning) out.warning = String(sol.warning).slice(0, 120);
  } catch (e) {
    out.ok = false;
    out.reason = `throw: ${String((e as Error).message).slice(0, 140)}`;
  }
  out.ok ? ok++ : bad++;
  appendFileSync(OUT, JSON.stringify(out) + "\n");
  if (n % 100 === 0) {
    const rate = n / ((Date.now() - t0) / 60000);
    console.log(`${n}/${rows.length}  ok=${ok} bad=${bad}  (${rate.toFixed(0)}/min)`);
  }
}
console.log(`DONE this pass: ${n} nodes, ${ok} ok, ${bad} failed ` +
            `(cumulative file now ${done.size + n} rows)`);
