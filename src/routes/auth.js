'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, raw, randomToken, UserError } = require('../lib/util');
const { isEmail } = require('../lib/docs');
const { hashPassword, verifyPassword, issueToken, consumeToken, sendMail, audit, LEGAL, recordConsent } = require('../lib/core');
const { refreshStatus, membership } = require('../lib/orgs');
const { page, csrf, field, errorsBox } = require('../views/layout');
const { requireUser } = require('../lib/guards');

const r = express.Router();
const safeBack = (v, fb) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : fb);

async function startSession(req, res, user, context) {
  const id = randomToken(32);
  const ctx = context || (await db.one('SELECT context FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 1', user.id))?.context || 'athlete';
  await db.run('INSERT INTO sessions(id,user_id,context,csrf,expires_at) VALUES(?,?,?,?,?)', id, user.id, ctx, randomToken(18), new Date(Date.now() + 14 * 864e5).toISOString());
  res.setCookie('sid', id, { maxAge: 14 * 864e5 });
}
async function sendVerification(user) {
  const t = await issueToken(user.id, 'verify', 60 * 48);
  await sendMail(user.email, 'Confirme seu e-mail', `Olá, ${user.name}! Confirme seu e-mail acessando: ${config.baseUrl}/confirmar-email?t=${t}\nO link vale por 48 horas.`);
}

const loginLimiter = new Map();
function throttle(key) {
  const now = Date.now(); const e = loginLimiter.get(key) || { n: 0, t: now };
  if (now - e.t > 15 * 60000) { e.n = 0; e.t = now; }
  e.n++; loginLimiter.set(key, e);
  if (e.n > 10) throw new UserError('Muitas tentativas. Aguarde alguns minutos.', 429);
}

function signupForm(req, { values = {}, errors = [] } = {}) {
  const org = req.query.perfil === 'organizador' || values.perfil === 'organizador';
  return html`<section class="card narrow"><h1>${org ? 'Criar conta de organizador' : 'Criar conta'}</h1>
  <p>${org ? 'Primeiro criamos seu acesso pessoal (responsável pela empresa). Depois você cadastra a empresa — se já for atleta, use a mesma conta.' : 'Com uma única conta você se inscreve em provas e, se quiser, também organiza eventos.'}</p>
  ${errorsBox(errors)}
  ${googleButton(req, { perfil: org ? 'organizador' : '' })}
  <form method="post" action="/cadastro" novalidate>${csrf(req)}<input type="hidden" name="perfil" value="${org ? 'organizador' : ''}"><input type="hidden" name="volta" value="${values.volta || req.query.volta || ''}">
  ${field('name', 'Nome completo', { value: values.name, required: true, attrs: 'autocomplete="name"' })}
  ${field('email', 'E-mail', { value: values.email, type: 'email', required: true, attrs: 'autocomplete="email"', hint: 'Enviaremos um link de confirmação.' })}
  ${field('password', 'Senha', { type: 'password', required: true, attrs: 'autocomplete="new-password" minlength="8"', hint: 'Mínimo de 8 caracteres.' })}
  ${field('accept', html`Li e aceito os <a href="/legal/terms" target="_blank">Termos de Uso</a> (v. ${LEGAL.terms.version}) e a <a href="/legal/privacy" target="_blank">Política de Privacidade</a> (v. ${LEGAL.privacy.version})`, { type: 'checkbox', required: true, value: values.accept })}
  ${field('marketing', 'Quero receber novidades e divulgação de eventos por e-mail (opcional, pode cancelar a qualquer momento)', { type: 'checkbox', value: values.marketing })}
  <button class="btn btn-block">Criar conta</button></form>
  <p class="center">Já tem conta? <a href="/entrar${org ? '?volta=/organizador/cadastro' : ''}">Entrar</a></p></section>`;
}
r.get('/cadastro', (req, res) => (req.user ? res.redirect(req.query.perfil === 'organizador' ? '/organizador/cadastro' : '/minha-conta') : res.page({ title: 'Criar conta', body: signupForm(req) })));
r.post('/cadastro', async (req, res) => {
  const b = req.body; const errors = [];
  if (!b.name || b.name.trim().length < 3) errors.push('Informe seu nome completo.');
  if (!isEmail(b.email)) errors.push('Informe um e-mail válido.');
  if (!b.password || b.password.length < 8) errors.push('A senha precisa ter ao menos 8 caracteres.');
  if (!b.accept) errors.push('É necessário aceitar os Termos de Uso e a Política de Privacidade.');
  if (!errors.length && await db.one('SELECT 1 FROM users WHERE email=?', b.email.trim())) errors.push('Já existe conta com este e-mail. Entre com sua senha ou recupere o acesso.');
  if (errors.length) return res.status(400).page({ title: 'Criar conta', body: signupForm(req, { values: b, errors }) });
  const id = Number((await db.run('INSERT INTO users(email,name,password_hash,marketing_opt_in) VALUES(?,?,?,?)', b.email.trim().toLowerCase(), b.name.trim(), hashPassword(b.password), b.marketing ? 1 : 0)).lastInsertRowid);
  await recordConsent(req, id, 'terms', 'signup'); await recordConsent(req, id, 'privacy', 'signup');
  if (b.marketing) await recordConsent(req, id, 'marketing', 'signup');
  const user = await db.one('SELECT * FROM users WHERE id=?', id);
  await sendVerification(user);
  await audit(req, 'user.signup', { userId: id, entity: 'user', entityId: id });
  await startSession(req, res, user, 'athlete');
  res.flash('success', 'Conta criada! Enviamos um link de confirmação para seu e-mail.');
  res.redirect(303, b.perfil === 'organizador' ? '/organizador/cadastro' : safeBack(b.volta, '/minha-conta'));
});

