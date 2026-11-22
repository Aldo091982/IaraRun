'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const config = require('../src/config');

before(h.start);
after(h.stop);

const stateOf = (r) => decodeURIComponent(/state=([^&"]+)/.exec(r.location || r.url)[1]);

test('telas de entrar e criar conta mostram "Continuar com o Google"', async () => {
  const c = new h.Client();
  assert.match((await c.get('/entrar')).text, /Continuar com o Google/);
  assert.match((await c.get('/cadastro')).text, /Continuar com o Google/);
});

test('conta nova pelo Google exige aceite dos termos e já nasce com e-mail verificado', async () => {
  const c = new h.Client();
  const start = await c.get('/entrar/google?volta=/eventos', { follow: false });
  const state = stateOf(start);
  const pick = await c.post('/dev/google', { state, email: 'Nova.Google@Teste.local', name: 'Nova Pelo Google' });
  assert.match(pick.url, /\/cadastro\/google\?t=/);
  assert.equal(db.one('SELECT COUNT(*) n FROM users WHERE email=?', 'nova.google@teste.local').n, 0, 'nada é criado antes do aceite');
  const t = /\?t=([^&]+)/.exec(pick.url)[1];
  const noAccept = await c.post('/cadastro/google', { t, name: 'Nova Pelo Google' });
  assert.equal(noAccept.status, 400);
  assert.match(noAccept.text, /aceitar os Termos/);
  const done = await c.post('/cadastro/google', { t, name: 'Nova Pelo Google', accept: 1 });
  assert.match(done.url, /\/eventos$/);
  const u = db.one('SELECT * FROM users WHERE email=?', 'nova.google@teste.local');
  assert.ok(u.email_verified_at);
  assert.equal(u.marketing_opt_in, 0);
  assert.ok(db.one("SELECT 1 FROM consents WHERE user_id=? AND doc_key='terms'", u.id));
  assert.ok(db.one("SELECT 1 FROM user_identities WHERE user_id=? AND provider='google'", u.id));
  // a conta criada pelo Google não aceita senha nenhuma
  const pw = await new h.Client().post('/entrar', { email: u.email, password: '!google' });
  assert.match(pw.text, /incorretos/);
  // segundo acesso entra direto
  const c2 = new h.Client();
  const s2 = stateOf(await c2.get('/entrar/google', { follow: false }));
  const again = await c2.post('/dev/google', { state: s2, email: u.email, name: 'x' });
  assert.match(again.url, /\/minha-conta$/);
});

test('e-mail já cadastrado é vinculado à conta existente, sem duplicar', async () => {
  const c = new h.Client();
  await h.signup(c, { name: 'Atleta Senha', email: 'vinculo@teste.local' });
  const g = new h.Client();
  const s = stateOf(await g.get('/entrar/google', { follow: false }));
  const r = await g.post('/dev/google', { state: s, email: 'vinculo@teste.local', name: 'Atleta Senha' });
  assert.match(r.url, /\/minha-conta$/);
  assert.equal(db.one('SELECT COUNT(*) n FROM users WHERE email=?', 'vinculo@teste.local').n, 1);
  const u = db.one('SELECT * FROM users WHERE email=?', 'vinculo@teste.local');
  assert.ok(u.email_verified_at, 'Google confirma o e-mail');
  assert.ok(db.one("SELECT 1 FROM user_identities WHERE user_id=? AND provider='google'", u.id));
});

test('state inválido, reutilizado ou de outro navegador é recusado', async () => {
  const a = new h.Client(); const b = new h.Client();
  const s = stateOf(await a.get('/entrar/google', { follow: false }));
  const other = await b.post('/dev/google', { state: s, email: 'x@teste.local', name: 'X Y Z' });
  assert.equal(other.status, 400, 'state iniciado em outro navegador');
  const s2 = stateOf(await a.get('/entrar/google', { follow: false }));
  await a.post('/dev/google', { state: s2, email: 'reuso@teste.local', name: 'Reuso' });
  const reuse = await a.post('/dev/google', { state: s2, email: 'reuso@teste.local', name: 'Reuso' });
  assert.equal(reuse.status, 400, 'state de uso único');
});

test('Google real: confere emissor, público, nonce e e-mail verificado', async (t) => {
  const realFetch = global.fetch; const saved = { ...config.google };
  t.after(() => { global.fetch = realFetch; Object.assign(config.google, saved); });
  Object.assign(config.google, { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'sec', mode: 'live' });
  let claims = {};
  global.fetch = async (url, opts) => {
    if (!String(url).startsWith('https://oauth2.googleapis.com/token')) return realFetch(url, opts);
    const body = new URLSearchParams(opts.body);
    assert.ok(body.get('code_verifier'), 'PKCE enviado');
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return new Response(JSON.stringify({ id_token: `${enc({ alg: 'RS256' })}.${enc(claims)}.sig`, access_token: 'at' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c = new h.Client();
  const start = await c.get('/entrar/google', { follow: false });
  assert.match(start.location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(start.location, /code_challenge_method=S256/);
  const url = new URL(start.location);
  const base = { iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Math.floor(Date.now() / 1000) + 300, nonce: url.searchParams.get('nonce'), sub: 'g-123', email: 'real.google@teste.local', email_verified: true, name: 'Real Google' };

  claims = { ...base, nonce: 'outro' };
  const bad = await c.get(`/entrar/google/retorno?code=abc&state=${url.searchParams.get('state')}`);
  assert.equal(bad.status, 400, 'nonce divergente recusado');

  const s2 = new URL((await c.get('/entrar/google', { follow: false })).location);
  claims = { ...base, nonce: s2.searchParams.get('nonce'), email_verified: false };
  const unverified = await c.get(`/entrar/google/retorno?code=abc&state=${s2.searchParams.get('state')}`);
  assert.match(unverified.text, /não tem e-mail verificado/);

  const s3 = new URL((await c.get('/entrar/google', { follow: false })).location);
  claims = { ...base, nonce: s3.searchParams.get('nonce') };
  const ok = await c.get(`/entrar/google/retorno?code=abc&state=${s3.searchParams.get('state')}`);
  assert.match(ok.url, /\/cadastro\/google\?t=/);
});
