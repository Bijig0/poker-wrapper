(() => {
  const f = [...document.querySelectorAll('iframe')].find(f => /playMode=/.test(f.getAttribute('src') || ''));
  if (!f) return { seated: false };
  let doc = null; try { doc = f.contentDocument; } catch (e) {}
  if (!doc || !doc.body) return { seated: false, reason: 'table frame not readable' };
  const src = f.getAttribute('src') || '';
  const q = Object.fromEntries((src.split('?')[1] || '').split('&').map(kv => kv.split('=').map(x => { try { return decodeURIComponent(x); } catch (e) { return x; } })));
  // quickSeatBigBlind is in CENTS (200 = $1/$2 — formats.py reads it the same way). Until 2026-09-19 this
  // treated it as dollars: a "92.5 BB" stack came back 100x too big, so every top-up run exited "at the max
  // already" without a word (session 220727), and the in-play balance logged $20,300 on a $2 table.
  let bbCents = parseInt(q.quickSeatBigBlind || '', 10);
  if (!(bbCents > 0)) {
    // Zone / non-quick-seat tables: the blinds live only in the table title, "$1/$2 No Limit Hold'em - …"
    const leaf = (root) => [...root.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => (e.textContent || '').trim());
    const tt = [...leaf(doc), ...leaf(document)].find(s => /\$[\d.,]+\s*\/\s*\$[\d.,]+/.test(s)) || '';
    const tm = tt.match(/\$([\d.,]+)\s*\/\s*\$([\d.,]+)/);
    if (tm) bbCents = Math.round(parseFloat(tm[2].replace(/,/g, '')) * 100);
  }
  const me = doc.querySelector("[data-qa='myPlayerTag']");
  const seat = me ? me.closest("[data-qa^='playerContainer-']") : null;
  const bal = seat ? seat.querySelector("[data-qa='playerBalance']") : null;
  if (!bal) return { seated: false, reason: 'no hero seat on the table' };
  const t = (bal.textContent || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(BB)?$/i);
  if (!m) return { seated: true, reason: 'stack text not understood', raw: t };
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (m[2]) {
    if (!(bbCents > 0)) return { seated: true, reason: 'stack is in BB but the table gave no big blind', raw: t };
    return { seated: true, amount: n * bbCents / 100, raw: t, how: 'stack-bb x $' + (bbCents / 100) };
  }
  return { seated: true, amount: n, raw: t, how: 'stack-$' };
})()