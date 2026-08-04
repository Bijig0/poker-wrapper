/**
 * Expands shorthand poker range notation to explicit hand combinations
 * Converts "22+,A2s+,KQo" to "22,33,44,55,66,77,88,99,TT,JJ,QQ,KK,AA,A2s,A3s,...,KQo"
 */

const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
const RANK_VALUES: Record<string, number> = {
  '2': 0, '3': 1, '4': 2, '5': 3, '6': 4, '7': 5, '8': 6, '9': 7,
  'T': 8, 'J': 9, 'Q': 10, 'K': 11, 'A': 12
};

/**
 * Expand a single hand range component like "22+", "A2s+", "KQo", etc.
 */
function expandSingleRange(range: string): string[] {
  const hands: string[] = [];

  // Pocket pairs (e.g., "22+", "TT+", "AA")
  if (/^([2-9TJQKA])\1\+?$/.test(range)) {
    const rank = range[0];
    const plus = range.endsWith('+');
    const startIdx = RANK_VALUES[rank];

    if (plus) {
      // e.g., "22+" = 22,33,44,55,66,77,88,99,TT,JJ,QQ,KK,AA
      for (let i = startIdx; i < RANKS.length; i++) {
        hands.push(RANKS[i] + RANKS[i]);
      }
    } else {
      // Just the single pair
      hands.push(rank + rank);
    }
    return hands;
  }

  // Suited hands (e.g., "AKs", "A2s+", "KTs+")
  if (/^([2-9TJQKA])([2-9TJQKA])s\+?$/.test(range)) {
    const high = range[0];
    const low = range[1];
    const plus = range.endsWith('+');
    const highIdx = RANK_VALUES[high];
    const lowIdx = RANK_VALUES[low];

    if (plus) {
      // e.g., "A2s+" = A2s,A3s,A4s,...,AKs
      for (let i = lowIdx; i < highIdx; i++) {
        hands.push(high + RANKS[i] + 's');
      }
    } else {
      // Just the single suited hand
      hands.push(high + low + 's');
    }
    return hands;
  }

  // Offsuit hands (e.g., "AKo", "A2o+", "KTo+")
  if (/^([2-9TJQKA])([2-9TJQKA])o\+?$/.test(range)) {
    const high = range[0];
    const low = range[1];
    const plus = range.endsWith('+');
    const highIdx = RANK_VALUES[high];
    const lowIdx = RANK_VALUES[low];

    if (plus) {
      // e.g., "A2o+" = A2o,A3o,A4o,...,AKo
      for (let i = lowIdx; i < highIdx; i++) {
        hands.push(high + RANKS[i] + 'o');
      }
    } else {
      // Just the single offsuit hand
      hands.push(high + low + 'o');
    }
    return hands;
  }

  // Plain two-card notation without suit (assume both suited and offsuit)
  // e.g., "AK" = "AKs,AKo"
  if (/^([2-9TJQKA])([2-9TJQKA])$/.test(range)) {
    const high = range[0];
    const low = range[1];

    if (high === low) {
      // Pocket pair
      hands.push(high + low);
    } else {
      // Both suited and offsuit
      hands.push(high + low + 's');
      hands.push(high + low + 'o');
    }
    return hands;
  }

  // If we can't parse it, return it as-is
  return [range];
}

/**
 * Expand a full poker range string
 * @param rangeString - Range in shorthand notation like "22+,A2s+,KQo,JTs"
 * @returns Expanded range like "22,33,44,55,...,A2s,A3s,...,KQo,JTs"
 */
export function expandRange(rangeString: string): string {
  if (!rangeString || rangeString.trim() === '') {
    return '';
  }

  const components = rangeString.split(',').map(s => s.trim());
  const handSet = new Set<string>();

  for (const component of components) {
    // Handle weighted ranges like "AA:0.5"
    let weight = '';
    let hand = component;

    if (component.includes(':')) {
      const parts = component.split(':');
      hand = parts[0].trim();
      weight = ':' + parts[1].trim();
    }

    const expanded = expandSingleRange(hand);

    // Add weight to each expanded hand if present
    if (weight) {
      expanded.forEach(h => handSet.add(h + weight));
    } else {
      expanded.forEach(h => handSet.add(h));
    }
  }

  return Array.from(handSet).join(',');
}

/**
 * Test if a range string is in shorthand notation (needs expansion)
 */
export function isShorthandRange(rangeString: string): boolean {
  return rangeString.includes('+') || /[2-9TJQKA]{2}(?![so])/.test(rangeString);
}
