'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;
const { expireStale } = require('../src/lib/events');
const { createOrder } = require('../src/lib/orders');
const dev = require('../src/routes/dev');
const { handleNotification } = require('../src/routes/webhooks');

before(h.start);
after(h.stop);
let o;
before(async () => { await h.start(); o = await f.organizer(); });

test('inscrições simultâneas não ultrapassam a capacidade', async () => {
  const ev = await f.event(o.c, { modCapacity: 3 });
  const athletes = await Promise.all(Array.from({ length: 8 }, async () => await f.athlete()));
  const results = await Promise.all(await Promise.all(athletes.map(async (a) => await f.register(a, ev))));
  const ok = results.filter((x) => x.code).length;
  assert.equal(ok, 3);
  const mod = await db.one("SELECT id FROM modalities WHERE event_id=? AND name='5 km'", ev.id);
  assert.equal((await db.one("SELECT COUNT(*) n FROM registrations WHERE modality_id=? AND status IN ('reserved','confirmed')", mod.id)).n, 3);
  assert.ok(results.some((x) => /esgotadas/.test(x.r.text)));
});

test('expiração de reserva libera vaga e estoque insuficiente é recusado', async () => {
  const ev = await f.event(o.c, { modCapacity: 1, sizes: 'M:1' });
  const a1 = await f.athlete(); const a2 = await f.athlete();
  const r1 = await f.register(a1, ev);
  assert.ok(r1.code);
  const r2 = await f.register(a2, ev);
  assert.equal(r2.code, undefined);
  await db.run("UPDATE orders SET expires_at='2000-01-01T00:00:00Z' WHERE code=?", r1.code);
  await db.tx(async () => await expireStale());
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', r1.code)).status, 'expired');
  const r3 = await f.register(a2, ev);
  assert.ok(r3.code, 'vaga liberada após expiração');
  // estoque de camiseta
  const ev2 = await f.event(o.c, { sizes: 'P:1, M:0' });
  const a3 = await f.athlete();
  const s = await f.register(a3, ev2, { kit_size: 'M' });
  assert.equal(s.code, undefined);
});

test('duplicidade por CPF, menor sem responsável, questionário obrigatório e cupom de grupo', async () => {
  const ev = await f.event(o.c, { price: '0', questions: [{ label: 'Possui alguma condição médica?', purpose: 'Atendimento médico no dia da prova', type: 'select', options: 'Não, Sim', required: 1 }] });
  const q = await db.one('SELECT id FROM questions WHERE event_id=?', ev.id);
  const a = await f.athlete();
  const noAnswer = await f.register(a, ev);
  assert.match(noAnswer.r.text, /responda/);
  const okR = await f.register(a, ev, { answers: { [`q${q.id}`]: 'Não' } });
  assert.ok(okR.code);
  const ans = JSON.parse((await db.one('SELECT answers FROM registrations WHERE order_id=?', okR.order.id)).answers);
  assert.equal(ans[q.id].version, 1); // versão respondida preservada
  const dup = await f.register(a, ev, { answers: { [`q${q.id}`]: 'Não' } });
  assert.match(dup.r.text, /já existe inscrição/);
  const b = await f.athlete();
  const minor = await f.register(b, ev, { birth_date: '2012-01-01', answers: { [`q${q.id}`]: 'Não' } });
  assert.match(minor.r.text, /responsável legal/);
  const minorOk = await f.register(b, ev, { birth_date: '2012-01-01', guardian_name: 'Mãe Responsável', guardian_cpf: h.cpfFrom('555444333'), answers: { [`q${q.id}`]: 'Não' } });
  assert.ok(minorOk.code);
});

test('cupom de grupo e lote por quantidade', async () => {
  const ev = await f.event(o.c, { lotQty: 2 });
  await o.c.post(`/organizador/eventos/${ev.id}/itens/coupon`, { code: 'EQUIPE10', percent_off: 10, min_group: 2 });
  const a = await f.athlete();
  const solo = await f.register(a, ev, {}, { coupon: 'EQUIPE10' });
  assert.match(solo.r.text, /no mínimo 2/);
  const r = await a.c.post(`/e/${ev.slug}/inscricao?n=2`, { p: { 0: await f.participant(ev, a), 1: await f.participant(ev, a, { name: 'Colega de Equipe', cpf: h.cpfFrom('777666555'), team_name: 'Equipe X' }) }, accept: 1, coupon: 'EQUIPE10' });
  const order = await db.one('SELECT * FROM orders WHERE code=?', /pedido\/(P\w+)/.exec(r.url)[1]);
  assert.equal(order.subtotal_cents, 10000);
  assert.equal(order.discount_cents, 1000);
  // 1º lote (2 vagas) esgotou: próximo pedido vai para o 2º lote (R$ 70)
  const b = await f.athlete();
  const next = await f.register(b, ev);
  assert.equal(next.order.subtotal_cents, 7000);
});

