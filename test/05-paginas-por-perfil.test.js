'use strict';
// Varredura: todas as telas principais carregam para cada perfil com os dados de demonstração.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;
const { seed, PASSWORD } = require('../scripts/seed');

before(async () => { await h.start(); seed(); });
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
  const ev = db.one("SELECT * FROM events WHERE slug='demo-corrida-da-cidade'");
  await crawl(new h.Client(), ['/', '/eventos', '/eventos?passados=1&dist=0-5', `/e/${ev.slug}`, '/e/demo-desafio-de-outono/resultados', '/organizadores', '/cadastro', '/cadastro?perfil=organizador', '/entrar', '/recuperar-acesso', '/api/docs', '/legal/privacy']);
});
test('telas do atleta', async () => {
  const c = await as('atleta@demo.invalid');
  await crawl(c, ['/minha-conta', '/minha-conta/historico', '/minha-conta/favoritos', '/minha-conta/perfil', '/minha-conta/preferencias', '/e/demo-corrida-da-cidade/inscricao', '/e/demo-corrida-da-cidade/inscricao?n=3', '/minha-agenda.ics']);
  const reg = db.one("SELECT id FROM registrations WHERE user_id=(SELECT id FROM users WHERE email='atleta@demo.invalid')");
  await crawl(c, [`/minha-conta/certificado/${reg.id}`, `/minha-conta/inscricao/${reg.id}/servicos`]);
});
test('telas do organizador', async () => {
  const org = db.one("SELECT id FROM organizations WHERE cnpj='11222333000181'");
  const c = await as('organizador@demo.invalid', `org:${org.id}`);
  const evs = db.all('SELECT id FROM events WHERE org_id=?', org.id);
  const urls = ['/organizador', '/organizador/eventos', '/organizador/financeiro', '/organizador/financeiro.csv', '/organizador/equipe', '/organizador/empresa', '/organizador/empresa/documentos', '/organizador/recebimentos', '/organizador/suporte', '/organizador/eventos/novo'];
  for (const e of evs) { urls.push(`/organizador/eventos/${e.id}`, `/organizador/eventos/${e.id}/inscritos`, `/organizador/eventos/${e.id}/inscritos.csv`, `/organizador/eventos/${e.id}/solicitacoes`, `/organizador/eventos/${e.id}/comunicacao`, `/organizador/eventos/${e.id}/checkin?q=1`, `/organizador/eventos/${e.id}/resultados`); for (let s = 1; s <= 9; s++) urls.push(`/organizador/eventos/${e.id}/editar?etapa=${s}`); }
  await crawl(c, urls);
});
test('telas da administração', async () => {
  const c = await as('admin@demo.invalid', 'admin');
  const org = db.one("SELECT id FROM organizations WHERE cnpj='11222333000181'");
  await crawl(c, ['/admin', '/admin/organizadores', `/admin/organizadores/${org.id}`, '/admin/usuarios', '/admin/eventos', '/admin/suporte', '/admin/parametros', '/admin/integracoes', '/admin/auditoria', '/dev/caixa-de-saida']);
});
