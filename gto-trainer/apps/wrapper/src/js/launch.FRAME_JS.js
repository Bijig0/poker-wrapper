
  const __frame = (SLOT) => {
    const play = f => /playMode=/.test(f.getAttribute('src') || '');
    const all = [...document.querySelectorAll('iframe')].filter(play);
    if (SLOT === null) return all[0];
    const tagOf = f => f.getAttribute('data-multitableslot');
    const tagged = all.filter(f => tagOf(f) !== null);
    // BY THE CLIENT'S OWN TAG ONCE WE HAVE ONE (2026-09-25). The ordinal below
    // moved tables: closing the top-right table by hand shifted every later
    // wrapper onto its neighbour's table, and two of them answered hands that
    // were not theirs. A tag is the client's identity for a table; a position
    // in its order is not. {tag} finds that table or nothing -- never another.
    // {ord, me}: this wrapper before its first read has pinned a tag. The page
    // keeps who holds which tag (window.__pwFramePins, refreshed on every read)
    // so a wrapper never takes a table another live wrapper is reading, and one
    // that restarted within the minute finds the tag it held before.
    if (SLOT !== null && typeof SLOT === 'object') {
      const pins = (window.__pwFramePins = window.__pwFramePins || {});
      const now = Date.now();
      const held = (t, ms) => pins[t] && now - pins[t].at < ms;
      const claim = f => { if (f && SLOT.me !== undefined && tagOf(f) !== null) pins[tagOf(f)] = {slot: SLOT.me, at: now}; return f; };
      if (SLOT.tag !== undefined && SLOT.tag !== null) {
        return claim(tagged.find(x => tagOf(x) === String(SLOT.tag)));
      }
      const mine = tagged.find(x => held(tagOf(x), 60000) && pins[tagOf(x)].slot === SLOT.me);
      if (mine) return claim(mine);
      const n = SLOT.ord;
      if (!tagged.length) return n === 0 ? all[0] : undefined;
      const f = [...tagged].sort((a, b) => Number(tagOf(a)) - Number(tagOf(b)))[n];
      if (!f || (held(tagOf(f), 15000) && pins[tagOf(f)].slot !== SLOT.me)) return undefined;
      return claim(f);
    }
    // BY ORDINAL (a bare number: another table named by its place in the
    // client's order). 2026-09-21: asking for `[data-multitableslot="0"]` took
    // the client's numbering on faith and the leader's lookup found nothing.
    // Sort the tagged table frames by their own tag and take the Nth. Works
    // 0-based, 1-based or with gaps.
    if (!tagged.length) return SLOT === 0 ? all[0] : undefined;   // untagged = the single-table client
    tagged.sort((a, b) => Number(tagOf(a)) - Number(tagOf(b)));
    return tagged[SLOT];
  };
