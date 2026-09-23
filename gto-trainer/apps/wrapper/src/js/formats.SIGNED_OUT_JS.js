(() => { const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const ins = [...document.querySelectorAll('input')].filter(vis);
  return !!(ins.find(i => i.type === 'password') && ins.find(i => i.type === 'email' || /user|email/i.test(i.name + i.id))); })()