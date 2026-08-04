/** One 13×13 hand class as scraped from GTO Wizard's strategy grid. */
export interface HandCell {
  hand: string;
  /** Action label → frequency in % of this hand's strategy (0–100). */
  actions: Record<string, number>;
  /** False when the hand isn't in the range at this node (folded earlier). */
  inRange: boolean;
}

export interface CompareRow {
  hand: string;
  a: number; // frequency of action A for this hand (%)
  b: number; // frequency of action B for this hand (%)
  diff: number; // a - b (percentage points)
}

export interface RangeComparison {
  /** Hands that use at least one of the two actions, in scrape order. */
  rows: CompareRow[];
  /** rows sorted by diff descending (leaning hardest toward A first). */
  skewToA: CompareRow[];
  /** rows sorted by diff ascending (leaning hardest toward B first). */
  skewToB: CompareRow[];
  onlyA: number; // hands using A but never B
  onlyB: number; // hands using B but never A
  both: number; // hands mixing the two sizes
}

/** Per-hand comparison of two actions' frequencies at a node. */
export const compareActionRanges = (
  cells: HandCell[],
  labelA: string,
  labelB: string
): RangeComparison => {
  const rows: CompareRow[] = [];
  for (const cell of cells) {
    const a = cell.actions[labelA] ?? 0;
    const b = cell.actions[labelB] ?? 0;
    if (a > 0 || b > 0) {
      rows.push({ hand: cell.hand, a, b, diff: Math.round((a - b) * 10) / 10 });
    }
  }
  const skewToA = [...rows].sort((x, y) => y.diff - x.diff || y.a - x.a);
  const skewToB = [...rows].sort((x, y) => x.diff - y.diff || y.b - x.b);
  return {
    rows,
    skewToA,
    skewToB,
    onlyA: rows.filter((r) => r.a > 0 && r.b === 0).length,
    onlyB: rows.filter((r) => r.b > 0 && r.a === 0).length,
    both: rows.filter((r) => r.a > 0 && r.b > 0).length,
  };
};
