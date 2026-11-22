'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers');
const f = require('./fixtures');
const { db } = h;
const results = require('../src/lib/results');
const { sendMail } = require('../src/lib/core');
const { suggestFromRegulation } = require('../src/lib/aiAssist');

before(h.start);
after(h.stop);

let o, ev, regs;
before(async () => {
  await h.start();
  o = await f.organizer();
  ev = await f.event(o.c, { price: '0' });
  regs = [];
  for (const [g, birth] of [['F', '1990-01-01'], ['M', '1985-01-01'], ['F', '1975-01-01'], ['M', '2000-01-01']]) {
    const a = await f.athlete(); const { order } = await f.register(a, ev, { gender: g, birth_date: birth });
    regs.push({ a, reg: await db.one('SELECT * FROM registrations WHERE order_id=?', order.id) });
  }
});

test('check-in: busca por QR, número, nome e CPF; mascaramento; duplicidade entre pontos', async () => {
  const { reg } = regs[0];
  const byQr = await o.c.get(`/organizador/eventos/${ev.id}/checkin?q=${encodeURIComponent(`http://x/k/${reg.qr_token}`)}`);
  assert.ok(byQr.text.includes(reg.name));
  assert.ok(!byQr.text.includes(reg.cpf), 'CPF mascarado');
  assert.ok((await o.c.get(`/organizador/eventos/${ev.id}/checkin?q=${reg.bib}`)).text.includes(reg.name));
  assert.ok((await o.c.get(`/organizador/eventos/${ev.id}/checkin?q=${reg.cpf.slice(3, 9)}`)).text.includes(reg.name));
  await o.c.post(`/organizador/eventos/${ev.id}/itens/point`, { name: 'Balcão 2' });
  const [p1, p2] = await db.all('SELECT id FROM pickup_points WHERE event_id=?', ev.id);
  const [x1, x2] = await Promise.all([p1, p2].map((p) => o.c.post(`/organizador/eventos/${ev.id}/checkin/${reg.id}/kit`, { ponto: p.id, third_name: 'Amiga', third_doc: '123' })));
  assert.equal((await db.one('SELECT COUNT(*) n FROM kit_pickups WHERE registration_id=?', reg.id)).n, 1);
  assert.ok([x1, x2].some((x) => /JÁ ENTREGUE/.test(x.text)));
  assert.equal((await db.one('SELECT third_party_name FROM kit_pickups WHERE registration_id=?', reg.id)).third_party_name, 'Amiga');
  // check-in de presença é diferente da entrega do kit e também não duplica
  await o.c.post(`/organizador/eventos/${ev.id}/checkin/${reg.id}/presenca`, {});
  const dup = await o.c.post(`/organizador/eventos/${ev.id}/checkin/${reg.id}/presenca`, {});
  assert.match(dup.text, /já registrado/);
  // QR público não expõe dados
  const anon = new h.Client();
  const qr = await anon.get(`/k/${reg.qr_token}`);
  assert.ok(!qr.text.includes(reg.name));
});

test('importação inválida gera relatório de erros e nada é salvo', async () => {
  const csv = 'numero_peito;nome;modalidade;tempo_bruto;tempo_liquido;situacao\n9999;X;5 km;00:20:00;00:20:00;CONCLUIU\n' + `${regs[1].reg.bib};Y;5 km;abc;00:20:00;CONCLUIU\n${regs[2].reg.bib};Z;5 km;00:20:00;00:21:00;CONCLUIU\n${regs[3].reg.bib};W;5 km;;;VOOU\n`;
  const pv = await results.preview(ev.id, csv);
  const errs = pv.rows.map((r) => r.errors.join('|'));
  assert.match(errs[0], /não corresponde/);
  assert.match(errs[1], /Tempo bruto inválido/);
  assert.match(errs[2], /líquido maior/);
  assert.match(errs[3], /Situação inválida/);
  assert.equal(pv.valid, 0);
  const before = (await db.one('SELECT COUNT(*) n FROM result_versions WHERE event_id=?', ev.id)).n;
  const r = await o.c.post(`/organizador/eventos/${ev.id}/resultados/salvar`, { csv });
  assert.match(r.text, /Nenhuma linha válida|linhas com erro/);
  assert.equal((await db.one('SELECT COUNT(*) n FROM result_versions WHERE event_id=?', ev.id)).n, before);
  assert.match((await results.preview(ev.id, 'a;b\n1;2')).errors[0], /Coluna do número de peito não encontrada/);
});

test('classificação geral, por sexo e categoria; desempate; DNS/DNF/DSQ; correção versionada; revisão', async () => {
  const [A, B, C, D] = regs.map((x) => x.reg);
  const csv = ['numero_peito;nome;modalidade;tempo_bruto;tempo_liquido;situacao',
    `${A.bib};A;5 km;00:22:10;00:22:00;CONCLUIU`, `${B.bib};B;5 km;00:22:05;00:22:00;CONCLUIU`, `${C.bib};C;5 km;00:30:00;00:29:00;CONCLUIU`, `${D.bib};D;5 km;;;NAO_LARGOU`].join('\n');
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/salvar`, { csv, note: 'v1' });
  const v1 = await db.one('SELECT * FROM result_versions WHERE event_id=? ORDER BY version DESC', ev.id);
  const rows = Object.fromEntries((await results.versionRows(v1.id)).map((r) => [r.bib, r]));
  assert.equal(rows[B.bib].rank_overall, 1, 'empate no líquido desempata pelo bruto');
  assert.equal(rows[A.bib].rank_overall, 2);
  assert.equal(rows[C.bib].rank_overall, 3);
  assert.equal(rows[D.bib].rank_overall, null);
  assert.equal(rows[D.bib].status, 'dns');
  assert.equal(rows[A.bib].rank_gender, 1); // A é a 1ª feminina
  assert.equal(rows[C.bib].rank_gender, 2);
  assert.equal(rows[A.bib].pace_s_km, 264);
  assert.ok(rows[A.bib].category_id && rows[C.bib].category_id !== rows[A.bib].category_id);
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/${v1.id}/publicar`, { status: 'preliminary' });
  // atleta pede revisão; organizador corrige gerando nova versão e responde
  const { a } = regs[2];
  await a.c.post(`/minha-conta/inscricao/${C.id}/servicos/revisao`, { message: 'Meu tempo líquido foi 00:21:00' });
  const rv = await db.one('SELECT * FROM result_reviews WHERE registration_id=?', C.id);
  assert.equal(rv.status, 'open');
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/${v1.id}/corrigir`, { bib: C.bib, gun: '00:21:30', net: '00:21:00', status: 'finished', note: 'Revisão do atleta' });
  const v2 = await db.one('SELECT * FROM result_versions WHERE event_id=? ORDER BY version DESC', ev.id);
  assert.equal(v2.version, v1.version + 1);
  assert.equal((await results.versionRows(v2.id)).find((r) => r.bib === C.bib).rank_overall, 1);
  assert.equal((await results.versionRows(v1.id)).find((r) => r.bib === C.bib).rank_overall, 3, 'versão anterior preservada');
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/${v2.id}/publicar`, { status: 'official' });
  assert.equal((await db.one('SELECT status FROM result_versions WHERE id=?', v1.id)).status, 'superseded');
  await o.c.post(`/organizador/eventos/${ev.id}/resultados/revisao/${rv.id}`, { response: 'Corrigido na versão 2.' });
  assert.equal((await db.one('SELECT status FROM result_reviews WHERE id=?', rv.id)).status, 'answered');
  // privacidade: atleta que oculta resultados não aparece pelo nome
  await db.run('UPDATE users SET public_results=0 WHERE id=?', regs[0].a.user.id);
  await db.run('UPDATE registrations SET user_id=? WHERE id=?', regs[0].a.user.id, A.id);
  const pub = await new h.Client().get(`/e/${ev.slug}/resultados`);
  assert.match(pub.text, /perfil privado/);
  assert.match(pub.text, /Pódio Geral/);
  assert.match(pub.text, /1º de [0-9]+/);
  assert.match((await new h.Client().get(`/e/${ev.slug}/resultados?sexo=F`)).text, /mostra a posição no sexo/);
});

