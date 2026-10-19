// Posts the signed payment details to PayFast, which opens its secure payment page.
function goToPayfast(p) {
  const f = document.createElement('form');
  f.method = 'POST'; f.action = p.url;
  Object.entries(p.fields).forEach(([k, v]) => {
    const i = document.createElement('input');
    i.type = 'hidden'; i.name = k; i.value = v; f.appendChild(i);
  });
  document.body.appendChild(f);
  f.submit();
}
