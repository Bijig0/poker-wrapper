(() => {
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const path = location.pathname;
  const text = (document.body.innerText || '').replace(/\s+/g, ' ');
  const inputs = [...document.querySelectorAll('input')].filter(vis);
  const login = inputs.find(i => i.type === 'password') && inputs.find(i => i.type === 'email' || /user|email/i.test(i.name + i.id));
  // Ignition's 2FA step: a "LOGIN VERIFICATION" modal with input#code (type=number) drawn OVER the login form,
  // whose inputs stay in the DOM — so the code field takes precedence over the login form.
  const code = inputs.find(i => i.id === 'code' || i.name === 'code' || i.autocomplete === 'one-time-code'
                          || /otp|token|2fa|verif/i.test(i.name + ' ' + i.id + ' ' + i.placeholder)
                          || (i.maxLength > 0 && i.maxLength <= 8 && i.type !== 'password' && i.type !== 'checkbox' && i.type !== 'email'));
  const codeText = /verification code|6-digit code|authentication code|security code|one.time|two.factor|2FA|Authy|authenticator/i.test(text);
  const trust = inputs.find(i => i.type === 'checkbox' && /trust/i.test(i.name + i.id));
  const challenge = [...document.querySelectorAll('iframe')].some(f => /recaptcha.*bframe/.test(f.src || '') && vis(f) && f.getBoundingClientRect().width > 200);
  const errs = [...document.querySelectorAll('[role=alert], [class*=error], [class*=alert], [class*=invalid]')]
    .filter(vis).map(e => (e.innerText || '').trim().replace(/\s+/g, ' '))
    .filter(t => t && t.length > 3 && t.length < 200 && t !== 'PASTE' && !/enter the code to proceed|6-digit code\*?\s*(PASTE)?$/i.test(t) && !/^\s*6-digit code/i.test(t)
                 && !/^welcome/i.test(t));   // "Welcome!" is the site's sign-in SUCCESS toast, not an error (read as one on 09-12 and 09-17)
  const seated = [...document.querySelectorAll('iframe')].some(f => /playMode=/.test(f.getAttribute('src') || ''));
  // the casino landing (/headless/poker/casino-crossplay) is where a fresh sign-in lands: signed in, no lobby yet
  const lobby = /poker-lobby|poker-game|headless\/poker/.test(path) && !login;
  return { path, hasLogin: !!login, hasCode: !!code, codeText, challenge, errs: [...new Set(errs)].slice(0, 4), seated, lobby,
           trustField: trust ? { id: trust.id, checked: trust.checked } : null,
           codeField: code ? { name: code.name, id: code.id, ac: code.autocomplete, max: code.maxLength, type: code.type } : null,
           snippet: text.slice(0, 240) };
})()