test('histórico separa registro pessoal de resultado oficial', async () => {
  const { a } = regs[2];
  await a.c.post('/minha-conta/historico', { event_name: 'Prova Externa', distance_km: 5, time: '00:20:00', date: '2026-01-10' });
  const page = await a.c.get('/minha-conta/historico');
  assert.match(page.text, /Registro pessoal/);
  assert.match(page.text, /Oficial \(organizador\)|Oficial/);
});

test('comunicação respeita preferências e descadastramento de marketing', async () => {
  const { a } = regs[1];
  await a.c.post('/minha-conta/preferencias', { n_payments: 1, public_results: 1 }); // desmarca event_updates e marketing
  const before = (await db.one('SELECT COUNT(*) n FROM outbox WHERE to_email=?', a.email)).n;
  await o.c.post(`/organizador/eventos/${ev.id}/comunicacao`, { subject: 'Mudança de horário', body: 'A largada mudou para 7h.' });
  assert.equal((await db.one('SELECT COUNT(*) n FROM outbox WHERE to_email=?', a.email)).n, before, 'não recebe aviso desativado');
  assert.ok(await db.one("SELECT 1 FROM outbox WHERE to_email=? AND subject ILIKE '%Mudança de horário%'", regs[3].a.email));
  assert.equal(await sendMail(a.email, 'Promo', 'x', 'marketing'), false, 'campanha não enviada sem consentimento');
});

test('assistente de conteúdo não inventa e mantém texto em rascunho até aprovação', async () => {
  const s = await suggestFromRegulation('A largada será às 7h. O percurso é plano e passa pela orla.\n\nA retirada do kit ocorre no sábado.');
  assert.ok(s.missing.includes('premiação'));
  assert.match(s.route_info, /percurso/);
  const before = (await db.one('SELECT description FROM events WHERE id=?', ev.id)).description;
  const page = await o.c.post(`/organizador/eventos/${ev.id}/assistente`, {});
  assert.match(page.text, /Aprovar e aplicar/);
  assert.equal((await db.one('SELECT description FROM events WHERE id=?', ev.id)).description, before, 'nada muda antes da aprovação');
  await o.c.post(`/organizador/eventos/${ev.id}/assistente/aplicar`, { description: 'Texto aprovado pelo organizador com conteúdo do regulamento.' });
  assert.equal((await db.one('SELECT description FROM events WHERE id=?', ev.id)).description, 'Texto aprovado pelo organizador com conteúdo do regulamento.');
});

test('importa planilha de cronometragem com nomes de coluna alternativos e mostra posição "Nº de N"', async () => {
  const csv = `Peito\tAtleta\tChip Time\n${regs[1].reg.bib}\tA\t00:30:00\n${regs[2].reg.bib}\tB\t00:25:00\n${regs[3].reg.bib}\tC\tDNF\n`;
  const pv = await results.preview(ev.id, csv);
  assert.deepEqual(pv.rows.map((r) => r.errors), [[], [], []]);
  assert.equal(pv.rows[2].status, 'dnf');
  const vid = await results.saveVersion(ev.id, pv.rows, null, 'teste aliases');
  const rows = await results.versionRows(vid);
  const t = await results.totals(vid);
  const b = rows.find((x) => x.bib === regs[2].reg.bib);
  assert.equal(results.placings(b, t).overall, '1º de 2');
});
