/**
 * CPython's `random.Random(int)`, bit for bit: MT19937 seeded by init_by_array, and the methods the hand fuzzer
 * draws with — random(), getrandbits(k <= 32), choice(), randrange(n), sample() (the small-population path).
 *
 * Why exact: the fuzzer was written in Python, and matching its generator seed for seed is what proves the port —
 * the same seed must deal the same hand, render the same ticks and get the same verdict.
 */
const N = 624, M = 397, MATRIX_A = 0x9908b0df, UPPER = 0x80000000, LOWER = 0x7fffffff;

export class PyRandom {
  private mt = new Uint32Array(N);
  private mti = N + 1;

  constructor(seed: number) {
    // random_seed(int): the absolute value as little-endian 32-bit words; 0 is the one-word key [0]
    let n = Math.abs(Math.trunc(seed));
    const key: number[] = [];
    if (n === 0) key.push(0);
    while (n > 0) {
      key.push(n % 0x100000000);
      n = Math.floor(n / 0x100000000);
    }
    this.initByArray(key);
  }

  private initGenrand(s: number): void {
    const mt = this.mt;
    mt[0] = s >>> 0;
    for (let i = 1; i < N; i++) mt[i] = (Math.imul(1812433253, mt[i - 1]! ^ (mt[i - 1]! >>> 30)) + i) >>> 0;
    this.mti = N;
  }

  private initByArray(key: number[]): void {
    const mt = this.mt;
    this.initGenrand(19650218);
    let i = 1, j = 0;
    for (let k = Math.max(N, key.length); k; k--) {
      mt[i] = ((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1664525)) >>> 0) + key[j]! + j >>> 0;
      i++;
      j++;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
      if (j >= key.length) j = 0;
    }
    for (let k = N - 1; k; k--) {
      mt[i] = (((mt[i]! ^ Math.imul(mt[i - 1]! ^ (mt[i - 1]! >>> 30), 1566083941)) >>> 0) - i) >>> 0;
      i++;
      if (i >= N) { mt[0] = mt[N - 1]!; i = 1; }
    }
    mt[0] = 0x80000000;
  }

  private genrand(): number {
    const mt = this.mt;
    let y: number;
    if (this.mti >= N) {
      let kk = 0;
      for (; kk < N - M; kk++) {
        y = (mt[kk]! & UPPER) | (mt[kk + 1]! & LOWER);
        mt[kk] = mt[kk + M]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      for (; kk < N - 1; kk++) {
        y = (mt[kk]! & UPPER) | (mt[kk + 1]! & LOWER);
        mt[kk] = mt[kk + (M - N)]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      }
      y = (mt[N - 1]! & UPPER) | (mt[0]! & LOWER);
      mt[N - 1] = mt[M - 1]! ^ (y >>> 1) ^ (y & 1 ? MATRIX_A : 0);
      this.mti = 0;
    }
    y = mt[this.mti++]!;
    y ^= y >>> 11;
    y ^= (y << 7) & 0x9d2c5680;
    y ^= (y << 15) & 0xefc60000;
    y ^= y >>> 18;
    return y >>> 0;
  }

  /** [0, 1) with 53 random bits, as random_random() builds it. */
  random(): number {
    const a = this.genrand() >>> 5, b = this.genrand() >>> 6;
    return (a * 67108864.0 + b) * (1.0 / 9007199254740992.0);
  }

  getrandbits(k: number): number {
    if (k <= 0) return 0;
    if (k > 32) throw new Error("getrandbits > 32 is not needed here");
    return this.genrand() >>> (32 - k);
  }

  /** _randbelow_with_getrandbits: [0, n). */
  randbelow(n: number): number {
    if (!n) return 0;
    const k = Math.floor(Math.log2(n)) + 1;   // n.bit_length()
    let r = this.getrandbits(k);
    while (r >= n) r = this.getrandbits(k);
    return r;
  }

  choice<T>(seq: readonly T[]): T {
    if (!seq.length) throw new Error("Cannot choose from an empty sequence");
    return seq[this.randbelow(seq.length)]!;
  }

  randrange(stop: number): number {
    if (stop <= 0) throw new Error("empty range for randrange()");
    return this.randbelow(stop);
  }

  /** sample() for a population no larger than CPython's small-set threshold (the pool method). */
  sample<T>(population: readonly T[], k: number): T[] {
    const n = population.length;
    if (k < 0 || k > n) throw new Error("Sample larger than population or is negative");
    let setsize = 21;
    if (k > 5) setsize += 4 ** Math.ceil(Math.log(k * 3) / Math.log(4));
    if (n > setsize) throw new Error("sample(): only the small-population path is implemented");
    const pool = [...population];
    const result: T[] = new Array(k);
    for (let i = 0; i < k; i++) {
      const j = this.randbelow(n - i);
      result[i] = pool[j]!;
      pool[j] = pool[n - i - 1]!;
    }
    return result;
  }
}