async function paidSetup() {
  const ev = await f.event(o.c);
  const a = await f.athlete();
  const { code } = await f.register(a, ev);
  await a.c.post(`/pedido/${code}/pagar`, {}, { follow: false });
  return { ev, a, code };
}
const simPay = async (code, status, amount) => { const id = `SIMT${Math.random().toString(16).slice(2, 10)}`; const ord = await db.one('SELECT * FROM orders WHERE code=?', code); await db.run('INSERT INTO sim_payments(id,order_code,status,amount_cents,method,updated_at) VALUES(?,?,?,?,?,?)', id, code, status, amount ?? ord.total_cents, 'pix', new Date().toISOString()); return id; };

test('webhooks: assinatura inválida, duplicados, fora de ordem e valor divergente', async () => {
  const { code } = await paidSetup();
  const id = await simPay(code, 'approved');
  const bad = await handleNotification({ provider: 'simulator', secret: 'simulador-local-somente-desenvolvimento', headers: { 'x-request-id': 'r1', 'x-signature': 'ts=1,v1=deadbeef' }, query: { 'data.id': id, type: 'payment' }, body: {} });
  assert.equal(bad.status, 401);
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', code)).status, 'pending');
  const r1 = await dev.sendSimWebhook(id, 'REQ-1');
  const r2 = await dev.sendSimWebhook(id, 'REQ-1');
  assert.equal(r2.result, 'duplicate');
  await dev.sendSimWebhook(id, 'REQ-2'); // nova entrega, mesmo pagamento: idempotente
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', code)).status, 'paid');
  assert.equal((await db.one("SELECT COUNT(*) n FROM payments WHERE provider_payment_id=?", id)).n, 1);
  void r1;
  // fora de ordem: estado antigo chegando depois é ignorado
  await db.run("UPDATE sim_payments SET status='pending', updated_at='2001-01-01T00:00:00Z' WHERE id=?", id);
  const stale = await dev.sendSimWebhook(id, 'REQ-3');
  assert.equal(stale.result.ignored, 'stale');
  assert.equal((await db.one('SELECT status FROM payments WHERE provider_payment_id=?', id)).status, 'approved');
  // valor divergente não confirma
  const s2 = await paidSetup();
  const wrong = await simPay(s2.code, 'approved', 100);
  await dev.sendSimWebhook(wrong, 'REQ-W');
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', s2.code)).status, 'exception');
  assert.equal((await db.one("SELECT status FROM registrations WHERE order_id=(SELECT id FROM orders WHERE code=?)", s2.code)).status, 'reserved');
});

test('pagamento recusado não confirma; pagamento tardio sem vaga vira exceção, com vaga confirma', async () => {
  const ev = await f.event(o.c, { modCapacity: 1 });
  const a = await f.athlete(); const b = await f.athlete();
  const r1 = await f.register(a, ev);
  await f.pay(a, r1.code, 'rejected:credit_card');
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', r1.code)).status, 'pending');
  // reserva expira, outra pessoa ocupa a vaga, e então o pagamento de A é aprovado
  await db.run("UPDATE orders SET expires_at='2000-01-01T00:00:00Z' WHERE code=?", r1.code);
  await db.tx(async () => await expireStale());
  const r2 = await f.register(b, ev);
  assert.ok(r2.code);
  const late = await simPay(r1.code, 'approved');
  await dev.sendSimWebhook(late, 'LATE-1');
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', r1.code)).status, 'exception');
  assert.ok(await db.one("SELECT 1 FROM payment_exceptions WHERE order_id=(SELECT id FROM orders WHERE code=?)", r1.code));
  const capCount = (await db.one("SELECT COUNT(*) n FROM registrations WHERE event_id=? AND status IN ('reserved','confirmed')", ev.id)).n;
  assert.equal(capCount, 1, 'capacidade preservada');
  // pagamento tardio com vaga disponível confirma
  const ev2 = await f.event(o.c, { modCapacity: 5 });
  const c = await f.athlete();
  const r3 = await f.register(c, ev2);
  await db.run("UPDATE orders SET expires_at='2000-01-01T00:00:00Z' WHERE code=?", r3.code);
  await db.tx(async () => await expireStale());
  await dev.sendSimWebhook(await simPay(r3.code, 'approved'), 'LATE-2');
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', r3.code)).status, 'paid');
  // organizador resolve a exceção com reembolso
  const x = await db.one("SELECT x.id FROM payment_exceptions x JOIN orders o ON o.id=x.order_id WHERE o.code=?", r1.code);
  await o.c.post(`/organizador/eventos/${ev.id}/excecoes/${x.id}`, { acao: 'refund' });
  assert.equal((await db.one('SELECT status FROM payment_exceptions WHERE id=?', x.id)).status, 'resolved');
  assert.equal((await db.one('SELECT refunded_cents FROM sim_payments WHERE id=?', late)).refunded_cents, (await db.one('SELECT total_cents FROM orders WHERE code=?', r1.code)).total_cents);
});

