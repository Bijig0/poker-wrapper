(() => {__FRAME__
  const SLOT = __SLOT__;
  const f = __frame(SLOT);
  if (!f) return null;
  const keep = ['gameType','gameFormat','seat','playMode','limit','isQuickSeat','quickSeatSmallBlind','quickSeatBigBlind',
                'quickSeatBuyInAmount','quickSeatMinBuyIn','quickSeatMaxBuyIn','waitForBigBlind','tableName','gameTableUrl','currency'];
  const out = {};
  for (const p of ((f.getAttribute('src') || '').split('?')[1] || '').split('&')) {
    const [k, v] = p.split('=');
    if (keep.includes(k)) out[k] = decodeURIComponent(v || '');
  }
  let title = null;
  try { title = (f.contentDocument.body.innerText.match(/[^\n]*Hold'em[^\n]*/) || [])[0] || null; } catch (e) {}
  out._title = title;
  return out;
})()