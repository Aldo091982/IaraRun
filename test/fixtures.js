'use strict';
const assert = require('node:assert/strict');
const h = require('./helpers');
const { db } = h;

let seq = 100;
/** Organizador completo via HTTP: página pública → conta → e-mail → 4 etapas → aprovação → recebimento de teste. */
async function organizer({ approve = true, payments = true, label = 'Org' } = {}) {
  const n = ++seq;
  const c = new h.Client();
  const email = `org${n}@teste.local`;
  const pub = await c.get('/organizadores');
  assert.match(pub.text, /Começar cadastro/);
  await h.signup(c, { name: `Responsável ${n}`, email, perfil: 'organizador' });
  await h.verifyEmail(c, email);
  await c.post('/organizador/cadastro/1', { acao: 'avancar' });
  const cnpj = h.cnpjFrom(String(11222333000 + n));
  const r2 = await c.postMultipart('/organizador/cadastro/2', { acao: 'avancar', cnpj, legal_name: `${label} ${n} Eventos LTDA`, trade_name: `${label} ${n} Corridas`, city: 'Belo Horizonte', state: 'MG', link_role: 'socio',
    logo: { buffer: h.PNG, type: 'image/png', name: 'logo.png' }, identity: { buffer: h.PDF, type: 'application/pdf', name: 'rg.pdf' }, link_doc: { buffer: h.PDF, type: 'application/pdf', name: 'contrato.pdf' } });
  assert.equal(r2.status, 200, r2.text.slice(0, 500));
  await c.post('/organizador/cadastro/3', { acao: 'avancar', support_email: `atendimento${n}@teste.local`, support_phone: '(31) 99999-0000', accept_terms: 1, accept_privacy: 1, accept_organizer: 1 });
  const r4 = await c.post('/organizador/cadastro/4', { acao: 'concluir' });
  assert.match(r4.text, /Primeiros passos/);
  const org = await db.one('SELECT o.* FROM organizations o JOIN org_members m ON m.org_id=o.id JOIN users u ON u.id=m.user_id WHERE u.email=?', email);
  if (approve) await adminApprove(org.id);
  if (payments) await c.post('/organizador/recebimentos/teste', {});
  return { c, email, org: await db.one('SELECT * FROM organizations WHERE id=?', org.id) };
}
async function adminApprove(orgId) {
  const a = new h.Client(); await h.login(a, await h.makeAdmin());
  await a.post('/contexto', { context: 'admin' });
  for (const d of await db.all('SELECT id FROM documents WHERE org_id=?', orgId)) await a.post(`/admin/documentos/${d.id}`, { decisao: 'verified', note: 'ok' });
  const r = await a.post(`/admin/organizadores/${orgId}/decisao`, { decisao: 'active', note: 'Aprovado em teste' });
  assert.equal((await db.one('SELECT status FROM organizations WHERE id=?', orgId)).status, 'active', r.text.slice(0, 300));
  return a;
}

