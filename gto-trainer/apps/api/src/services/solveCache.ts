/**
 * Content-addressed cache for solver results.
 *
 * The cache key is derived from everything that defines the SOLVE (street,
 * board, ranges, pot, stack, bet config, hero seat) — but NOT hero's specific
 * hole cards, since the solve is range-vs-range. One solve serves every hero
 * holding in the same spot, which maximizes hit rate.
 *
 * The flop's three cards are order-normalized in the key (their order doesn't
 * change the solve). Suit-isomorphism canonicalization is a future improvement
 * that would raise the hit rate further.
 */

export interface CacheKeyParts {
  street: string;
  board: string; // space/comma-free, e.g. "QsJh2h8c3d"
  oopRange: string;
  ipRange: string;
  pot: number;
  stack: number;
  betSizes: string;
  raiseSizes: string;
  heroSeat: "oop" | "ip";
}

function normalizeBoard(board: string): string {
  const cards = board.match(/.{2}/g) ?? [];
  const flop = cards.slice(0, 3).sort().join(""); // order-independent
  const rest = cards.slice(3).join("");
  return flop + rest;
}

export function cacheKey(p: CacheKeyParts): string {
  return [
    p.street,
    normalizeBoard(p.board),
    p.oopRange,
    p.ipRange,
    p.pot,
    p.stack,
    p.betSizes,
    p.raiseSizes,
    p.heroSeat,
  ].join("|");
}

export class SolveCache<T> {
  private map = new Map<string, T>();
  private hits = 0;
  private misses = 0;

  constructor(private maxEntries = 500) {}

  get(key: string): T | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      // refresh recency (LRU): re-insert at the end
      this.map.delete(key);
      this.map.set(key, v);
    } else {
      this.misses++;
    }
    return v;
  }

  set(key: string, value: T): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    // evict least-recently-used
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  stats() {
    const total = this.hits + this.misses;
    return {
      size: this.map.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? this.hits / total : 0,
    };
  }
}
