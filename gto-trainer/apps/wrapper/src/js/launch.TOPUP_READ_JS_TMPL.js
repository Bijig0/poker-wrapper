(() => {__FRAME__
  const f = __frame(__SLOT__);
  if (!f) return { seated: false, reason: 'no table frame' };
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
  // the ring max from the src (cents); a quick-seat table without it is taken as 100bb — Ignition's ring max
  // everywhere we play — and flagged so the record says the number was assumed, not read
  let maxCents = parseInt(q.quickSeatMaxBuyIn || '', 10);
  let maxAssumed = false;
  const zone = /zone/i.test(q.gameFormat || '') || /zone/i.test(q.gameTableUrl || '');
  if (!(maxCents > 0) && bbCents > 0 && !zone) { maxCents = 100 * bbCents; maxAssumed = true; }
  const me = doc.querySelector("[data-qa='myPlayerTag']");
  const seat = me ? me.closest("[data-qa^='playerContainer-']") : null;
  const bal = seat ? seat.querySelector("[data-qa='playerBalance']") : null;
  if (!bal) return { seated: false, reason: 'no hero seat on the table' };
  const t = (bal.textContent || '').trim();
  const m = t.match(/^\$?\s*([\d,]+(?:\.\d+)?)\s*(BB)?$/i);
  let stackCents = null;
  if (m) { const n = parseFloat(m[1].replace(/,/g, '')); stackCents = m[2] ? (bbCents > 0 ? Math.round(n * bbCents) : null) : Math.round(n * 100); }
  // THE BUY-CHIPS PANEL = a visible text/number field whose surroundings say "Max. $N" / "Playable balance"
  // (2026-09-19: the client renders "Max. $5" as ONE leaf, so the old "a leaf that is exactly 'Max.'" test never
  // matched — an open panel read as closed, three times in session 010011, and the press toggled it shut again)
  let panel = null, offerCents = null, input = null;
  for (const inp of doc.querySelectorAll('input')) {
    if (inp.type === 'checkbox' || inp.type === 'radio' || inp.type === 'hidden') continue;
    const b = inp.getBoundingClientRect(); if (!(b.width > 0 && b.height > 0)) continue;
    let c = inp.parentElement;
    for (let i = 0; i < 6 && c && c !== doc.body; i++) {
      const tx = c.textContent || '';
      if (/Max\.?\s*\$?\s*[\d,]+(?:\.\d+)?/i.test(tx) || /Playable balance/i.test(tx)) { panel = c; break; }
      c = c.parentElement;
    }
    if (panel) {
      const mm = (panel.textContent || '').match(/Max\.?\s*\$?\s*([\d,]+(?:\.\d+)?)/i);
      if (mm) offerCents = Math.round(parseFloat(mm[1].replace(/,/g, '')) * 100);
      input = inp;
      break;
    }
  }
  return { seated: true, stackCents, stackText: t, bbCents: bbCents > 0 ? bbCents : null, zone,
           maxCents: maxCents > 0 ? maxCents : null, maxAssumed, panelOpen: !!panel, offerCents,
           inputFound: !!input, inputValue: input ? input.value : null };
})()