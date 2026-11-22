'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plataforma-test-'));
process.env.APP_ENV = 'test';
process.env.SKIP_ENV_FILE = '1';
// Cada arquivo de teste usa um banco PostgreSQL próprio e temporário, apagado ao final.
// Servidor: TEST_DATABASE_URL (sem o nome do banco), ou o PostgreSQL local de testes (scripts/pg-local.js).
const pgLocal = require('../scripts/pg-local');
const DB_NAME = `plataforma_test_${process.pid}_${Date.now().toString(36)}`;
const serverUrl = process.env.TEST_DATABASE_URL ? new URL(process.env.TEST_DATABASE_URL) : new URL(pgLocal.url('test'));
serverUrl.pathname = `/${DB_NAME}`;
process.env.DATABASE_URL = serverUrl.toString();
process.env.DB_CREATE = '1';
process.env.PRIVATE_STORAGE_DIR = path.join(tmp, 'private');
process.env.PUBLIC_UPLOAD_DIR = path.join(tmp, 'public');
process.env.MP_ACCESS_TOKEN = '';

const { createApp } = require('../src/app');
const db = require('../src/db');
const { hashPassword } = require('../src/lib/core');

let server, base, starting;
function start() {
  starting ||= (process.env.TEST_DATABASE_URL ? Promise.resolve() : pgLocal.start('test'))
    .then(() => createApp())
    .then((app) => new Promise((res) => {
      server = app.listen(0, () => { base = `http://127.0.0.1:${server.address().port}`; res(base); });
    }));
  return starting;
}
async function stop() { if (server) server.close(); server = null; await db.dropTestDatabase(); }

// Arquivos mínimos válidos (assinaturas reais)
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6300010000050001', 'hex');
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');

class Client {
  constructor() { this.jar = {}; }
  cookie() { return Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join('; '); }
  store(res) {
    for (const c of res.headers.getSetCookie?.() || []) {
      const [kv] = c.split(';'); const i = kv.indexOf('='); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Expires=Thu, 01 Jan 1970/.test(c) || v === '') delete this.jar[k]; else this.jar[k] = v;
    }
  }
  async req(method, url, { form, multipart, headers = {}, follow = true } = {}) {
    if (!this.jar.csrf) { const r0 = await fetch(base + '/entrar', { headers: { cookie: this.cookie() } }); this.store(r0); await r0.text(); }
    let body;
    if (form) body = new URLSearchParams({ _csrf: decodeURIComponent(this.jar.csrf), ...flatten(form) });
    if (multipart) {
      body = new FormData(); body.append('_csrf', decodeURIComponent(this.jar.csrf));
      for (const [k, v] of Object.entries(multipart)) { if (v && v.buffer) body.append(k, new Blob([v.buffer], { type: v.type }), v.name); else body.append(k, String(v)); }
    }
    let res = await fetch(base + url, { method, body, headers: { cookie: this.cookie(), ...headers }, redirect: 'manual' });
    this.store(res);
    let hops = 0;
    while (follow && res.status >= 300 && res.status < 400 && hops++ < 6) {
      const loc = res.headers.get('location'); await res.text();
      res = await fetch(new URL(loc, base + url), { headers: { cookie: this.cookie() }, redirect: 'manual' });
      this.store(res);
    }
    const text = await res.text();
    return { status: res.status, text, url: res.url, location: res.headers.get('location') };
  }
  get(url, o) { return this.req('GET', url, o); }
  post(url, form, o = {}) { return this.req('POST', url, { form, ...o }); }
  postMultipart(url, multipart) { return this.req('POST', url, { multipart }); }
}
function flatten(obj, prefix = '', out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out); else if (v !== undefined && v !== null) out[key] = String(v);
  }
  return out;
}
const lastMailTo = async (email) => await db.one('SELECT * FROM outbox WHERE to_email=? ORDER BY id DESC', email);
const tokenFrom = (mail, pathStr) => new RegExp(`${pathStr}\\?t=([A-Za-z0-9_-]+)`).exec(mail.body)[1];

async function signup(c, { name, email, perfil }) {
  await c.post('/cadastro', { name, email, password: 'senha-segura-123', accept: 1, perfil: perfil || '' });
  const mail = await lastMailTo(email);
  return tokenFrom(mail, '/confirmar-email');
}
async function verifyEmail(c, email) { const t = tokenFrom(await db.one("SELECT * FROM outbox WHERE to_email=? AND subject ILIKE 'Confirme%' ORDER BY id DESC", email), '/confirmar-email'); return c.get(`/confirmar-email?t=${t}`); }

async function makeAdmin(email = 'admin@teste.local') {
  if (!await db.one('SELECT 1 FROM users WHERE email=?', email)) await db.run('INSERT INTO users(email,name,password_hash,is_admin,email_verified_at) VALUES(?,?,?,1,?)', email, 'Admin Teste', hashPassword('senha-segura-123'), new Date().toISOString());
  return email;
}
async function login(c, email) { const r = await c.post('/entrar', { email, password: 'senha-segura-123' }); return r; }

// CNPJs válidos de teste (dígitos verificadores corretos)
function cnpjFrom(base12) {
  const c = String(base12).padStart(12, '0').split('').map(Number);
  const dv = (arr, w) => { const s = arr.reduce((a, d, i) => a + d * w[i], 0) % 11; return s < 2 ? 0 : 11 - s; };
  const d1 = dv(c, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]); const d2 = dv([...c, d1], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return c.join('') + d1 + d2;
}
function cpfFrom(base9) {
  const c = String(base9).padStart(9, '0').split('').map(Number);
  const dv = (arr) => { const n = arr.length + 1; const s = arr.reduce((a, d, i) => a + d * (n - i), 0); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  const d1 = dv(c); const d2 = dv([...c, d1]);
  return c.join('') + d1 + d2;
}

module.exports = { start, stop, Client, db, PNG, PDF, lastMailTo, tokenFrom, signup, verifyEmail, makeAdmin, login, cnpjFrom, cpfFrom, tmp };
