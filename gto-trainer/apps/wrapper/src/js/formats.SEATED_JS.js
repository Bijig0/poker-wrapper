(() => {
  const play = f => /playMode=/.test(f.getAttribute('src') || '');
  const slots = [...document.querySelectorAll('iframe[data-multitableslot]')]
    .filter(play)
    .map(f => Number(f.getAttribute('data-multitableslot')))
    .filter(n => Number.isFinite(n) && n >= 0)
    .sort((a, b) => a - b);
  // the single-table client has no such attribute at all: one playMode frame is
  // one table, and it is slot 0 by definition
  if (!slots.length) {
    const one = [...document.querySelectorAll('iframe')].filter(play).length;
    return JSON.stringify({slots: one ? [0] : [], tagged: false});
  }
  return JSON.stringify({slots, tagged: true});
})()