r.get('/entrar', (req, res) => res.page({ title: 'Entrar', body: html`<section class="card narrow"><h1>Entrar</h1>
  ${googleButton(req)}
  <form method="post" action="/entrar">${csrf(req)}<input type="hidden" name="volta" value="${req.query.volta || ''}">
  ${field('email', 'E-mail', { type: 'email', required: true, attrs: 'autocomplete="email"' })}
  ${field('password', 'Senha', { type: 'password', required: true, attrs: 'autocomplete="current-password"' })}
  <button class="btn btn-block">Entrar</button></form>
  <p class="center"><a href="/recuperar-acesso">Esqueci minha senha</a> · <a href="/cadastro${req.query.volta ? `?volta=${encodeURIComponent(req.query.volta)}` : ''}">Criar conta</a></p></section>` }));
r.post('/entrar', async (req, res) => {
  throttle(`${req.ip}|${String(req.body.email).toLowerCase()}`);
  const u = await db.one('SELECT * FROM users WHERE email=?', String(req.body.email || '').trim());
  if (!u || !verifyPassword(req.body.password || '', u.password_hash)) { res.flash('error', 'E-mail ou senha incorretos.'); return res.redirect(303, `/entrar?volta=${encodeURIComponent(req.body.volta || '')}`); }
  if (u.status !== 'active') { res.flash('error', 'Conta suspensa. Entre em contato com o suporte.'); return res.redirect(303, '/entrar'); }
  await startSession(req, res, u);
  await audit(req, 'user.login', { userId: u.id });
  res.redirect(303, safeBack(req.body.volta, '/minha-conta'));
});
r.post('/sair', async (req, res) => { if (req.session) await db.run('DELETE FROM sessions WHERE id=?', req.session.id); res.clearCookie('sid', { path: '/' }); res.redirect(303, '/'); });

r.get('/confirmar-email', async (req, res) => {
  const uid = await consumeToken(String(req.query.t || ''), 'verify');
  if (!uid) return res.status(400).page({ title: 'Link inválido', body: html`<section class="card narrow"><h1>Link inválido ou expirado</h1><p>Entre na sua conta e solicite um novo link de confirmação.</p><a class="btn" href="/minha-conta">Ir para minha conta</a></section>` });
  await db.run('UPDATE users SET email_verified_at=COALESCE(email_verified_at,?) WHERE id=?', new Date().toISOString(), uid);
  for (const m of await db.all("SELECT org_id FROM org_members WHERE user_id=? AND role='owner'", uid)) await refreshStatus(m.org_id);
  await audit(req, 'user.email_verified', { userId: uid });
  res.flash('success', 'E-mail confirmado. Obrigado!');
  res.redirect(303, req.user ? (req.session.context.startsWith('org:') ? '/organizador' : '/minha-conta') : '/entrar');
});
r.post('/reenviar-confirmacao', requireUser, async (req, res) => {
  if (!req.user.email_verified_at) await sendVerification(req.user);
  res.flash('success', 'Enviamos um novo link de confirmação.');
  res.back('/minha-conta');
});

