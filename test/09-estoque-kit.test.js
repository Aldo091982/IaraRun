'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;

before(h.start);
after(h.stop);

let o, ev;
before(async () => {
  await h.start();
  o = await f.organizer();
  ev = await f.event(o.c, { price: '0' });
});
const stockUrl = (e = ev) => `/organizador/eventos/${e.id}/estoque`;
const kitOf = async (e) => await db.one('SELECT * FROM kits WHERE event_id=? ORDER BY id', e.id);

test('assistente: itens do kit com estoque, sugestões, recusa de tênis e clonagem', async () => {
  const d = await f.event(o.c, { publish: false });
  const page = await o.c.get(`/organizador/eventos/${d.id}/editar?etapa=5`);
  assert.match(page.text, /Itens do kit e quantidade em estoque/);
  assert.match(page.text, /Tênis não faz parte do kit/);
  assert.match(page.text, /Chip de cronometragem/);
  await o.c.post(`/organizador/eventos/${d.id}/itens/kit`, { name: 'Kit Premium', sizes: 'P:5, M:5', items: 'Boné:50, Medalha de participação:100, Número de peito', item_s0: 1, item_s3: 1, item_s8: 1 });
  const kit = await db.one("SELECT * FROM kits WHERE event_id=? AND name='Kit Premium'", d.id);
  const items = await db.all('SELECT name, stock FROM kit_items WHERE kit_id=? ORDER BY sort', kit.id);
  assert.deepEqual(items.map((x) => [x.name, x.stock]), [['Boné', 50], ['Medalha de participação', 100], ['Número de peito', null], ['Toalha', null]], 'sugestões repetidas não duplicam');
  assert.match((await o.c.get(`/organizador/eventos/${d.id}/editar?etapa=5`)).text, /Boné: 50/);

  const bad = await o.c.post(`/organizador/eventos/${d.id}/itens/kit`, { name: 'Kit Tenis', items: 'Tênis de corrida:10' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /tênis não faz parte do kit/i);
  assert.ok(!await db.one("SELECT 1 FROM kits WHERE event_id=? AND name='Kit Tenis'", d.id));
  assert.equal((await o.c.post(`/organizador/eventos/${d.id}/itens/kit`, { name: 'Kit X', items: 'TENIS:1' })).status, 400);

  const dup = await o.c.post(`/organizador/eventos/${d.id}/duplicar`, {});
  const nid = Number(/eventos\/(\d+)\/editar/.exec(dup.url)[1]);
  const copy = await db.one("SELECT * FROM kits WHERE event_id=? AND name='Kit Premium'", nid);
  assert.equal((await db.one('SELECT COUNT(*) n FROM kit_items WHERE kit_id=?', copy.id)).n, 4);

  await o.c.post(`/organizador/eventos/${d.id}/itens/kit/${kit.id}/remover`, {});
  assert.equal((await db.one('SELECT COUNT(*) n FROM kit_items WHERE kit_id=?', kit.id)).n, 0, 'excluir kit apaga os itens');
});

test('item adicionado após a publicação esgota o kit quando acaba', async () => {
  const kit = await kitOf(ev);
  const r = await o.c.post(`${stockUrl()}/itens`, { kit_id: kit.id, name: 'Boné', stock: 2, limits_sales: 1 });
  assert.match(r.text, /Boné adicionado ao kit/);
  for (let i = 0; i < 2; i++) { const a = await f.athlete(); const { order } = await f.register(a, ev); assert.ok(order, `inscrição ${i + 1} aceita`); }
  const a3 = await f.athlete();
  const { order, r: r3 } = await f.register(a3, ev);
  assert.equal(order, null);
  assert.match(r3.text, /kit Kit Atleta esgotado \(Boné\)/);
  assert.match((await a3.c.get(`/e/${ev.slug}/inscricao?n=1`)).text, /Kit Atleta[^<]*\(esgotado\)/);
  assert.match((await new h.Client().get(`/e/${ev.slug}`)).text, /\(esgotado\)/);
  const page = await o.c.get(stockUrl());
  assert.match(page.text, /Kit esgotado/);
  // entrada de estoque volta a liberar o kit
  await o.c.post(`${stockUrl()}/ajuste`, { target: `i:${(await db.one("SELECT id FROM kit_items WHERE kit_id=? AND name='Boné'", kit.id)).id}`, tipo: 'in', qty: 5, reason: 'Chegada do fornecedor' });
  assert.ok((await f.register(a3, ev)).order, 'kit liberado após entrada');
});

test('ajuste de estoque exige motivo, não deixa negativo e grava histórico e auditoria', async () => {
  const kit = await kitOf(ev);
  const size = await db.one("SELECT * FROM kit_sizes WHERE kit_id=? AND size='G'", kit.id);
  const target = `s:${size.id}`;
  assert.equal((await o.c.post(`${stockUrl()}/ajuste`, { target, tipo: 'out', qty: 2, reason: '' })).status, 400);
  const ok = await o.c.post(`${stockUrl()}/ajuste`, { target, tipo: 'out', qty: 2, reason: 'Peças com defeito' });
  assert.match(ok.text, /atualizado para 8/);
  const neg = await o.c.post(`${stockUrl()}/ajuste`, { target, tipo: 'out', qty: 100, reason: 'Teste negativo' });
  assert.equal(neg.status, 400);
  assert.match(neg.text, /não pode ficar negativo/);
  assert.equal((await db.one('SELECT stock FROM kit_sizes WHERE id=?', size.id)).stock, 8);
  await o.c.post(`${stockUrl()}/ajuste`, { target, tipo: 'set', qty: 30, reason: 'Contagem física' });
  assert.equal((await db.one('SELECT stock FROM kit_sizes WHERE id=?', size.id)).stock, 30);
  const moves = await db.all("SELECT * FROM kit_stock_moves WHERE event_id=? AND size='G' ORDER BY id", ev.id);
  assert.deepEqual(moves.map((m) => [m.kind, m.delta, m.new_stock]), [['out', -2, 8], ['set', 22, 30]]);
  assert.ok(await db.one("SELECT 1 FROM audit_log WHERE action='kit.stock_adjusted' AND entity_id=?", String(ev.id)));
  const page = await o.c.get(stockUrl());
  assert.equal(page.status, 200);
  for (const t of ['Estoque do kit', 'Reservado/vendido', 'A entregar', 'Disponível para venda', 'Peças com defeito', 'Contagem física', 'Camiseta G']) assert.ok(page.text.includes(t), t);
  assert.match((await o.c.get(`/organizador/eventos/${ev.id}`)).text, /Gerenciar estoque do kit/);
  const csv = await o.c.get(`${stockUrl()}.csv`);
  assert.match(csv.text, /Kit;Item;Estoque|Kit,Item,Estoque/);
  assert.match(csv.text, /Camiseta G/);
});

test('remover item mantém o histórico', async () => {
  const kit = await kitOf(ev);
  await o.c.post(`${stockUrl()}/itens`, { kit_id: kit.id, name: 'Viseira', stock: 10 });
  const it = await db.one("SELECT * FROM kit_items WHERE kit_id=? AND name='Viseira'", kit.id);
  assert.equal(it.limits_sales, 0);
  assert.equal((await o.c.post(`${stockUrl()}/itens`, { kit_id: kit.id, name: 'Tênis', stock: 1 })).status, 400);
  await o.c.post(`${stockUrl()}/itens/${it.id}/remover`, {});
  assert.ok(!await db.one('SELECT 1 FROM kit_items WHERE id=?', it.id));
  assert.equal((await db.one('SELECT COUNT(*) n FROM kit_stock_moves WHERE item_id=?', it.id)).n, 2);
  assert.match((await o.c.get(stockUrl())).text, /Item removido/);
});

test('permissão e escopo do evento no estoque', async () => {
  const ev2 = await f.event(o.c, { publish: false });
  const col = new h.Client(); await h.signup(col, { name: 'Operador Estoque', email: 'estoque@teste.local' });
  await o.c.post('/organizador/equipe', { email: 'estoque@teste.local', perm_kits: 1, [`ev_${ev.id}`]: 1 });
  await col.post('/contexto', { context: `org:${o.org.id}` });
  assert.equal((await col.get(stockUrl())).status, 200);
  assert.equal((await col.get(stockUrl(ev2))).status, 403);
  const att = new h.Client(); await h.signup(att, { name: 'Atendente', email: 'atend-estoque@teste.local' });
  await o.c.post('/organizador/equipe', { email: 'atend-estoque@teste.local', perm_registrations: 1, [`ev_${ev.id}`]: 1 });
  await att.post('/contexto', { context: `org:${o.org.id}` });
  assert.equal((await att.get(stockUrl())).status, 403);
  // item de outro evento não pode ser ajustado pela URL deste evento
  const size2 = await db.one('SELECT s.* FROM kit_sizes s JOIN kits k ON k.id=s.kit_id WHERE k.event_id=?', ev2.id);
  const cross = await o.c.post(`${stockUrl()}/ajuste`, { target: `s:${size2.id}`, tipo: 'in', qty: 1, reason: 'Tentativa' });
  assert.equal(cross.status, 404);
  assert.equal((await o.c.post(`${stockUrl()}/itens`, { kit_id: (await kitOf(ev2)).id, name: 'Meia', stock: 1 })).status, 404);
  const other = await f.organizer({ label: 'Outra' });
  assert.ok([403, 404].includes((await other.c.get(stockUrl())).status));
});
