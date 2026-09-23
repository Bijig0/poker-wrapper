/**
 * The Python unit tests' `check(label, ok, detail)` style, kept for the ports: every check runs, the failures are
 * collected with their labels, and the test asserts the list is empty — so a failure reads as the same sentence the
 * Python test printed.
 */
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function checker() {
  const fails: string[] = [];
  const check = (label: string, ok: unknown, detail = "") => {
    if (!ok) fails.push(`${label}${detail ? "  — " + detail : ""}`);
  };
  return { fails, check };
}

/** A scratch data/ + debug/ for the wrapper (never the real ignition-study-wrapper/data). */
export function scratchDirs(prefix = "wrapper-unit-"): string {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(tmp, "data"), { recursive: true });
  process.env.WRAPPER_DATA_DIR = join(tmp, "data");
  process.env.WRAPPER_DEBUG_DIR = join(tmp, "debug");
  return tmp;
}

export const J = (x: unknown) => JSON.stringify(x, (_k, v) => (v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v));