r.get('/recuperar-acesso', (req, res) => res.page({ title: 'Recuperar acesso', body: html`<section class="card narrow"><h1>Recuperar acesso</h1><p>Informe seu e-mail. Se houver conta, enviaremos um link para criar nova senha.</p>
  <form method="post">${csrf(req)}${field('email', 'E-mail', { type: 'email', required: true })}<button class="btn btn-block">Enviar link</button></form></section>` }));
r.post('/recuperar-acesso', async (req, res) => {
  throttle(`reset|${req.ip}`);
  const u = await db.one('SELECT * FROM users WHERE email=?', String(req.body.email || '').trim());
  if (u) { const t = await issueToken(u.id, 'reset', 60); await sendMail(u.email, 'Redefinição de senha', `Para criar nova senha acesse ${config.baseUrl}/nova-senha?t=${t} (válido por 1 hora). Se não foi você, ignore esta mensagem.`); }
  res.flash('success', 'Se o e-mail estiver cadastrado, você receberá o link em instantes.');
  res.redirect(303, '/entrar');
});
r.get('/nova-senha', (req, res) => res.page({ title: 'Nova senha', body: html`<section class="card narrow"><h1>Criar nova senha</h1><form method="post">${csrf(req)}<input type="hidden" name="t" value="${req.query.t || ''}">${field('password', 'Nova senha', { type: 'password', required: true, hint: 'Mínimo de 8 caracteres.' })}<button class="btn btn-block">Salvar</button></form></section>` }));
r.post('/nova-senha', async (req, res) => {
  if (!req.body.password || req.body.password.length < 8) throw new UserError('A senha precisa ter ao menos 8 caracteres.');
  const uid = await consumeToken(String(req.body.t || ''), 'reset');
  if (!uid) throw new UserError('Link inválido ou expirado. Solicite novamente.');
  await db.run('UPDATE users SET password_hash=?, email_verified_at=COALESCE(email_verified_at,?) WHERE id=?', hashPassword(req.body.password), new Date().toISOString(), uid);
  await db.run('DELETE FROM sessions WHERE user_id=?', uid);
  await audit(req, 'user.password_reset', { userId: uid });
  res.flash('success', 'Senha alterada. Entre com a nova senha.');
  res.redirect(303, '/entrar');
});

async function switchContext(req, ctx) {
  if (ctx === 'athlete') return 'athlete';
  if (ctx === 'admin' && req.user.is_admin) return 'admin';
  const m = /^org:(\d+)$/.exec(ctx || '');
  if (m && await membership(req.user.id, Number(m[1]))) return ctx;
  throw new UserError('Perfil indisponível para esta conta.', 403);
}
r.post('/contexto', requireUser, async (req, res) => {
  const ctx = await switchContext(req, req.body.context);
  await db.run('UPDATE sessions SET context=? WHERE id=?', ctx, req.session.id);
  res.redirect(303, ctx === 'admin' ? '/admin' : ctx === 'athlete' ? '/minha-conta' : '/organizador');
});
r.get('/contexto/:ctx', requireUser, async (req, res) => {
  const ctx = await switchContext(req, req.params.ctx);
  await db.run('UPDATE sessions SET context=? WHERE id=?', ctx, req.session.id);
  res.redirect(303, safeBack(req.query.volta, '/'));
});
r.post('/privacidade/cookies', (req, res) => { res.setCookie('cookie_consent', req.body.choice === 'all' ? 'all' : 'essential', { maxAge: 180 * 864e5 }); res.back('/'); });

