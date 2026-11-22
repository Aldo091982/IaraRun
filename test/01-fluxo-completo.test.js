'use strict';
// Critério de aceite principal (item 19): do cadastro do organizador à consulta do resultado pelo atleta.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;

before(h.start);
after(h.stop);

test('fluxo completo: organizador → evento → inscrição paga → kit → resultados → histórico do atleta', async () => {
  // 1. Organizador começa sozinho e conclui cadastro (pendente de verificação)
  const o = await f.organizer({ approve: false, payments: false });
  assert.equal(o.org.status, 'verification_pending');
  assert.equal(db.one("SELECT COUNT(*) n FROM consents WHERE user_id=(SELECT id FROM users WHERE email=?) AND doc_key IN ('terms','privacy','organizer')", o.email).n >= 3, true);
  const docs = db.all('SELECT * FROM documents WHERE org_id=?', o.org.id);
  assert.equal(docs.length, 2);
  assert.ok(docs.every((d) => d.status === 'submitted'), 'documento enviado ≠ verificado');

  // 2. Painel com checklist; rascunho é permitido, publicação bloqueada até verificação
  const painel = await o.c.get('/organizador');
  assert.match(painel.text, /Resolver verificação/);
  const ev0 = await f.event(o.c, { publish: false });
  const blocked = await o.c.post(`/organizador/eventos/${ev0.id}/publicar`, {});
  assert.match(blocked.text, /requisitos de ativação|recebimento/);
  assert.equal(db.one('SELECT status FROM events WHERE id=?', ev0.id).status, 'draft');

  // 3. Verificação aprovada + recebimento em testes → publica
  await f.adminApprove(o.org.id);
  await o.c.post('/organizador/recebimentos/teste', {});
  await o.c.post(`/organizador/eventos/${ev0.id}/publicar`, {});
  const ev = db.one('SELECT * FROM events WHERE id=?', ev0.id);
  assert.equal(ev.status, 'published');
  assert.ok(ev.regulation_version >= 1);

  // 4. Atleta encontra o evento no catálogo e inscreve-se
  const a = await f.athlete();
  const cat = await a.c.get('/eventos?q=Corrida&uf=MG');
  assert.ok(cat.text.includes(ev.name));
  const page = await a.c.get(`/e/${ev.slug}`);
  assert.match(page.text, /Inscrições abertas/);
  const { code, order } = await f.register(a, ev);
  assert.ok(code, 'pedido criado');
  assert.equal(order.status, 'pending');
  assert.equal(order.total_cents, 5000);
  assert.equal(db.one('SELECT status FROM registrations WHERE order_id=?', order.id).status, 'reserved');

  // 5. Paga em ambiente de testes; confirmação somente após validação no servidor
  await f.pay(a, code);
  const paid = db.one('SELECT * FROM orders WHERE code=?', code);
  assert.equal(paid.status, 'paid');
  const reg = db.one('SELECT * FROM registrations WHERE order_id=?', paid.id);
  assert.equal(reg.status, 'confirmed');
  assert.ok(reg.bib);
  assert.ok(db.one("SELECT 1 FROM outbox WHERE to_email=? AND subject LIKE 'Inscrição confirmada%'", a.email));
  const dash = await a.c.get('/minha-conta');
  assert.match(dash.text, /Confirmada/);
  assert.match(dash.text, /<svg/); // QR Code
  assert.ok(!dash.text.includes(`/k/${reg.cpf}`));

  // 6. Operador registra a entrega do kit; segunda tentativa é bloqueada
  const k1 = await o.c.post(`/organizador/eventos/${ev.id}/checkin/${reg.id}/kit`, { ponto: '' });
  assert.match(k1.text, /entregue/);
  const k2 = await o.c.post(`/organizador/eventos/${ev.id}/checkin/${reg.id}/kit`, { ponto: '' });
  assert.match(k2.text, /JÁ ENTREGUE/);
  assert.equal(db.one('SELECT COUNT(*) n FROM kit_pickups WHERE registration_id=?', reg.id).n, 1);

  // 7. Organizador importa, revisa e publica resultados
  const csv = `numero_peito;nome;modalidade;tempo_bruto;tempo_liquido;situacao\n${reg.bib};${reg.name};5 km;00:25:40;00:25:10;CONCLUIU\n`;
  const pv = await o.c.postMultipart(`/organizador/eventos/${ev.id}/resultados/previa`, { file: { buffer: Buffer.from(csv), type: 'text/csv', name: 'r.csv' } });
  assert.match(pv.text, /1 válidas/);
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/salvar`, { csv, note: 'teste' });
  const v = db.one('SELECT * FROM result_versions WHERE event_id=?', ev.id);
  assert.equal(v.status, 'draft');
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/${v.id}/publicar`, { status: 'official' });

  // 8. Atleta consulta resultado e histórico
  const pub = await a.c.get(`/e/${ev.slug}/resultados`);
  assert.match(pub.text, /Resultado oficial/);
  assert.match(pub.text, /00:25:10/);
  const hist = await a.c.get('/minha-conta/historico');
  assert.match(hist.text, /00:25:10/);
  assert.match(hist.text, /5:02\/km/);
  const cert = await a.c.get(`/minha-conta/certificado/${reg.id}`);
  assert.match(cert.text, /Certificado de conclusão/);
});
