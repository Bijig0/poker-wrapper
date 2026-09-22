/** Who is each pooled session actually signed in as? Prints identity claims
 *  only — never the token. Throwaway diagnostic. */
import { gtowSessions } from "../services/gtowSessions";

await gtowSessions.forceRefresh();
const seen = new Map<string, string[]>();
for (const id of ["secondary", "primary"] as const) {
  const tok = await gtowSessions.tokenFor(id);
  if (!tok) { console.log(`${id.padEnd(10)} NO TOKEN`); continue; }
  let p: any = {};
  try { p = JSON.parse(Buffer.from(tok.split(".")[1]!, "base64").toString()); } catch {}
  const who = String(p.user_id ?? p.sub ?? p.uid ?? p.public_id ?? "?");
  const claims = Object.keys(p).join(",");
  console.log(`${id.padEnd(10)} account=${who.padEnd(12)} exp=${new Date((p.exp ?? 0) * 1000).toISOString()} claims=[${claims}]`);
  seen.set(who, [...(seen.get(who) ?? []), id]);
}
console.log("");
for (const [who, ids] of seen) {
  if (ids.length > 1) console.log(`!! SAME ACCOUNT on ${ids.join(" and ")} (${who}) — quota is NOT being split`);
}
if ([...seen.keys()].length === 2) console.log("distinct accounts confirmed — the two quotas are separate");
