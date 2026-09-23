/**
 * THE CLOCK, injectable. Everything in the wrapper that reads the time reads it here, so a replay (the golden
 * tests) can drive it from a recording's own timestamps — Python's recorder swaps each module's `time` for a
 * FakeTime the same way (tests/golden/common.py). In a replay:
 *   time()     = the recording's clock
 *   sleep(s)   = returns at once, the clock moves on by s
 *   strftime() = UTC (a replay must not depend on the machine's zone), exactly as FakeTime formats it
 */

let fake: number | null = null;
export let slept = 0;

/** time.time(): seconds since the epoch, as a float. */
export function time(): number {
  return fake !== null ? fake : Date.now() / 1000;
}

/** Milliseconds, int(time.time() * 1000). */
export function nowMs(): number {
  return Math.trunc(time() * 1000);
}

export function isReplay(): boolean {
  return fake !== null;
}

/** Enter replay mode at `t` (seconds). */
export function setFakeTime(t: number): void {
  fake = t;
}

/** Leave replay mode. */
export function realTime(): void {
  fake = null;
}

/** time.sleep(s) — awaitable; instantaneous in a replay. */
export async function sleep(s: number): Promise<void> {
  if (fake !== null) {
    slept += Math.max(0, s);
    fake += Math.max(0, s);
    return;
  }
  if (s > 0) await new Promise((r) => setTimeout(r, s * 1000));
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

type Parts = { Y: number; m: number; d: number; H: number; M: number; S: number };

function parts(t: number, utc: boolean): Parts {
  const dt = new Date(Math.floor(t) * 1000);
  return utc
    ? { Y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate(), H: dt.getUTCHours(), M: dt.getUTCMinutes(), S: dt.getUTCSeconds() }
    : { Y: dt.getFullYear(), m: dt.getMonth() + 1, d: dt.getDate(), H: dt.getHours(), M: dt.getMinutes(), S: dt.getSeconds() };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** time.strftime(fmt[, localtime(t)]) for the directives the wrapper uses: %Y %m %d %H %M %S %b %%. */
export function strftime(fmt: string, t?: number): string {
  const p = parts(t ?? time(), fake !== null);
  return fmt.replace(/%([YmdHMSb%])/g, (_, c: string) => {
    switch (c) {
      case "Y": return String(p.Y);
      case "m": return pad(p.m);
      case "d": return pad(p.d);
      case "H": return pad(p.H);
      case "M": return pad(p.M);
      case "S": return pad(p.S);
      case "b": return MONTHS[p.m - 1]!;
      default: return "%";
    }
  });
}

/** time.mktime(time.strptime(s[:19], "%Y-%m-%d %H:%M:%S")): local wall time -> epoch seconds (UTC in a replay).
 *  Returns null where Python raises ValueError / OverflowError. */
export function mktimeYmdHms(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) return null;
  const [Y, mo, d, H, M, S] = m.slice(1).map(Number) as [number, number, number, number, number, number];
  if (mo < 1 || mo > 12 || d < 1 || H > 23 || M > 59 || S > 61) return null;
  const dim = new Date(Date.UTC(Y, mo, 0)).getUTCDate();
  if (d > dim) return null;
  if (fake !== null) return Date.UTC(Y, mo - 1, d, H, M, S) / 1000;
  return new Date(Y, mo - 1, d, H, M, S).getTime() / 1000;
}
