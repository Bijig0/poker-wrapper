/**
 * Ignition's record of a hand (the JSON GET /hh/:id returns, saved under <data>/wrapper/hand_history/<id>.json) →
 * the TEXT hand history Ignition's own download gives, which GTO Wizard's analyzer reads as site "Ignition"
 * (services/gtowAnalyzer.ts uploads it).
 *
 * The record already holds the lines the text file prints — position, action label, data — so this mostly prints
 * them back: "<position> : <label> <amount> ". Amounts as in the record (see ignitionHh.ts): Raises and All-in(raise)
 * carry the street total raised TO, and the text prints "<chips added> to <total>". Seat admin lines (deposits, sit
 * out, enter/leave) are left out, and so are hole cards the record does not know (the file never shows "[]").
 *
 * Checked against GTO Wizard on 2026-10-04: hand 4922381703 parsed with no error and every action read right.
 */

interface RecordAction { position: string; action: string; data?: string[]; time?: string; showdown?: { hi?: string[]; description?: string } | null }
interface RecordPlayer { position: string; seat: string; startEndAmount: string }
export interface IgnitionRecordBody {
  startTime: string;
  tableName: string;
  potSize: string;
  communityCards: string[];
  players: RecordPlayer[];
  action: RecordAction[];
}

const money = (s: string | undefined) => Number(String(s ?? "").replace(/[$,]/g, "")) || 0;
const dollars = (n: number) => {
  const r = Math.round(n * 100) / 100;
  return "$" + (Number.isInteger(r) ? String(r) : r.toFixed(2));
};
const cardList = (a: (string | undefined)[] | undefined) => (a ?? []).filter(Boolean).join(" ");

/** Lines with no part in the play: GTO Wizard has nothing to read in them, and some carry no position. */
const ADMIN = new Set(["Table deposit", "Table enter user", "Table leave user", "Seat sit down", "Seat stand", "Seat sit out", "Seat sit in", "Seat re-join"]);

/** The header's "2026-10-03 17:04:28": the record's clock (Ignition's local time) on the right day — startTime is
 *  UTC, so its date is shifted by the clock's offset (to the nearest half hour) before the clock is put on it. */
export function headerTime(startTimeUtc: string, clock: string | undefined): string {
  const utc = new Date(startTimeUtc);
  if (!clock || !/^\d{1,2}:\d{2}:\d{2}$/.test(clock)) return utc.toISOString().slice(0, 19).replace("T", " ");
  const [h, m, s] = clock.split(":").map(Number);
  let off = h * 60 + m - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
  if (off > 12 * 60) off -= 24 * 60;
  if (off < -12 * 60) off += 24 * 60;
  const local = new Date(utc.getTime() + Math.round(off / 30) * 30 * 60_000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${local.toISOString().slice(0, 10)} ${two(h)}:${two(m)}:${two(s)}`;
}

export function ignitionRecordToText(handId: string, format: "cash" | "zone", b: IgnitionRecordBody): string {
  const out: string[] = [];
  const when = headerTime(b.startTime, b.action.find((a) => a.time)?.time);
  const table = (b.tableName ?? "").split(" ")[0].replace(/^TBL#/, "");
  out.push(format === "zone"
    ? `Ignition Hand #${handId} Zone Poker ID#${table} HOLDEMZonePoker No Limit - ${when}`
    : `Ignition Hand #${handId} TBL#${table} HOLDEM No Limit - ${when}`);
  for (const p of [...b.players].sort((x, y) => Number(x.seat) - Number(y.seat)))
    out.push(`Seat ${p.seat}: ${p.position} (${p.startEndAmount.split("/")[0]} in chips)`);

  const hole = new Map<string, string>();      // action-line position → "Ad 8c"
  let inStreet: Record<string, number> = {};   // chips each position has put in on this street
  let holeHeader = false;
  for (const a of b.action) {
    if (ADMIN.has(a.action)) continue;
    const who = a.position;
    const d = a.data ?? [];
    const amt = money(d[0]);
    switch (a.action) {
      case "FLOP": case "TURN": case "RIVER": {
        inStreet = {};
        const board = d.filter(Boolean);
        out.push(a.action === "FLOP"
          ? `*** FLOP *** [${board.join(" ")}]`
          : `*** ${a.action} *** [${board.slice(0, -1).join(" ")}] [${board.at(-1) ?? ""}]`);
        break;
      }
      case "Card dealt to a spot": {
        if (!holeHeader) { out.push("*** HOLE CARDS ***"); holeHeader = true; }
        const c = cardList(d);
        if (c) { hole.set(who, c); out.push(`${who} : Card dealt to a spot [${c}] `); }
        break;
      }
      case "Set dealer":   // a dead button (no one on it) has no position and no seat: no line, the blinds place everyone
        if (who && d[0]) out.push(`${who} : Set dealer [${d[0]}] `);
        break;
      case "Small Blind": case "Big blind": case "Posts chip": case "Calls": case "Bets": case "All-in":
        inStreet[who] = (inStreet[who] ?? 0) + amt;
        out.push(`${who} : ${a.action} ${dollars(amt)} `);
        break;
      case "Posts dead chip": out.push(`${who} : ${a.action} ${dollars(amt)} `); break;   // dead: not toward a call
      case "Raises": case "All-in(raise)":
        out.push(`${who} : ${a.action} ${dollars(amt - (inStreet[who] ?? 0))} to ${dollars(amt)}`);
        inStreet[who] = amt;
        break;
      case "Return uncalled portion of bet":
        inStreet[who] = (inStreet[who] ?? 0) - amt;
        out.push(`${who} : ${a.action} ${dollars(amt)} `);
        break;
      case "Showdown": case "Mucks": case "Does not show": case "Folds & shows": {
        const best = a.action === "Showdown" ? cardList(a.showdown?.hi) : "";
        const shown = best || cardList(d.slice(0, 2)) || hole.get(who) || "";
        const desc = a.showdown?.description ? ` (${a.showdown.description})` : "";
        out.push(shown ? `${who} : ${a.action} [${shown}]${desc}` : `${who} : ${a.action} `);
        break;
      }
      case "Hand result": case "Hand result-Side pot": out.push(`${who} : ${a.action} ${dollars(amt)} `); break;
      default: {
        const rest = d.filter(Boolean).join(" ");
        out.push(`${who} : ${a.action}${rest ? " " + rest : ""} `);   // Folds, Checks, "(timeout)" variants
      }
    }
  }
  out.push("*** SUMMARY ***", `Total Pot(${b.potSize})`);
  if (cardList(b.communityCards)) out.push(`Board [${cardList(b.communityCards)}]`);   // none when it ended preflop
  return out.join("\n") + "\n";
}
