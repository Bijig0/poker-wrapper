(() => {__FRAME__
  const tf = __frame(__SLOT__);
  if (!tf || !tf.contentDocument || !tf.contentWindow) return null;
  const w = tf.contentWindow, d = tf.contentDocument;
  if (!w.__ignWatch) {
    // Full match only: the seat stat chips ("ALL-IN · 0%", "CALL · 100%") are
    // permanent fixtures, not actions, and a prefix match swallowed them.
    const BADGE = /^(FOLD|CHECK|CALL|BET|RAISE|ALL[- ]?IN)$/i;
    const MONEY = /^[\d,]+(\.\d+)?(\s*BB)?$/;
    const buf = [];
    w.__ignBuf = buf;
    // Real action badges animate through low opacities (measured peak 0.31 on
    // some), so only TRUE ghosts (opacity 0 template nodes) may be rejected.
    const vis = el => {
      if (!el) return false;
      if (w.getComputedStyle(el).visibility !== 'visible') return false;
      for (let e = el; e && e !== d.body; e = e.parentElement)
        if (+w.getComputedStyle(e).opacity < 0.05) return false;
      return true;
    };
    const snap = () => {
      const anchors = [], badges = [], money = [];
      const H = d.documentElement.clientHeight || 654;
      const wk = d.createTreeWalker(d.body, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = wk.nextNode())) {
        const s = (n.nodeValue || '').trim();
        if (!s || s.length > 24) continue;
        const pe = n.parentElement;
        if (!vis(pe)) continue;
        const rg = d.createRange(); rg.selectNodeContents(n);
        const b = rg.getBoundingClientRect();
        if (!b.width || !b.height || b.y > H * 0.72) continue;
        if (/^[1-9]$/.test(s) && b.width <= 16 && b.height <= 20)
          anchors.push({s, x: b.x, y: b.y});
        else if (BADGE.test(s))
          badges.push({s: s.toUpperCase().replace(/\s+/g, '-'), x: b.x, y: b.y});
        else if (MONEY.test(s)) money.push({s, x: b.x, y: b.y});
      }
      const out = {};
      for (const bd of badges) {
        let best = null, bdist = 1e9;
        for (const a of anchors) {
          const dd = Math.abs(a.x - bd.x) + Math.abs(a.y - bd.y);
          if (dd < bdist) { bdist = dd; best = a; }
        }
        if (!best || bdist > 160) continue;
        let bet = null, mdist = 1e9;
        for (const m of money) {
          const dd = Math.hypot(m.x - best.x, m.y - best.y);
          if (dd < mdist && dd < 95) { mdist = dd; bet = m.s; }
        }
        out[best.s] = {badge: bd.s, bet};
      }
      return out;
    };
    let prev = {}, lastEmit = {};
    w.__ignWatch = setInterval(() => {
      try {
        const cur = snap(), now = Date.now();
        for (const seat of Object.keys(cur)) {
          const v = cur[seat], p = prev[seat];
          if (p && p.badge === v.badge) continue;
          const k = seat + ':' + v.badge;
          if (lastEmit[k] && now - lastEmit[k] < 900) continue;  // flicker guard
          lastEmit[k] = now;
          buf.push({t: now, seat: +seat, badge: v.badge, bet: v.bet});
          if (buf.length > 300) buf.shift();
        }
        prev = cur;
      } catch (e) { /* never break the page */ }
    }, 120);
  }
  const b = w.__ignBuf || [];
  return b.splice(0, b.length);
})()