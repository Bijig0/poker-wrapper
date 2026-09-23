(() => {
  const money = (s) => {
    const m = String(s || '').match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
    return m ? m[1].replace(/,/g, '') : null;
  };
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  // 0. the client's own app bar — "Balance: $3,008.87 AUD ($2,115.15 USD)" — shown on
  //    the lobby AND at a table (seen in the 2026-08-05 recordings), so a balance can be
  //    read from a seat. USD is the account's currency; the site's AUD rides in `raw`.
  const docs = [document];
  for (const f of document.querySelectorAll('iframe')) { try { if (f.contentDocument && f.contentDocument.body) docs.push(f.contentDocument); } catch (e) {} }
  for (const doc of docs) {
    const m = (doc.body.innerText || '').match(/Balance:\s*\$([\d,]+(?:\.\d{1,2})?)\s*AUD\s*\(\$([\d,]+(?:\.\d{1,2})?)\s*USD\)/i)
           || (doc.body.innerText || '').match(/Balance:\s*\$([\d,]+(?:\.\d{1,2})?)\s*USD/i);
    if (m) {
      const usd = (m[2] || m[1]).replace(/,/g, '');
      return { ok: true, how: 'header', amount: usd, raw: clean(m[0]) };
    }
  }
  const D = (typeof L !== 'undefined' && L) ? L : null;
  if (!D) return { ok: false, reason: 'no Balance header on screen and the Poker home lobby frame is not open' };

  // 1. an explicit hook, if the client ever grows one
  for (const el of D.querySelectorAll('[data-qa*="balance" i],[data-testid*="balance" i],[id*="balance" i]')) {
    const v = money(el.textContent);
    if (v) return { ok: true, how: 'hook', amount: v, raw: clean(el.textContent) };
  }
  // 2. the sentence we KNOW this client renders
  const sent = (D.body.innerText.match(/Your available balance[^\n]*/i) || [])[0];
  if (sent) {
    const v = money(sent);
    if (v) return { ok: true, how: 'text:available-balance', amount: v, raw: clean(sent) };
  }
  // 3. a node labelled balance, with the amount on it or beside it
  const labelled = [...D.querySelectorAll('*')].filter((e) => e.children.length === 0 && /balance|cashier/i.test(e.textContent || ''));
  for (const el of labelled) {
    const near = money(el.textContent) || money(el.parentElement && el.parentElement.textContent)
      || money(el.nextElementSibling && el.nextElementSibling.textContent);
    if (near) return { ok: true, how: 'labelled', amount: near, raw: clean((el.parentElement || el).textContent) };
  }
  // nothing matched: hand back what money-looking text IS on the page
  const cands = [...new Set((D.body.innerText.match(/[^\n]*\$\s*[\d,]+(?:\.\d{1,2})?[^\n]*/g) || []).map(clean))].slice(0, 12);
  return { ok: false, reason: 'no balance found in the lobby', candidates: cands };
})()