const future = (days) => { const d = new Date(Date.now() + days * 864e5); return d.toISOString().slice(0, 16); };
/** Evento pelo assistente de 9 etapas. */
async function event(c, { price = '50,00', capacity, modCapacity, sizes = 'P:10, M:10, G:10', products, questions, lotQty, publish = true, reservation } = {}) {
  const r1 = await c.post('/organizador/eventos/novo', { acao: 'avancar', name: `Corrida Teste ${++seq}`, description: 'Uma corrida de rua de teste para validar o fluxo completo da plataforma.', sport: 'Corrida de rua', start_local: future(30), timezone: 'America/Sao_Paulo', capacity: capacity ?? '' });
  const id = Number(/eventos\/(\d+)\/editar/.exec(r1.url)[1]);
  const step = (n, form) => c.post(`/organizador/eventos/${id}/editar?etapa=${n}`, { acao: 'avancar', ...form });
  await step(2, { venue: 'Praça Central', address: 'Av. Afonso Pena, 1000', city: 'Belo Horizonte', state: 'MG', route_info: 'Percurso plano.' });
  await c.post(`/organizador/eventos/${id}/itens/modality`, { name: '5 km', distance_km: 5, capacity: modCapacity ?? '' });
  await c.post(`/organizador/eventos/${id}/itens/modality`, { name: '10 km', distance_km: 10 });
  await c.post(`/organizador/eventos/${id}/itens/category`, { name: 'Geral', gender: 'any' });
  await c.post(`/organizador/eventos/${id}/itens/category-preset`, {});
  await step(3, { ranking_basis: 'net', review_days: 3 });
  await c.post(`/organizador/eventos/${id}/itens/lot`, { name: '1º lote', price, sort: 1, quantity: lotQty ?? '' });
  await c.post(`/organizador/eventos/${id}/itens/lot`, { name: '2º lote', price: price === '0' ? '0' : '70,00', sort: 2 });
  await step(4, {});
  await c.post(`/organizador/eventos/${id}/itens/kit`, { name: 'Kit Atleta', description: 'Camiseta, número e medalha', sizes });
  for (const p of products || []) await c.post(`/organizador/eventos/${id}/itens/product`, p);
  await step(5, {});
  await step(6, { regulation: 'Regulamento oficial da corrida de teste. Idade mínima de 16 anos com autorização. Programação: concentração às 6h. Premiação: troféus aos 3 primeiros.', change_policy: 'Trocas até 7 dias antes.', cancel_policy: 'Reembolso integral até 7 dias antes da prova.', allow_modality_change: 1, allow_shirt_change: 1, change_fee: '0' });
  for (const q of questions || []) await c.post(`/organizador/eventos/${id}/itens/question`, q);
  await step(7, { kit_pickup_info: 'Retirada na loja parceira, sábado das 9h às 18h.', support_email: 'evento@teste.local', support_phone: '(31) 98888-0000', allow_third_party_pickup: 1 });
  await c.post(`/organizador/eventos/${id}/itens/point`, { name: 'Balcão 1' });
  await step(8, { fee_payer: 'athlete', reservation_minutes: reservation ?? 15 });
  if (publish) { const p = await c.post(`/organizador/eventos/${id}/publicar`, {}); assert.equal((await db.one('SELECT status FROM events WHERE id=?', id)).status, 'published', p.text.match(/alert[^<]*<[^]*?<\/div>/)?.[0] || p.text.slice(0, 800)); }
  return await db.one('SELECT * FROM events WHERE id=?', id);
}

let athleteSeq = 200;
async function athlete() {
  const n = ++athleteSeq; const c = new h.Client(); const email = `atleta${n}@teste.local`;
  await h.signup(c, { name: `Atleta Teste ${n}`, email });
  await h.verifyEmail(c, email);
  return { c, email, cpf: h.cpfFrom(String(123456000 + n)), user: await db.one('SELECT * FROM users WHERE email=?', email) };
}
async function participant(ev, a, over = {}) {
  const mod = await db.one("SELECT id FROM modalities WHERE event_id=? AND name='5 km'", ev.id);
  const kit = await db.one('SELECT id FROM kits WHERE event_id=?', ev.id);
  return { name: a.user.name, cpf: a.cpf, birth_date: '1990-05-10', gender: 'F', modality_id: mod.id, kit_id: kit?.id, kit_size: 'M', ...over };
}
async function register(a, ev, over = {}, extra = {}) {
  const r = await a.c.post(`/e/${ev.slug}/inscricao?n=1`, { p: { 0: await participant(ev, a, over) }, accept: 1, ...extra });
  const m = /\/pedido\/(P[0-9A-F]+)/.exec(r.url);
  return { r, code: m?.[1], order: m ? await db.one('SELECT * FROM orders WHERE code=?', m[1]) : null };
}
async function pay(a, code, acao = 'approved:pix') {
  await a.c.post(`/pedido/${code}/pagar`, {}, { follow: false });
  return a.c.post(`/dev/pagamento-simulado/${code}`, { acao });
}
module.exports = { organizer, adminApprove, event, athlete, participant, register, pay, future };
