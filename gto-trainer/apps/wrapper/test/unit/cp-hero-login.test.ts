/**
 * HERO'S NAME SURVIVES THE CLIENT'S LOG ROTATION (sites/cpFeed.ts lastLogin, 2026-10-01). CoinPoker rotates main.log
 * to main.1.log.gz when it starts, and a run that signs in with a kept session logs no "Login on SFS" line of its own —
 * so the account name is only in the rotated file. Without it the feed sees six named seats and no hero: "no hero
 * seat", the on-demand Solve never offered (session_20261001_011222).
 */
import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lastLogin } from "../../src/sites/cpFeed";

const LOGIN = (who: string) => `2026-10-01 01:09:59:000 [info]  [UNITY] Stdout: Login on SFS with ${who} Address 1.2.3.4\n`;
const NOISE = `2026-10-01 01:10:43:271 [info]  [UNITY] Stdout: {"username":"someone_else","points":0}\n`;

test("the rotated log's login is used when the current log has none; the current log's wins when it has one", () => {
  const dir = mkdtempSync(join(tmpdir(), "cp-login-"));
  const cur = join(dir, "main.log");
  writeFileSync(cur, NOISE + NOISE);
  expect(lastLogin(cur)).toBeNull();                                    // nothing rotated yet: unknown
  writeFileSync(join(dir, "main.1.log.gz"), Bun.gzipSync(Buffer.from(LOGIN("first_acct") + NOISE + LOGIN("megturism0"))));
  expect(lastLogin(cur)).toBe("megturism0");                             // the rotated file's LAST login
  writeFileSync(cur, NOISE + LOGIN("fresh_acct") + NOISE);
  expect(lastLogin(cur)).toBe("fresh_acct");                             // this run signed in itself: that name
  expect(lastLogin(join(dir, "missing.log"))).toBeNull();
});
