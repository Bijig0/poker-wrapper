
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
        // two frames carrying our tag (the client re-creating the table's
        // frame): the one on screen, else the newest
        const ours = tagged.filter(x => tagOf(x) === String(SLOT.tag));
        const shown = f => { const r = f.getBoundingClientRect();
                             return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
                                 && r.left < innerWidth && r.top < innerHeight; };
        return claim(ours.length < 2 ? ours[0] : ours.find(shown) || ours[ours.length - 1]);
      }
      const mine = tagged.find(x => held(tagOf(x), 60000) && pins[tagOf(x)].slot === SLOT.me);
      if (mine) return claim(mine);
      const n = SLOT.ord;
      if (!tagged.length) return n === 0 ? all[0] : undefined;
      const inOrder = [...tagged].sort((a, b) => Number(tagOf(a)) - Number(tagOf(b)));
      const f = inOrder[n];
      if (!f) return undefined;
      if (!(held(tagOf(f), 15000) && pins[tagOf(f)].slot !== SLOT.me)) return claim(f);
      // OUR PLACE IN THE ORDER IS ANOTHER WRAPPER'S TABLE (2026-09-30,
      // session_20260930_140729): the client put the first table seated at
      // tag 1, table 1 read it, and table 2's place (the 2nd in tag order =
      // tag 1) was never free -- it read nothing all session while tag 0, the
      // table it was dealt A4o at, stood unread. The tables are all there
      // (the Nth exists), so take the first in the order no wrapper has read
      // within the minute; a table another wrapper read lately stays theirs.
      return claim(inOrder.find(x => !held(tagOf(x), 60000)));
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
