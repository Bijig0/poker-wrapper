/**
 * Python's difflib.SequenceMatcher(a=, b=, autojunk=False).get_opcodes(), with no junk function — the one
 * piece of difflib the reconciler's diff uses. Ported line for line from CPython's Lib/difflib.py, because
 * the opcodes (which run of actions counts as "changed" vs "inserted") are part of the shadow record's shape.
 * Elements are compared by `key(e)` (default: JSON), the way Python compares tuples by value.
 */
export type Opcode = ["equal" | "replace" | "delete" | "insert", number, number, number, number];

export class SequenceMatcher<T> {
  private a: T[];
  private b: T[];
  private ka: string[];
  private kb: string[];
  private b2j = new Map<string, number[]>();
  private matchingBlocks: [number, number, number][] | null = null;
  private opcodes: Opcode[] | null = null;

  constructor(a: T[], b: T[], key: (x: T) => string = (x) => JSON.stringify(x)) {
    this.a = a;
    this.b = b;
    this.ka = a.map(key);
    this.kb = b.map(key);
    this.kb.forEach((k, i) => {
      const l = this.b2j.get(k);
      if (l) l.push(i);
      else this.b2j.set(k, [i]);
    });
  }

  findLongestMatch(alo: number, ahi: number, blo: number, bhi: number): [number, number, number] {
    const { ka, kb, b2j } = this;
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(ka[i]!) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // no junk: the isbjunk extensions are no-ops, the popular-element ones too (autojunk=False)
    while (besti > alo && bestj > blo && ka[besti - 1] === kb[bestj - 1]) {
      besti--; bestj--; bestsize++;
    }
    while (besti + bestsize < ahi && bestj + bestsize < bhi && ka[besti + bestsize] === kb[bestj + bestsize]) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): [number, number, number][] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length, lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: [number, number, number][] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((p, q) => p[0] - q[0] || p[1] - q[1] || p[2] - q[2]);
    let i1 = 0, j1 = 0, k1 = 0;
    const nonAdjacent: [number, number, number][] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2; j1 = j2; k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;
    let i = 0, j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: Opcode[0] | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    this.opcodes = answer;
    return answer;
  }
}
