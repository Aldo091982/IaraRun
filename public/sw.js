/* Service worker do app instalável.
 * - Arquivos estáticos (CSS, JS, ícones, fontes): cache primeiro, atualizado em segundo plano.
 * - Páginas: sempre da rede (dados de inscrição e pagamento precisam estar atualizados);
 *   sem conexão, mostra a página "sem internet".
 * - Nada de formulários, login, pagamentos ou arquivos privados vai para o cache.
 */
const VERSION = '__VERSION__';
const STATIC = `static-${VERSION}`;
const OFFLINE_URL = '/offline';
const PRECACHE = [OFFLINE_URL, '/static/css/app.css?v=__VERSION__', '/static/js/app.js?v=__VERSION__', '/static/img/icon-192.png', '/static/img/apple-touch-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== STATIC).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isStatic = (url) => url.origin === self.location.origin && url.pathname.startsWith('/static/');
const isFont = (url) => url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(() => caches.match(OFFLINE_URL)));
    return;
  }
  if (isStatic(url) || isFont(url)) {
    event.respondWith(caches.open(STATIC).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok || res.type === 'opaque') cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }));
  }
});
