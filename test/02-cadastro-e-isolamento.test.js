'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { everyAsync } = require('../src/lib/util');
const { db } = h;
const cnpjProvider = require('../src/lib/cnpjProvider');
const config = require('../src/config');

before(h.start);
after(h.stop);

test('retomada do cadastro e preservação de dados entre etapas', async () => {
  const c = new h.Client(); const email = 'retoma@teste.local';
  await h.signup(c, { name: 'Pessoa Retoma', email, perfil: 'organizador' });
  await c.post('/organizador/cadastro/1', { acao: 'avancar' });
  const cnpj = h.cnpjFrom('998877660');
  const r = await c.postMultipart('/organizador/cadastro/2', { acao: 'salvar', cnpj, legal_name: 'Retoma LTDA', trade_name: 'Retoma Esportes', city: 'Recife', state: 'PE', link_role: 'titular_mei' });
  assert.match(r.url, /minha-conta/);
  assert.match(r.text, /cadastro de organizador em andamento/);
  // Novo login (outra sessão) retoma do servidor
  const c2 = new h.Client(); await h.login(c2, email);
  const back = await c2.get('/organizador/cadastro?etapa=2');
  assert.match(back.text, /Retoma LTDA/);
  assert.match(back.text, /Recife/);
  assert.match(back.text, /Preenchimento manual/);
  // Não permite pular para a revisão sem passar pelas etapas
  const skip = await c2.get('/organizador/cadastro?etapa=4');
  assert.doesNotMatch(skip.text, /Etapa 4 de 4/);
  // Conclusão com pendências é recusada com lista do que falta
  await db.run('UPDATE onboarding_drafts SET step=4 WHERE user_id=(SELECT id FROM users WHERE email=?)', email);
  const done = await c2.post('/organizador/cadastro/4', { acao: 'concluir' });
  assert.match(done.text, /Documento oficial do responsável/);
  assert.match(done.text, /E-mail e telefone de atendimento/);
  assert.equal((await db.one('SELECT status FROM organizations WHERE cnpj=?', cnpj)).status, 'onboarding');
});

test('CNPJ inválido, já cadastrado (sem assumir empresa) e solicitação de acesso', async () => {
  const o = await f.organizer({ approve: false, payments: false });
  const c = new h.Client(); await h.signup(c, { name: 'Intruso', email: 'intruso@teste.local', perfil: 'organizador' });
  await c.post('/organizador/cadastro/1', { acao: 'avancar' });
  const bad = await c.postMultipart('/organizador/cadastro/2', { acao: 'buscar', cnpj: '11.111.111/1111-11' });
  assert.match(bad.text, /CNPJ inválido/);
  const dup = await c.postMultipart('/organizador/cadastro/2', { acao: 'avancar', cnpj: o.org.cnpj, legal_name: 'X', trade_name: 'X', city: 'X', state: 'SP', link_role: 'socio' });
  assert.match(dup.text, /já está cadastrada/);
  assert.equal((await db.one('SELECT COUNT(*) n FROM org_members WHERE org_id=?', o.org.id)).n, 1, 'não vira membro só com o CNPJ');
  await c.post('/organizador/cadastro/solicitar-acesso', { org_id: o.org.id, message: 'Sou sócio e preciso de acesso ao painel.' });
  assert.equal((await db.one("SELECT COUNT(*) n FROM org_access_requests WHERE org_id=? AND status='pending'", o.org.id)).n, 1);
  assert.ok(await db.one("SELECT 1 FROM outbox WHERE to_email=? AND subject ILIKE 'Solicitação de acesso%'", o.email));
});

test('consulta cadastral: não configurada, indisponível, não encontrada e sucesso', async () => {
  const valid = h.cnpjFrom('123123123');
  assert.equal((await cnpjProvider.lookup(valid)).error, 'not_configured');
  const prev = { ...config.cnpj };
  Object.assign(config.cnpj, { provider: 'http', url: 'https://fornecedor.invalid/{cnpj}', name: 'Teste' });
  try {
    assert.equal((await cnpjProvider.lookup(valid, { fetchImpl: async () => { throw new Error('down'); } })).error, 'unavailable');
    assert.equal((await cnpjProvider.lookup(valid, { fetchImpl: async () => ({ status: 404, ok: false }) })).error, 'not_found');
    assert.equal((await cnpjProvider.lookup(valid, { fetchImpl: async () => ({ status: 503, ok: false }) })).error, 'unavailable');
    const ok = await cnpjProvider.lookup(valid, { fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ razao_social: 'EMPRESA SA', nome_fantasia: 'EMP', descricao_situacao_cadastral: 'ATIVA', municipio: 'SAO PAULO', uf: 'SP' }) }) });
    assert.equal(ok.data.legal_name, 'EMPRESA SA');
    assert.equal(ok.data.address.state, 'SP');
    assert.equal(ok.source, 'provider:Teste');
  } finally { Object.assign(config.cnpj, prev); }
});

