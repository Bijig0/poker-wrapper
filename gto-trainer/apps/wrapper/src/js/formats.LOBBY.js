
var L = (() => { for (const f of document.querySelectorAll('iframe')) { try { const d = f.contentDocument;
  if (d && d.body && /Poker home/.test(d.body.innerText)) return d; } catch (e) {} } return null; })();
