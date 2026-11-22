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

  // ---------- App instalável (PWA) ----------
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* sem armazenamento */ } } };
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIOSSafari = isIOS && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
  const banner = $('[data-install-banner]');
  const sheet = $('[data-ios-sheet]');
  const installBtns = $$('[data-install]');
  let deferred = null;
  const dismissedRecently = () => Number(store.get('install-dismissed') || 0) > Date.now() - 7 * 864e5;
  const showInstall = (withBanner) => {
    installBtns.forEach((b) => { b.hidden = false; });
    if (banner && withBanner && !dismissedRecently() && !$('.cookie')) banner.hidden = false; // não disputa espaço com o aviso de cookies
  };
  if (!standalone) {
    // Android/Chrome/Edge: o navegador avisa quando o app pode ser instalado
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; showInstall(true); });
    // iPhone/iPad: não há aviso automático; mostramos as instruções do Safari
    if (isIOS) {
      if (!isIOSSafari) { const hint = $('[data-install-hint]'); if (hint) hint.textContent = 'Abra este site no Safari para instalar na tela de início.'; }
      showInstall(true);
    }
  }
  installBtns.forEach((b) => b.addEventListener('click', async () => {
    if (deferred) {
      deferred.prompt();
      const choice = await deferred.userChoice.catch(() => null);
      deferred = null;
      if (choice && choice.outcome === 'accepted') { if (banner) banner.hidden = true; installBtns.forEach((x) => { x.hidden = true; }); }
    } else if (isIOS && sheet) {
      sheet.hidden = false;
    }
  }));
  const closeBanner = $('[data-install-close]');
  if (closeBanner) closeBanner.addEventListener('click', () => { banner.hidden = true; store.set('install-dismissed', String(Date.now())); });
  const closeSheet = $('[data-ios-close]');
  if (closeSheet) closeSheet.addEventListener('click', () => { sheet.hidden = true; });
  if (sheet) sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  window.addEventListener('appinstalled', () => { if (banner) banner.hidden = true; installBtns.forEach((x) => { x.hidden = true; }); });
  if (standalone) document.documentElement.classList.add('is-app');

  // Números da plataforma: sobem até o valor quando aparecem na tela (o valor final já vem no HTML)
  const counters = $$('[data-count]');
  if (counters.length && 'IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const fmt = (n) => n.toLocaleString('pt-BR');
    const io = new IntersectionObserver((entries) => entries.forEach((en) => {
      if (!en.isIntersecting) return;
      io.unobserve(en.target);
      const el = en.target; const end = Number(el.dataset.count) || 0; if (end < 2) return;
      const t0 = performance.now(); const dur = 1200;
      const step = (t) => { const k = Math.min(1, (t - t0) / dur); const v = Math.round(end * (1 - Math.pow(1 - k, 3))); el.textContent = `+${fmt(v)}`; if (k < 1) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    }), { threshold: 0.4 });
    counters.forEach((el) => io.observe(el));
  }

  // Contagem regressiva da reserva
  $$('[data-countdown]').forEach((el) => {
    const end = new Date(el.dataset.countdown).getTime();
    const tick = () => { const s = Math.max(0, Math.round((end - Date.now()) / 1000)); el.textContent = s ? `(restam ${Math.floor(s / 60)}min ${String(s % 60).padStart(2, '0')}s)` : '(reserva expirada — recarregue)'; if (s) setTimeout(tick, 1000); };
    tick();
  });
})();