test('cancelamento com reembolso libera vaga e aparece na conciliação', async () => {
  const ev = await f.event(o.c, { modCapacity: 1 });
  const a = await f.athlete();
  const { code } = await f.register(a, ev);
  await f.pay(a, code);
  const reg = await db.one("SELECT * FROM registrations WHERE order_id=(SELECT id FROM orders WHERE code=?)", code);
  await a.c.post(`/minha-conta/inscricao/${reg.id}/servicos/cancelar`, { reason: 'Lesão' });
  const req = await db.one("SELECT * FROM requests WHERE registration_id=? AND type='cancel'", reg.id);
  assert.equal(req.status, 'open');
  await o.c.post(`/organizador/eventos/${ev.id}/solicitacoes/${req.id}`, { decisao: 'approve', refund: '50,00', response: 'Aprovado conforme política' });
  assert.equal((await db.one('SELECT status FROM registrations WHERE id=?', reg.id)).status, 'refunded');
  assert.equal((await db.one('SELECT status FROM orders WHERE code=?', code)).status, 'refunded');
  const sim = await db.one('SELECT * FROM sim_payments WHERE order_code=?', code);
  assert.equal(sim.refunded_cents, 5000);
  const b = await f.athlete();
  assert.ok((await f.register(b, ev)).code, 'vaga liberada');
  const fin = await o.c.get('/organizador/financeiro');
  assert.match(fin.text, /Conciliação/);
  assert.match(fin.text, new RegExp(code));
  const csv = await o.c.get('/organizador/financeiro.csv');
  assert.match(csv.text, /Reembolsos/);
});

test('produtos extras: estoque simultâneo, não geram inscrição; alteração paga recusada preserva original', async () => {
  const ev = await f.event(o.c, { products: [{ name: 'Viseira', price: '20,00', variants: 'Única:2' }] });
  const v = await db.one('SELECT v.id FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.event_id=?', ev.id);
  const as = await Promise.all(await Promise.all([1, 2, 3].map(async () => await f.athlete())));
  const rs = await Promise.all(await Promise.all(as.map(async (a) => await f.register(a, ev, {}, { x: { [`v${v.id}`]: 1 } }))));
  assert.equal(rs.filter((x) => x.code).length, 2);
  const regsBefore = (await db.one('SELECT COUNT(*) n FROM registrations WHERE event_id=?', ev.id)).n;
  // compra posterior de produto pelo menu de serviços não cria inscrição
  const first = rs.find((x) => x.code); const owner = as[rs.indexOf(first)];
  await f.pay(owner, first.code);
  const reg = await db.one('SELECT * FROM registrations WHERE order_id=?', first.order.id);
  const buy = await owner.c.post(`/minha-conta/inscricao/${reg.id}/servicos/produtos`, { x: { [`v${v.id}`]: 1 } });
  assert.match(buy.text, /Estoque insuficiente/);
  assert.equal((await db.one('SELECT COUNT(*) n FROM registrations WHERE event_id=?', ev.id)).n, regsBefore);
  // alteração paga (troca de modalidade com diferença) recusada não altera a inscrição
  await db.run('UPDATE events SET change_fee_cents=1000 WHERE id=?', ev.id);
  const m10 = await db.one("SELECT id FROM modalities WHERE event_id=? AND name='10 km'", ev.id);
  const ch = await owner.c.post(`/minha-conta/inscricao/${reg.id}/servicos/modalidade`, { modality_id: m10.id });
  const chCode = /pedido\/(A\w+)/.exec(ch.url)[1];
  await f.pay(owner, chCode, 'rejected:credit_card');
  assert.equal((await db.one('SELECT modality_id FROM registrations WHERE id=?', reg.id)).modality_id, reg.modality_id);
  await f.pay(owner, chCode, 'approved:pix');
  assert.equal((await db.one('SELECT modality_id FROM registrations WHERE id=?', reg.id)).modality_id, m10.id);
});

test('createOrder recusa evento não aberto', async () => {
  const user = await db.one('SELECT * FROM users LIMIT 1');
  const ev = await db.one("SELECT id FROM events WHERE status='draft' LIMIT 1") || { id: 999999 };
  await assert.rejects(async () => await createOrder({ user, eventId: ev.id, participants: [{}], acceptRegulation: true }), /não estão abertas/);
});