r.get('/legal/:key', (req, res, next) => {
  const d = LEGAL[req.params.key];
  if (!d) return next();
  res.page({ title: d.title, body: html`<article class="card prose"><h1>${d.title}</h1><p class="muted">Versão ${d.version}</p>
  <div class="alert alert-warn">Texto-modelo de demonstração. Deve ser substituído por versão revisada juridicamente antes da produção.</div>
  <p>Este documento descreve as regras de uso da plataforma, as responsabilidades de atletas e organizadores, e o tratamento de dados pessoais conforme a LGPD (Lei 13.709/2018): finalidade, base legal, compartilhamento com organizadores dos eventos em que você se inscreve, prazos de retenção e canais para exercício de direitos.</p>
  <p>Documentos de identidade enviados por organizadores são armazenados em área privada, com acesso restrito à equipe de verificação e registro de cada consulta.</p></article>` });
});
/* ===================== Entrar / criar conta com o Google =====================
 * OpenID Connect com fluxo de código + PKCE (https://developers.google.com/identity/openid-connect/openid-connect).
 * Proteções: state ligado a um cookie do navegador (impede login forçado), nonce no id_token,
 * id_token recebido direto do Google por TLS e conferido (emissor, público, validade, nonce),
 * e-mail aceito só se o Google o marcar como verificado.
 * Sem credenciais e fora de produção, um simulador local (DEMONSTRAÇÃO) percorre o mesmo caminho.
 */
const crypto = require('node:crypto');
const pendingGoogle = new Map(); // state -> { nonce, verifier, volta, perfil, exp }
const pendingSignup = new Map(); // token -> { profile, volta, perfil, exp }
const sweep = (m) => { const now = Date.now(); for (const [k, v] of m) if (v.exp < now) m.delete(k); };
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const GOOGLE_REDIRECT = () => `${config.baseUrl}/entrar/google/retorno`;

const G_LOGO = '<svg class="g-logo" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
/** Botão "Continuar com o Google" (some quando o login com Google está desativado). */
function googleButton(req, { perfil } = {}) {
  if (config.google.mode === 'disabled') return '';
  const q = new URLSearchParams();
  if (req.query.volta) q.set('volta', String(req.query.volta));
  if (perfil) q.set('perfil', perfil);
  return html`<a class="btn-google" href="/entrar/google${q.size ? `?${q}` : ''}">${raw(G_LOGO)}<span>Continuar com o Google</span></a>
  <div class="or-sep"><span>ou com e-mail</span></div>`;
}

r.get('/entrar/google', (req, res) => {
  if (config.google.mode === 'disabled') throw new UserError('Login com Google indisponível.', 404);
  sweep(pendingGoogle);
  const state = randomToken(24); const nonce = randomToken(24); const verifier = b64url(crypto.randomBytes(48));
  pendingGoogle.set(state, { nonce, verifier, volta: safeBack(req.query.volta, ''), perfil: req.query.perfil === 'organizador' ? 'organizador' : '', exp: Date.now() + 10 * 60000 });
  res.setCookie('g_state', state, { maxAge: 10 * 60000 });
  if (config.google.mode === 'simulator') return res.redirect(303, `/dev/google?state=${encodeURIComponent(state)}`);
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.search = new URLSearchParams({ client_id: config.google.clientId, redirect_uri: GOOGLE_REDIRECT(), response_type: 'code', scope: 'openid email profile',
    state, nonce, code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', prompt: 'select_account' }).toString();
  res.redirect(303, u.toString());
});

/** Troca o código pelo id_token e confere as declarações. Retorna { sub, email, name }. */
async function googleProfile(code, pend) {
  const resp = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.google.clientId, client_secret: config.google.clientSecret, redirect_uri: GOOGLE_REDIRECT(), grant_type: 'authorization_code', code_verifier: pend.verifier }) });
  const tok = await resp.json().catch(() => ({}));
  if (!resp.ok || !tok.id_token) throw new UserError('Não foi possível concluir o login com o Google. Tente novamente.');
  // id_token recebido diretamente do endpoint do Google por TLS: a especificação OIDC dispensa a checagem da assinatura neste caso.
  const claims = JSON.parse(Buffer.from(String(tok.id_token).split('.')[1] || '', 'base64url').toString('utf8') || '{}');
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== config.google.clientId
    || !(claims.exp * 1000 > Date.now()) || claims.nonce !== pend.nonce) throw new UserError('Resposta do Google inválida. Tente novamente.');
  return { sub: String(claims.sub), email: claims.email, name: claims.name, emailVerified: claims.email_verified === true || claims.email_verified === 'true' };
}

