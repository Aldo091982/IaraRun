'use strict';
// Varredura: todas as telas principais carregam para cada perfil com os dados de demonstração.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const { seed, PASSWORD } = require('../scripts/seed');

before(async () => { await h.start(); await seed(); });
after(h.stop);

async function as(email, ctx) {
  const c = new h.Client();
  await c.post('/entrar', { email, password: PASSWORD });
  if (ctx) await c.post('/contexto', { context: ctx });
  return c;
}
async function crawl(c, urls) {
  for (const u of urls) { const r = await c.get(u); assert.equal(r.status, 200, `${u} → ${r.status}\n${r.text.slice(0, 400)}`); assert.doesNotMatch(r.text, /erro inesperado/i, u); }
}

test('telas públicas', async () => {
  const ev = await db.one("SELECT * FROM events WHERE slug='demo-corrida-da-cidade'");
  await crawl(new h.Client(), ['/', '/eventos', '/eventos?passados=1&dist=0-5', `/e/${ev.slug}`, '/e/demo-desafio-de-outono/resultados', '/organizadores', '/cadastro', '/cadastro?perfil=organizador', '/entrar', '/recuperar-acesso', '/api/docs', '/legal/privacy']);
});
test('telas do atleta', async () => {
  const c = await as('atleta@demo.invalid');
  await crawl(c, ['/minha-conta', '/minha-conta/historico', '/minha-conta/favoritos', '/minha-conta/perfil', '/minha-conta/preferencias', '/e/demo-corrida-da-cidade/inscricao', '/e/demo-corrida-da-cidade/inscricao?n=3', '/minha-agenda.ics']);
  const reg = await db.one("SELECT id FROM registrations WHERE user_id=(SELECT id FROM users WHERE email='atleta@demo.invalid')");
  await crawl(c, [`/minha-conta/certificado/${reg.id}`, `/minha-conta/inscricao/${reg.id}/servicos`]);
});
test('telas do organizador', async () => {
  const org = await db.one("SELECT id FROM organizations WHERE cnpj='11222333000181'");
  const c = await as('organizador@demo.invalid', `org:${org.id}`);
  const evs = await db.all('SELECT id FROM events WHERE org_id=?', org.id);
  const urls = ['/organizador', '/organizador/eventos', '/organizador/financeiro', '/organizador/financeiro.csv', '/organizador/equipe', '/organizador/empresa', '/organizador/empresa/documentos', '/organizador/recebimentos', '/organizador/suporte', '/organizador/eventos/novo'];
  for (const e of evs) { urls.push(`/organizador/eventos/${e.id}`, `/organizador/eventos/${e.id}/inscritos`, `/organizador/eventos/${e.id}/inscritos.csv`, `/organizador/eventos/${e.id}/solicitacoes`, `/organizador/eventos/${e.id}/comunicacao`, `/organizador/eventos/${e.id}/checkin?q=1`, `/organizador/eventos/${e.id}/resultados`); for (let s = 1; s <= 9; s++) urls.push(`/organizador/eventos/${e.id}/editar?etapa=${s}`); }
  await crawl(c, urls);
});
test('telas da administração', async () => {
  const c = await as('admin@demo.invalid', 'admin');
  const org = await db.one("SELECT id FROM organizations WHERE cnpj='11222333000181'");
  await crawl(c, ['/admin', '/admin/organizadores', `/admin/organizadores/${org.id}`, '/admin/usuarios', '/admin/eventos', '/admin/suporte', '/admin/parametros', '/admin/integracoes', '/admin/auditoria', '/dev/caixa-de-saida']);
});

test('números da página inicial contam dados reais e ignoram a demonstração', async () => {
  const { platformStats } = require('../src/routes/public');
  platformStats.reset();
  const before = await platformStats();
  // um organizador ativo e um evento já realizado com uma inscrição confirmada
  const u = Number((await db.run("INSERT INTO users(email,name,password_hash) VALUES('numeros@teste.local','Números','x')")).lastInsertRowid);
  const org = Number((await db.run("INSERT INTO organizations(cnpj,legal_name,status) VALUES('99888777000155','Org Números','active')")).lastInsertRowid);
  const ev = Number((await db.run("INSERT INTO events(org_id,slug,name,status,start_utc) VALUES(?, 'numeros-passado', 'Prova Passada', 'completed', '2020-01-01T10:00:00Z')", org)).lastInsertRowid);
  const mod = Number((await db.run("INSERT INTO modalities(event_id,name) VALUES(?, '5 km')", ev)).lastInsertRowid);
  const ord = Number((await db.run("INSERT INTO orders(code,user_id,event_id,status) VALUES('PNUM1',?,?,'free')", u, ev)).lastInsertRowid);
  await db.run("INSERT INTO registrations(order_id,event_id,modality_id,buyer_user_id,name,status,qr_token) VALUES(?,?,?,?,'Atleta','confirmed','qr-numeros-1')", ord, ev, mod, u);
  // dados de demonstração não entram
  const demoOrg = Number((await db.run("INSERT INTO organizations(cnpj,legal_name,status,is_demo) VALUES('99888777000156','Demo','active',1)")).lastInsertRowid);
  await db.run("INSERT INTO events(org_id,slug,name,status,start_utc,is_demo) VALUES(?, 'numeros-demo', 'Demo', 'completed', '2020-01-01T10:00:00Z', 1)", demoOrg);
  await db.run("INSERT INTO users(email,name,password_hash,is_demo) VALUES('demo-numeros@demo.invalid','Demo','x',1)");
  platformStats.reset();
  const after = await platformStats();
  assert.equal(after.events_done - before.events_done, 1);
  assert.equal(after.organizers - before.organizers, 1);
  assert.equal(after.athletes - before.athletes, 1);
  assert.equal(after.registrations - before.registrations, 1);
  platformStats.reset();
  const home = await new h.Client().get('/');
  assert.match(home.text, /Nossa história em números/);
  assert.match(home.text, /Inscrições realizadas/);
});