test('isolamento: outra empresa, documentos privados, exportações e API', async () => {
  const A = await f.organizer({ label: 'Alfa' });
  const B = await f.organizer({ label: 'Beta' });
  const evA = await f.event(A.c, { publish: false });
  // B não acessa evento, inscritos, exportação nem edição de A
  for (const url of [`/organizador/eventos/${evA.id}`, `/organizador/eventos/${evA.id}/inscritos`, `/organizador/eventos/${evA.id}/inscritos.csv`, `/organizador/eventos/${evA.id}/editar`, `/organizador/eventos/${evA.id}/resultados`]) {
    const r = await B.c.get(url);
    assert.equal(r.status, 404, url);
  }
  const p = await B.c.post(`/organizador/eventos/${evA.id}/itens/lot`, { name: 'hack', price: '1' });
  assert.equal(p.status, 404);
  assert.equal((await db.one("SELECT COUNT(*) n FROM lots WHERE event_id=? AND name='hack'", evA.id)).n, 0);
  // Rascunho de A não é público
  const anon = new h.Client();
  assert.equal((await anon.get(`/e/${evA.slug}`)).status, 404);
  // Documentos privados: não servidos pela pasta pública; rota admin exige perfil de administração
  const doc = await db.one('SELECT * FROM documents WHERE org_id=?', A.org.id);
  assert.equal((await anon.get(`/media/${doc.storage_key}`)).status, 404);
  const tryDoc = await B.c.get(`/admin/documentos/${doc.id}`);
  assert.equal(tryDoc.status, 403);
  const admin = new h.Client(); await h.login(admin, await h.makeAdmin()); await admin.post('/contexto', { context: 'admin' });
  const ok = await admin.get(`/admin/documentos/${doc.id}`);
  assert.equal(ok.status, 200);
  assert.ok(await db.one("SELECT 1 FROM audit_log WHERE action='document.viewed' AND entity_id=?", String(doc.id)), 'consulta registrada');
  // Não pode trocar para o contexto de empresa da qual não é membro
  const ctx = await B.c.post('/contexto', { context: `org:${A.org.id}` });
  assert.equal(ctx.status, 403);
  // API: chave de B não lê eventos de A
  const keyPage = await B.c.post('/organizador/api-key', {});
  const key = /(org_\d+_[A-Za-z0-9_-]+)/.exec(keyPage.text)[1];
  const base = await h.start();
  const res = await fetch(`${base}/api/v1/events/${evA.id}/registrations`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(res.status, 404);
  const own = await fetch(`${base}/api/v1/events`, { headers: { Authorization: `Bearer ${key}` } }).then((x) => x.json());
  assert.ok(await everyAsync(own.data, async (e) => (await db.one('SELECT org_id FROM events WHERE id=?', e.id)).org_id === B.org.id));
  assert.equal((await fetch(`${base}/api/v1/events`, { headers: { Authorization: 'Bearer invalida' } })).status, 401);
});

test('colaborador acessa somente funções e eventos autorizados', async () => {
  const o = await f.organizer();
  const ev1 = await f.event(o.c, { publish: false });
  const ev2 = await f.event(o.c, { publish: false });
  const col = new h.Client(); await h.signup(col, { name: 'Operador Kits', email: 'operador@teste.local' });
  await o.c.post('/organizador/equipe', { email: 'operador@teste.local', perm_kits: 1, [`ev_${ev1.id}`]: 1 });
  await col.post('/contexto', { context: `org:${o.org.id}` });
  assert.equal((await col.get(`/organizador/eventos/${ev1.id}/checkin`)).status, 200);
  assert.equal((await col.get(`/organizador/eventos/${ev2.id}/checkin`)).status, 403);
  assert.equal((await col.get(`/organizador/eventos/${ev1.id}/inscritos`)).status, 403);
  assert.equal((await col.get('/organizador/financeiro')).status, 403);
  assert.equal((await col.get(`/organizador/eventos/${ev1.id}/editar`)).status, 403);
});

test('mesmo usuário com perfis de atleta e organizador, alternando contexto', async () => {
  const a = await f.athlete();
  await a.c.get('/organizador/cadastro');
  const r = await a.c.post('/organizador/cadastro/1', { acao: 'avancar' });
  assert.match(r.text, /Empresa e documentação/);
  assert.equal((await db.one('SELECT COUNT(*) n FROM users WHERE email=?', a.email)).n, 1);
});

test('pendências bloqueiam publicação; evento gratuito publica sem integração financeira', async () => {
  const o = await f.organizer({ payments: false });
  const draft = await f.event(o.c, { publish: false });
  await db.run('UPDATE events SET regulation=NULL WHERE id=?', draft.id);
  const rv = await o.c.get(`/organizador/eventos/${draft.id}/editar?etapa=9`);
  assert.match(rv.text, /Adicione o regulamento/);
  assert.match(rv.text, /configure o recebimento/);
  const free = await f.event(o.c, { price: '0', publish: true });
  assert.equal(free.status, 'published');
  const a = await f.athlete();
  const { order } = await f.register(a, free);
  assert.equal(order.status, 'free');
  assert.equal((await db.one('SELECT status FROM registrations WHERE order_id=?', order.id)).status, 'confirmed');
});

test('duplicar evento como rascunho sem inscrições, transações ou resultados', async () => {
  const o = await f.organizer();
  const ev = await f.event(o.c, { price: '0' });
  const a = await f.athlete(); await f.register(a, ev);
  await o.c.post(`/organizador/eventos/${ev.id}/duplicar`, {});
  const copy = await db.one('SELECT * FROM events WHERE org_id=? AND id<>? ORDER BY id DESC', o.org.id, ev.id);
  assert.equal(copy.status, 'draft');
  assert.equal((await db.one('SELECT COUNT(*) n FROM registrations WHERE event_id=?', copy.id)).n, 0);
  assert.equal((await db.one('SELECT COUNT(*) n FROM orders WHERE event_id=?', copy.id)).n, 0);
  assert.equal((await db.one('SELECT COUNT(*) n FROM modalities WHERE event_id=?', copy.id)).n, 2);
  assert.ok((await db.one('SELECT COUNT(*) n FROM lots WHERE event_id=? AND starts_utc IS NULL', copy.id)).n >= 1);
});

test('administração: dar e remover acesso de administrador pela tela de usuários', async () => {
  const adm = new h.Client(); await h.login(adm, await h.makeAdmin('chefe@teste.local')); await adm.post('/contexto', { context: 'admin' });
  const novo = new h.Client(); await h.signup(novo, { name: 'Nova Admin', email: 'nova.admin@teste.local' });
  const target = await db.one('SELECT * FROM users WHERE email=?', 'nova.admin@teste.local');
  assert.equal(target.email_verified_at, null);
  // a tela mostra o botão e a orientação
  const page = await adm.get('/admin/usuarios?q=nova.admin');
  assert.match(page.text, /Tornar administrador/);
  // quem não é administrador não consegue dar acesso
  const intruso = new h.Client(); await h.signup(intruso, { name: 'Intruso', email: 'intruso.admin@teste.local' });
  const negado = await intruso.post(`/admin/usuarios/${target.id}`, { acao: 'grant_admin' }, { follow: false });
  assert.ok([302, 303, 403].includes(negado.status), `status ${negado.status}`);
  assert.equal((await db.one('SELECT is_admin FROM users WHERE id=?', target.id)).is_admin, 0);
  // administrador dá o acesso: e-mail confirmado e auditoria registrada
  await adm.post(`/admin/usuarios/${target.id}`, { acao: 'grant_admin' });
  const promovida = await db.one('SELECT * FROM users WHERE id=?', target.id);
  assert.equal(promovida.is_admin, 1);
  assert.ok(promovida.email_verified_at);
  assert.ok(await db.one("SELECT 1 FROM audit_log WHERE action='admin.granted' AND entity_id=?", String(target.id)));
  // a nova administradora entra no perfil de administração
  await novo.post('/contexto', { context: 'admin' });
  assert.equal((await novo.get('/admin')).status, 200);
  // remover: sessões encerradas e acesso negado
  await adm.post(`/admin/usuarios/${target.id}`, { acao: 'revoke_admin' });
  assert.equal((await db.one('SELECT is_admin FROM users WHERE id=?', target.id)).is_admin, 0);
  assert.equal((await db.one('SELECT COUNT(*) n FROM sessions WHERE user_id=?', target.id)).n, 0);
  const depois = await novo.get('/admin', { follow: false });
  assert.ok([302, 303, 403].includes(depois.status), `status ${depois.status}`);
  // ninguém altera o próprio acesso
  const chefe = await db.one('SELECT id FROM users WHERE email=?', 'chefe@teste.local');
  const self = await adm.post(`/admin/usuarios/${chefe.id}`, { acao: 'revoke_admin' });
  assert.match(self.text, /própria conta/);
  assert.equal((await db.one('SELECT is_admin FROM users WHERE id=?', chefe.id)).is_admin, 1);
});
