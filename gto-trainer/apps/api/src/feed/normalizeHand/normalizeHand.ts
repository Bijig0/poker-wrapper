/**
 * normalizeHand
 * -------------
 * Coerce a user-supplied (or /state-fetched) Hand-shaped JSON object into a
 * ParsedHand. Accepts the full assistive-play Hand as-is, and forgives the
 * boilerplate a human typing one by hand would omit: bookkeeping fields get
 * defaults, cards are normalized ("A♠" / "as" / "ace of spades" → "As"), and
 * the street is derived from the board when missing. Throws with a precise
 * message on anything that can't be understood.
 */

import {
  toShortCard,
  type ActionType,
  type ParsedAction,
  type ParsedHand,
  type Street,
} from "../parsePanelFeed/parsePanelFeed";

const STREETS: readonly Street[] = ["preflop", "flop", "turn", "river", "showdown"];
const ACTION_TYPES: readonly ActionType[] = [
  "post-sb", "post-bb", "fold", "check", "call", "bet", "raise", "all-in",
];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const streetFromBoard = (n: number): Street =>
  n >= 5 ? "river" : n === 4 ? "turn" : n === 3 ? "flop" : "preflop";

const cardList = (v: unknown, field: string): string[] => {
  if (v == null) return [];
  if (!Array.isArray(v) || v.some((c) => typeof c !== "string")) {
    throw new Error(`${field} must be an array of card strings.`);
  }
  return (v as string[]).map(toShortCard);
};

const asStreet = (v: unknown, field: string, fallback: Street): Street => {
  if (v == null) return fallback;
  if (typeof v !== "string" || !STREETS.includes(v as Street)) {
    throw new Error(`${field} must be one of ${STREETS.join("/")} (got ${JSON.stringify(v)}).`);
  }
  return v as Street;
};

export interface NormalizeResult {
  hand: ParsedHand;
  warnings: string[];
}

export const normalizeHand = (input: unknown): NormalizeResult => {
  if (!isRecord(input)) throw new Error("Hand must be a JSON object.");
  const warnings: string[] = [];

  const heroSeatId = input.heroSeatId == null ? -1 : Number(input.heroSeatId);
  if (!Number.isInteger(heroSeatId)) throw new Error("heroSeatId must be an integer seat id.");
  if (input.heroSeatId == null) warnings.push("heroSeatId missing — defaulted to -1 (hero rows render as \"You\").");

  const board = cardList(input.board, "board");
  const heroCards = cardList(input.heroCards, "heroCards");
  const street = asStreet(input.street, "street", streetFromBoard(board.length));

  if (input.actions != null && !Array.isArray(input.actions)) {
    throw new Error("actions must be an array.");
  }
  const actions: ParsedAction[] = ((input.actions as unknown[]) ?? []).map((raw, i) => {
    if (!isRecord(raw)) throw new Error(`actions[${i}] must be an object.`);
    const type = raw.type;
    if (typeof type !== "string" || !ACTION_TYPES.includes(type as ActionType)) {
      throw new Error(
        `actions[${i}].type must be one of ${ACTION_TYPES.join("/")} (got ${JSON.stringify(type)}).`
      );
    }
    const hero = raw.hero === true;
    const seatId = raw.seatId == null ? (hero ? heroSeatId : NaN) : Number(raw.seatId);
    if (!Number.isInteger(seatId)) {
      throw new Error(`actions[${i}].seatId is required for villain actions.`);
    }
    const amount = raw.amount == null ? undefined : Number(raw.amount);
    if (amount !== undefined && !Number.isFinite(amount)) {
      throw new Error(`actions[${i}].amount must be a number.`);
    }
    return {
      seatId,
      hero,
      type: type as ActionType,
      ...(amount !== undefined ? { amount } : {}),
      street: asStreet(raw.street, `actions[${i}].street`, "preflop"),
    };
  });

  const positions: Record<number, string> = {};
  if (input.positions != null) {
    if (!isRecord(input.positions)) throw new Error("positions must be an object of seatId → position.");
    for (const [k, v] of Object.entries(input.positions)) {
      const id = Number(k);
      if (!Number.isInteger(id) || typeof v !== "string") {
        throw new Error(`positions has an invalid entry: ${k} → ${JSON.stringify(v)}.`);
      }
      positions[id] = v;
    }
  }

  const potByStreet: Partial<Record<Street, number>> = {};
  if (input.potByStreet != null) {
    if (!isRecord(input.potByStreet)) throw new Error("potByStreet must be an object of street → BB.");
    for (const [k, v] of Object.entries(input.potByStreet)) {
      if (!STREETS.includes(k as Street) || !Number.isFinite(Number(v))) {
        throw new Error(`potByStreet has an invalid entry: ${k} → ${JSON.stringify(v)}.`);
      }
      potByStreet[k as Street] = Number(v);
    }
  }

  let stacks: Record<number, number> | undefined;
  if (input.stacks != null) {
    if (!isRecord(input.stacks)) throw new Error("stacks must be an object of seatId → BB.");
    stacks = {};
    for (const [k, v] of Object.entries(input.stacks)) {
      const id = Number(k);
      if (!Number.isInteger(id) || !Number.isFinite(Number(v))) {
        throw new Error(`stacks has an invalid entry: ${k} → ${JSON.stringify(v)}.`);
      }
      stacks[id] = Number(v);
    }
  }

  let result: { text: string } | undefined;
  if (input.result != null) {
    if (!isRecord(input.result) || typeof input.result.text !== "string") {
      throw new Error("result must be { text: string }.");
    }
    result = { text: input.result.text };
  }

  const rawNode = input.currentNode;
  if (rawNode != null && !isRecord(rawNode)) throw new Error("currentNode must be an object.");
  const nodeStreet = asStreet(rawNode?.street, "currentNode.street", street);
  const ended =
    typeof input.ended === "boolean"
      ? input.ended
      : rawNode?.complete === true || (rawNode == null && result != null);
  if (typeof input.ended !== "boolean") {
    warnings.push(`ended missing — inferred ${ended} from ${rawNode ? "currentNode.complete" : "the result field"}.`);
  }

  const hand: ParsedHand = {
    handId: Number(input.handId ?? 0) || 0,
    ...(typeof input.clientHandId === "string" && input.clientHandId
      ? { clientHandId: input.clientHandId }
      : {}),
    heroSeatId,
    heroCards,
    board,
    street,
    actions,
    liveSeats: Array.isArray(input.liveSeats) ? (input.liveSeats as number[]) : [],
    committed: isRecord(input.committed) ? (input.committed as Record<number, number>) : {},
    potByStreet,
    positions,
    ...(stacks ? { stacks } : {}),
    ...(result ? { result } : {}),
    currentNode: {
      street: nodeStreet,
      toActSeatId: rawNode?.toActSeatId == null ? null : Number(rawNode.toActSeatId),
      toActIsHero: rawNode?.toActIsHero === true,
      pot: Number(rawNode?.pot ?? potByStreet[nodeStreet] ?? 0) || 0,
      toCall: Number(rawNode?.toCall ?? 0) || 0,
      legalActions: Array.isArray(rawNode?.legalActions) ? (rawNode.legalActions as string[]) : [],
      complete: rawNode?.complete === true || ended,
    },
    ended,
  };
  return { hand, warnings };
};
