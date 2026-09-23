(() => {
  const vis = (e) => { const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const inputs = [...document.querySelectorAll('input, select, textarea')].map(i => ({
    tag: i.tagName.toLowerCase(), type: i.type, id: i.id, name: i.name, placeholder: i.placeholder, autocomplete: i.autocomplete,
    maxLength: i.maxLength, visible: vis(i), checked: i.type === 'checkbox' ? i.checked : undefined,
    label: (i.labels && i.labels[0] ? i.labels[0].innerText : '').trim().slice(0, 60) }));
  const buttons = [...document.querySelectorAll('button, [role=button], input[type=submit], a.btn')].map(b => ({
    text: (b.innerText || b.value || '').trim().replace(/\s+/g, ' ').slice(0, 60), id: b.id, type: b.type, visible: vis(b) }));
  const iframes = [...document.querySelectorAll('iframe')].map(f => ({ src: (f.src || '').replace(/[?#].*$/, '').slice(0, 120), visible: vis(f) }));
  const text = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500);
  return { url: location.href.replace(/[?#].*$/, ''), title: document.title, inputs, buttons, iframes, text };
})()