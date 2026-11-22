// Melhorias progressivas: tudo funciona sem JavaScript.
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

  const t = $('.menu-toggle');
  if (t) t.addEventListener('click', () => { const open = t.getAttribute('aria-expanded') === 'true'; t.setAttribute('aria-expanded', String(!open)); $('#menu').classList.toggle('open', !open); });

  $$('[data-share]').forEach((b) => b.addEventListener('click', async () => {
    const url = b.dataset.share;
    try { if (navigator.share) await navigator.share({ title: b.dataset.title, url }); else { await navigator.clipboard.writeText(url); b.textContent = 'Link copiado!'; } } catch (e) { /* cancelado */ }
  }));
  $$('[data-print]').forEach((b) => b.addEventListener('click', () => window.print()));
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (e) => { if (!confirm(f.dataset.confirm)) e.preventDefault(); }));
  $$('button[data-confirm]').forEach((b) => b.addEventListener('click', (e) => { if (!confirm(b.dataset.confirm)) e.preventDefault(); }));

  // Prévia de imagem
  $$('input[type=file][data-preview]').forEach((inp) => inp.addEventListener('change', () => {
    const img = document.getElementById(inp.dataset.preview); const f = inp.files[0];
    if (img && f && f.type.startsWith('image/')) { img.src = URL.createObjectURL(f); img.hidden = false; }
  }));

  // Máscaras simples
  const masks = { cpf: [3, 3, 3, 2, '..-'], cnpj: [2, 3, 3, 4, 2, './-'] };
  $$('input[data-mask]').forEach((inp) => inp.addEventListener('input', () => {
    const d = inp.value.replace(/\D/g, '');
    if (inp.dataset.mask === 'cpf') inp.value = d.slice(0, 11).replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
    if (inp.dataset.mask === 'cnpj') inp.value = d.slice(0, 14).replace(/^(\d{2})(\d)/, '$1.$2').replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d)/, '.$1/$2').replace(/(\d{4})(\d)/, '$1-$2');
  }));
  void masks;

  // Campos do responsável legal aparecem para menores
  $$('input[data-minor-target]').forEach((inp) => {
    const box = document.getElementById(inp.dataset.minorTarget);
    const upd = () => { if (!inp.value) { box.hidden = false; return; } const age = (Date.now() - new Date(inp.value + 'T12:00:00')) / 31557600000; box.hidden = age >= 18; };
    inp.addEventListener('change', upd); upd();
  });

  // Contagem regressiva da reserva
  $$('[data-countdown]').forEach((el) => {
    const end = new Date(el.dataset.countdown).getTime();
    const tick = () => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); el.textContent = s ? `(restam ${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s)` : '(reserva expirada — recarregue)'; if (s) setTimeout(tick, 1000); };
    tick();
  });
})();