function takeState(req) {
  const state = String(req.query.state || req.body?.state || '');
  const pend = pendingGoogle.get(state);
  pendingGoogle.delete(state);
  if (!state || !pend || pend.exp < Date.now() || req.cookies.g_state !== state) throw new UserError('O login com o Google expirou ou não foi iniciado neste navegador. Tente novamente.');
  return pend;
}

/** Entra, vincula ou encaminha para a criação de conta. */
async function finishGoogle(req, res, profile, pend) {
  res.clearCookie('g_state', { path: '/' });
  if (!profile.emailVerified || !isEmail(profile.email || '')) throw new UserError('Sua conta Google não tem e-mail verificado. Use o cadastro com e-mail e senha.');
  const email = profile.email.trim().toLowerCase();
  const dest = pend.perfil === 'organizador' ? '/organizador/cadastro' : safeBack(pend.volta, '/minha-conta');
  let user = await db.one("SELECT u.* FROM user_identities i JOIN users u ON u.id=i.user_id WHERE i.provider='google' AND i.subject=?", profile.sub);
  if (!user) {
    user = await db.one('SELECT * FROM users WHERE email=?', email);
    if (user) { // mesmo e-mail, já verificado pelo Google: vincula à conta existente
      await db.run("INSERT INTO user_identities(user_id,provider,subject,email) VALUES(?,'google',?,?)", user.id, profile.sub, email);
      if (!user.email_verified_at) await db.run('UPDATE users SET email_verified_at=? WHERE id=?', new Date().toISOString(), user.id);
      await audit(req, 'user.google_linked', { userId: user.id, entity: 'user', entityId: user.id });
    }
  }
  if (user) {
    if (user.status !== 'active') { res.flash('error', 'Conta suspensa. Entre em contato com o suporte.'); return res.redirect(303, '/entrar'); }
    await db.run("UPDATE user_identities SET last_login_at=? WHERE provider='google' AND subject=?", new Date().toISOString(), profile.sub);
    await startSession(req, res, user);
    await audit(req, 'user.login', { userId: user.id, detail: { via: 'google' } });
    return res.redirect(303, dest);
  }
  // Conta nova: falta aceitar os termos (consentimento não pode ser presumido)
  sweep(pendingSignup);
  const t = randomToken(24);
  pendingSignup.set(t, { profile: { ...profile, email }, volta: pend.volta, perfil: pend.perfil, exp: Date.now() + 15 * 60000 });
  return res.redirect(303, `/cadastro/google?t=${t}`);
}

r.get('/entrar/google/retorno', async (req, res) => {
  if (config.google.mode !== 'live') throw new UserError('Login com Google indisponível.', 404);
  if (req.query.error) { res.flash('info', 'Login com o Google cancelado.'); return res.redirect(303, '/entrar'); }
  const pend = takeState(req);
  await finishGoogle(req, res, await googleProfile(String(req.query.code || ''), pend), pend);
});

