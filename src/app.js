'use strict';
const path = require('node:path');
const express = require('express');
const config = require('./config');
const db = require('./db');
const { randomToken, html, UserError } = require('./lib/util');
const { memberships, membership } = require('./lib/orgs');
const { page } = require('./views/layout');

function parseCookies(h = '') { return Object.fromEntries(h.split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])); }

async function createApp() {
  await db.open();
  const app = express();
  app.set('trust proxy', config.isProd ? 1 : false);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    next();
  });
  // ---------- App instalável (PWA) ----------
  const { APP_NAME, ASSET_V } = require('./views/layout');
  app.get('/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify({
      name: APP_NAME, short_name: APP_NAME, lang: 'pt-BR', dir: 'ltr',
      description: 'Inscrições em corridas e eventos esportivos, kit, resultados e certificados.',
      id: '/', start_url: '/?origem=app', scope: '/', display: 'standalone', orientation: 'portrait',
      background_color: '#0b0b0b', theme_color: '#0b0b0b', categories: ['sports', 'lifestyle'],
      icons: [
        { src: '/static/img/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: '/static/img/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: '/static/img/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
      shortcuts: [
        { name: 'Eventos', url: '/eventos', icons: [{ src: '/static/img/icon-192.png', sizes: '192x192' }] },
        { name: 'Minhas inscrições', url: '/minha-conta', icons: [{ src: '/static/img/icon-192.png', sizes: '192x192' }] },
      ],
    }));
  });
  const swSource = require('node:fs').readFileSync(path.join(config.root, 'public', 'sw.js'), 'utf8').replaceAll('__VERSION__', ASSET_V);
  app.get('/sw.js', (req, res) => res.type('application/javascript').set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).send(swSource));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/static/img/favicon-32.png'));
  app.get('/offline', (req, res) => res.set('Cache-Control', 'no-cache').send(`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="theme-color" content="#0b0b0b"><title>Sem conexão · ${APP_NAME}</title><link rel="stylesheet" href="/static/css/app.css?v=${ASSET_V}"></head>
<body class="offline-page"><main class="offline-box"><img src="/static/img/icon-192.png" alt="" width="96" height="96"><h1>Sem conexão</h1><p>Você está sem internet. Inscrições, pagamentos e resultados precisam de conexão para mostrar informações atualizadas.</p><button class="btn btn-lg" onclick="location.reload()">Tentar de novo</button></main></body></html>`));

  app.use('/static', express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '7d' : 0 }));
  app.use('/media', express.static(config.publicUploadDir, { maxAge: '1d' })); // somente arquivos públicos (logos, capas)

  // Webhooks precisam do corpo bruto antes dos parsers
  app.use('/webhooks', require('./routes/webhooks'));
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(express.json({ limit: '1mb' }));

  // Cookies, sessão e CSRF (double-submit + SameSite=Lax)
  app.use(async (req, res, next) => {
    req.cookies = parseCookies(req.headers.cookie);
    const cookieOpts = { httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/' };
    res.setCookie = (n, v, o = {}) => res.cookie(n, v, { ...cookieOpts, ...o });
    let tok = req.cookies.csrf;
    if (!tok) { tok = randomToken(18); res.setCookie('csrf', tok); }
    req.csrfToken = tok;
    // flash
    req.flash = [];
    if (req.cookies.flash) { try { req.flash = JSON.parse(req.cookies.flash); } catch { /* ignora */ } res.clearCookie('flash', { path: '/' }); }
    res.flash = (type, msg) => { const f = [...(res._flash || []), { type, msg }]; res._flash = f; res.setCookie('flash', JSON.stringify(f), { maxAge: 60000 }); };
    const sid = req.cookies.sid;
    if (sid) {
      const s = await db.one('SELECT * FROM sessions WHERE id=? AND expires_at>?', sid, new Date().toISOString());
      if (s) {
        const u = await db.one("SELECT * FROM users WHERE id=? AND status='active'", s.user_id);
        if (u) { req.session = s; req.user = u; req.memberships = await memberships(u.id); }
      }
    }
    if (req.user && req.session.context.startsWith('org:')) {
      const orgId = Number(req.session.context.slice(4));
      req.member = await membership(req.user.id, orgId);
      req.org = req.member ? await db.one('SELECT * FROM organizations WHERE id=?', orgId) : null;
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.method !== 'POST' || req.path.startsWith('/api/')) return next();
    if ((req.headers['content-type'] || '').startsWith('multipart/form-data')) return next(); // verificado após o multer
    if (req.body?._csrf && req.body._csrf === req.csrfToken) return next();
    next(new UserError('Sessão do formulário expirou. Recarregue a página e tente novamente.', 403));
  });
  app.use((req, res, next) => {
    res.page = (opts) => res.send(page(req, opts));
    res.back = (fallback = '/') => res.redirect(303, req.get('referer') || fallback);
    next();
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/public'));
  app.use(require('./routes/checkout'));
  app.use('/minha-conta', require('./routes/athlete'));
  app.use('/organizador', require('./routes/onboarding'));
  app.use('/organizador', require('./routes/organizer'));
  app.use('/organizador', require('./routes/eventWizard'));
  app.use('/organizador', require('./routes/operations'));
  app.use('/admin', require('./routes/admin'));
  app.use('/api', require('./routes/api'));
  if (!config.isProd) app.use('/dev', require('./routes/dev'));

  app.use((req, res) => res.status(404).send(page(req, { title: 'Página não encontrada', body: html`<section class="card"><h1>Página não encontrada</h1><p>O endereço pode ter mudado ou o conteúdo não é público.</p><a class="btn" href="/eventos">Ver eventos</a></section>` })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 400 : 500);
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo acima do tamanho permitido.' : err.expose ? err.message : 'Ocorreu um erro inesperado. Tente novamente.';
    if (status >= 500) console.error(err);
    if (req.path.startsWith('/api/')) return res.status(status).json({ error: msg });
    if (status === 401) return res.redirect(303, `/entrar?volta=${encodeURIComponent(req.originalUrl)}`);
    if (req.method === 'POST' && status < 500 && req.get('referer')) { res.flash('error', msg); return res.redirect(303, req.get('referer')); }
    res.status(status).send(page(req, { title: 'Erro', body: html`<section class="card"><h1>${status === 403 ? 'Acesso não autorizado' : status === 404 ? 'Não encontrado' : 'Não foi possível concluir'}</h1><p>${msg}</p><a class="btn" href="/">Voltar ao início</a></section>` }));
  });
  return app;
}
module.exports = { createApp };
