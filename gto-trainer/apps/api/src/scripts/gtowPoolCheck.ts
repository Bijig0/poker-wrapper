/**
 * Prove the GTO Wizard session pool ROUTES the way it claims to.
 *
 * Status pages can only say "both sessions hold a token". The thing that
 * actually matters is which ACCOUNT a solve lands on, and that is invisible
 * until a real tree is sent: a heads-up POSTFLOP tree must be minted on the
 * Elite account (so the Ultra allowance is spared), and a 3-player tree — and
 * every preflop tree, whatever the table size — must be minted on the Ultra
 * account.
 *
 * This sends one of each and prints the session that answered. It is the only
 * check that exercises the routing decision end to end, so it is worth running
 * after any change to services/gtowSessions.ts — and once by hand whenever a
 * new account is wired up.
 *
 * COSTS TWO CLOUD SOLVES (one per account). That is the point; keep it rare.
 *
 *   bun src/scripts/gtowPoolCheck.ts
 */
import { gtowApi } from "../services/gtowApi";
import { gtowSessions } from "../services/gtowSessions";
import { buildRangeArray } from "../utils/buildRangeArray/buildRangeArray";

const OOP = buildRangeArray("22+,A2s+,K5s+,Q8s+,J8s+,T8s+,97s+,87s,A8o+,KTo+,QTo+,JTo");
const IP = buildRangeArray("22+,A2s+,K2s+,Q6s+,J7s+,T7s+,96s+,86s+,75s+,A2o+,K8o+,Q9o+,J9o+,T9o");

const line = (s: string) => console.log(s);

// Warm both sessions first: an unsniffed session cannot be routed to, and the
// keeper is not running in a one-shot script.
await gtowSessions.forceRefresh();
line("sessions:");
for (const s of gtowSessions.status()) {
  line(`  ${s.id.padEnd(10)} token=${String(s.tokenLive).padEnd(5)} multiway=${String(s.multiway).padEnd(5)} ${s.text}`);
}
line("");
line(`route(postflop heads-up) -> ${gtowSessions.route({ multiway: false }).join(", ") || "(none)"}`);
line(`route(postflop multiway) -> ${gtowSessions.route({ multiway: true }).join(", ") || "(none)"}`);
line(`route(preflop heads-up)  -> ${gtowSessions.route({ preflop: true, multiway: false }).join(", ") || "(none)"}`);
line(`route(preflop multiway)  -> ${gtowSessions.route({ preflop: true, multiway: true }).join(", ") || "(none)"}`);
line("");

const base = {
  pot: 5.5,
  stack: 97.5,
  oopRange: OOP,
  ipRange: IP,
  startingStreet: "FLOP" as const,
  flopActions: "",
  turnActions: "",
  riverActions: "",
};

// Distinct boards so the two solves can never share a cached tree.
const cases = [
  { what: "heads-up (2 seats)", expect: "secondary", tree: { ...base, board: "Ts7h2d", oopPos: "BB", ipPos: "BTN" } },
  {
    what: "multiway (3 seats)",
    expect: "primary",
    tree: { ...base, board: "Kc8s3h", oopPos: "SB", ipPos: "BTN", mid: { pos: "BB", range: IP } },
  },
];

let failures = 0;
for (const c of cases) {
  const t0 = Date.now();
  // noCache: the persistent solve cache would hand back a stored tree with no account behind it (session "cache") —
  // this check exists to see which ACCOUNT a real solve lands on
  const res: any = await gtowApi.customSolve(c.tree as any, { noCache: true });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  if (!res?.ok) {
    failures++;
    line(`${c.what.padEnd(20)} FAILED after ${secs}s — ${res?.error ?? "unknown"}`);
    continue;
  }
  const got = res.session;
  const acts = (res.data?.action_solutions ?? []).length;
  const ok = got === c.expect;
  if (!ok) failures++;
  line(`${c.what.padEnd(20)} ${ok ? "OK  " : "WRONG"} solved on ${String(got).padEnd(10)} (expected ${c.expect}) · ${secs}s · ${acts} actions`);
}

line("");
line("solves minted this run, by account:");
for (const s of gtowSessions.status()) line(`  ${s.id.padEnd(10)} ${s.trees}`);
process.exit(failures ? 1 : 0);