function googleSignupForm(req, t, p, errors = []) {
  return html`<section class="card narrow"><h1>Criar conta</h1>
  <div class="google-id">${raw(G_LOGO)}<div><strong>${p.name || p.email}</strong><br><span class="muted">${p.email}</span></div></div>
  ${errorsBox(errors)}
  <form method="post" action="/cadastro/google">${csrf(req)}<input type="hidden" name="t" value="${t}">
  ${field('name', 'Nome completo', { value: p.name, required: true, attrs: 'autocomplete="name"' })}
  ${field('accept', html`Li e aceito os <a href="/legal/terms" target="_blank">Termos de Uso</a> (v. ${LEGAL.terms.version}) e a <a href="/legal/privacy" target="_blank">Política de Privacidade</a> (v. ${LEGAL.privacy.version})`, { type: 'checkbox', required: true })}
  ${field('marketing', 'Quero receber novidades e divulgação de eventos por e-mail (opcional, pode cancelar a qualquer momento)', { type: 'checkbox' })}
  <button class="btn btn-block">Criar minha conta</button></form>
  <p class="center muted">Você vai entrar sempre com o Google. Se quiser, depois pode criar uma senha em "Esqueci minha senha".</p></section>`;
}
r.get('/cadastro/google', (req, res) => {
  const p = pendingSignup.get(String(req.query.t || ''));
  if (!p || p.exp < Date.now()) throw new UserError('Este cadastro expirou. Clique de novo em "Continuar com o Google".');
  res.page({ title: 'Criar conta', body: googleSignupForm(req, req.query.t, p.profile) });
});
r.post('/cadastro/google', async (req, res) => {
  const t = String(req.body.t || ''); const p = pendingSignup.get(t);
  if (!p || p.exp < Date.now()) throw new UserError('Este cadastro expirou. Clique de novo em "Continuar com o Google".');
  const name = String(req.body.name || '').trim(); const errors = [];
  if (name.length < 3) errors.push('Informe seu nome completo.');
  if (!req.body.accept) errors.push('É necessário aceitar os Termos de Uso e a Política de Privacidade.');
  if (errors.length) return res.status(400).page({ title: 'Criar conta', body: googleSignupForm(req, t, { ...p.profile, name }, errors) });
  pendingSignup.delete(t);
  const user = await db.tx(async () => {
    const existing = await db.one('SELECT * FROM users WHERE email=?', p.profile.email);
    const id = existing ? existing.id : Number((await db.run('INSERT INTO users(email,name,password_hash,email_verified_at,marketing_opt_in) VALUES(?,?,?,?,?)',
      p.profile.email, name, '!google', new Date().toISOString(), req.body.marketing ? 1 : 0)).lastInsertRowid); // sem senha: '!google' nunca confere
    await db.run("INSERT INTO user_identities(user_id,provider,subject,email,last_login_at) VALUES(?,'google',?,?,?) ON CONFLICT DO NOTHING", id, p.profile.sub, p.profile.email, new Date().toISOString());
    return await db.one('SELECT * FROM users WHERE id=?', id);
  });
  await recordConsent(req, user.id, 'terms', 'signup_google'); await recordConsent(req, user.id, 'privacy', 'signup_google');
  if (req.body.marketing) await recordConsent(req, user.id, 'marketing', 'signup_google');
  await audit(req, 'user.signup', { userId: user.id, entity: 'user', entityId: user.id, detail: { via: 'google' } });
  await startSession(req, res, user, 'athlete');
  res.flash('success', 'Conta criada com o Google!');
  res.redirect(303, p.perfil === 'organizador' ? '/organizador/cadastro' : safeBack(p.volta, '/minha-conta'));
});

// Simulador do Google (somente fora de produção, sem credenciais): mesma validação de state e mesmo final.
r.get('/dev/google', (req, res) => {
  if (config.google.mode !== 'simulator') throw new UserError('Simulador desativado.', 404);
  res.page({ title: 'Google (simulado)', body: html`<section class="card narrow"><p><span class="badge badge-warn">DEMONSTRAÇÃO — não é o Google</span></p><h1>Escolha uma conta</h1>
  <p class="muted">Sem credenciais do Google configuradas, este simulador substitui a tela de login do Google. Informe a conta que o "Google" devolveria.</p>
  <form method="post" action="/dev/google">${csrf(req)}<input type="hidden" name="state" value="${req.query.state || ''}">
  ${field('email', 'E-mail da conta Google', { type: 'email', required: true })}${field('name', 'Nome', { required: true })}
  <button class="btn btn-block">Continuar</button></form></section>` });
});
r.post('/dev/google', async (req, res) => {
  if (config.google.mode !== 'simulator') throw new UserError('Simulador desativado.', 404);
  const pend = takeState(req);
  const email = String(req.body.email || '').trim().toLowerCase();
  await finishGoogle(req, res, { sub: `sim-${email}`, email, name: String(req.body.name || '').trim(), emailVerified: true }, pend);
});

module.exports = r;
module.exports.startSession = startSession;
module.exports.googleButton = googleButton;
module.exports.sendVerification = sendVerification;
