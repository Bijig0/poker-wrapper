/**
 * The chain-path reason codes ONE answer carried (services/chainPath) — the in-memory twin of the SQL in
 * answerLog.countPathCodes (2026-10-09, catalogue-incremental): the codes of `path.reasons[]`, the arrival's own code
 * and its first computation's (`path.arrival.code`, `path.arrival.first.code`), each counted once per answer. Only an
 * ANSWERED row with a valid JSON path has any. Pure, no imports: the answer view's seed worker runs it too
 * (services/sqlitePagerWorker.ts), so each path is parsed once, off the API's loop.
 */
export interface PathCodeRow { text: string | null; path: string | null }

export function pathCodesOf(row: PathCodeRow): string[] {
  if (row.text == null || row.path == null || row.path === "") return [];
  let p: any;
  try { p = JSON.parse(row.path); } catch { return []; }   // json_valid(path) = 0 in the SQL
  if (p == null || typeof p !== "object") return [];
  const out = new Set<string>();
  const add = (v: unknown) => { if (v != null && typeof v !== "object") out.add(String(v)); };
  // json_each over '$.reasons' walks an array's elements or an object's values
  const reasons = p.reasons;
  if (reasons != null && typeof reasons === "object") {
    for (const r of Array.isArray(reasons) ? reasons : Object.values(reasons)) if (r != null && typeof r === "object") add((r as any).code);
  }
  const arrival = p.arrival;
  if (arrival != null && typeof arrival === "object") {
    add(arrival.code);
    if (arrival.first != null && typeof arrival.first === "object") add(arrival.first.code);
  }
  return [...out];
}
