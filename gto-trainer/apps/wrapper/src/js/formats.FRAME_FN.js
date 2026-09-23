
  const __frame = (SLOT) => {
    const play = f => /playMode=/.test(f.getAttribute('src') || '');
    const all = [...document.querySelectorAll('iframe')].filter(play);
    if (SLOT === null) return all[0];
    // BY ORDINAL, NOT BY THE ATTRIBUTE'S VALUE (2026-09-21). This used to ask
    // for `[data-multitableslot="0"]` and take the client's numbering on faith.
    // Live, the leader's lookup for 0 found NOTHING while slot 2's for 1 found a
    // table -- whatever base this build tags from, it is not the one we assumed.
    // The leader then had no frame, so no seatQa, so no hero seat, so the tap
    // never identified its socket and the panel read "no hand in progress" for
    // the whole session. We do not need the client's numbers, only its ORDER:
    // sort the tagged table frames by their own tag and take the Nth. Works
    // 0-based, 1-based or with gaps.
    const tagged = all.filter(f => f.getAttribute('data-multitableslot') !== null);
    if (!tagged.length) return SLOT === 0 ? all[0] : undefined;   // untagged = the single-table client
    tagged.sort((a, b) => Number(a.getAttribute('data-multitableslot'))
                        - Number(b.getAttribute('data-multitableslot')));
    return tagged[SLOT];
  };
