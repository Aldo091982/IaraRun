'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDateTime, fmtDuration, fmtPace, parseDuration, json, UserError, nowIso, toCsv, maskCpf } = require('../lib/util');
const { fmtCpf } = require('../lib/docs');
const { assertCan, can, eventForOrg } = require('../lib/orgs');
const { publicStatus, PUBLIC_STATUS, eventStats } = require('../lib/events');
const { cancelRegistration } = require('../lib/orders');
const payments = require('../lib/payments');
const results = require('../lib/results');
const { audit, sendMail } = require('../lib/core');
const { requireOrg, upload, csrfAfterMultipart } = require('../lib/guards');
const { csrf, field, badge, table, tip, empty, errorsBox } = require('../views/layout');

const r = express.Router();
r.use((req, res, next) => (req.path.startsWith('/cadastro') ? next('router') : next()));
r.use(requireOrg);

const REG_STATUS = { reserved: ['Reservada (aguardando pagamento)', 'warn'], confirmed: ['Confirmada', 'ok'], cancelled: ['Cancelada', 'muted'], refunded: ['Reembolsada', 'muted'], expired: ['Reserva expirada', 'muted'] };
const REQ_TYPE = { cancel: 'Cancelamento com reembolso', modality: 'Troca de modalidade', shirt: 'Troca de camiseta', transfer: 'Transferência de titularidade' };
async function ev(req, p) { const e = await eventForOrg(Number(req.params.id), req.org.id); if (p) assertCan(req.member, p, e.id); else if (req.member.eventIds && !req.member.eventIds.includes(e.id)) assertCan(req.member, '__none__', e.id); return e; }
const tabs = async (req, e, active) => html`<p><a href="/organizador/eventos">← Eventos</a></p><div class="org-head"><div><h1>${e.name}</h1><p class="muted">${fmtDateTime(e.start_utc, e.timezone)} · ${e.city || ''}/${e.state || ''}</p></div>${badge(PUBLIC_STATUS[await publicStatus(e)].label, PUBLIC_STATUS[await publicStatus(e)].tone)}</div>
<nav class="subnav" aria-label="Evento">${[['', 'Visão geral', null], ['/inscritos', 'Inscritos', 'registrations'], ['/solicitacoes', 'Solicitações', 'registrations'], ['/comunicacao', 'Comunicação', 'communication'], ['/checkin', 'Kits e check-in', 'kits'], ['/resultados', 'Resultados', 'timing']].filter(([, , p]) => !p || can(req.member, p, e.id)).map(([h, l]) => html`<a href="/organizador/eventos/${e.id}${h}" ${active === h ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

r.get('/eventos/:id', async (req, res) => {
  const e = await ev(req); const s = await eventStats(e.id);
  const mods = await db.all('SELECT m.*, (SELECT COUNT(*) FROM registrations g WHERE g.modality_id=m.id AND g.status=\'confirmed\') n FROM modalities m WHERE event_id=?', e.id);
  const exc = await db.all("SELECT x.*, o.code FROM payment_exceptions x JOIN orders o ON o.id=x.order_id WHERE o.event_id=? AND x.status='open'", e.id);
  const sizes = await db.all("SELECT k.name, s.size, s.stock, (SELECT COUNT(*) FROM registrations g WHERE g.kit_id=k.id AND g.kit_size=s.size AND g.status IN ('reserved','confirmed')) used FROM kits k JOIN kit_sizes s ON s.kit_id=k.id WHERE k.event_id=?", e.id);
  const funnel = await db.one(`SELECT COUNT(*) started, SUM(CASE WHEN status IN ('paid','free') THEN 1 ELSE 0 END) done, SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) abandoned, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM orders WHERE event_id=? AND kind='registration'`, e.id);
  res.page({ title: e.name, wide: true, body: html`${await tabs(req, e, '')}
  ${exc.length ? html`<div class="alert alert-error"><strong>${exc.length} exceção(ões) de pagamento para resolver:</strong><ul>${exc.map((x) => html`<li>Pedido ${x.code}: ${x.reason}</li>`)}</ul>${can(req.member, 'finance', e.id) ? html`<a href="/organizador/eventos/${e.id}/solicitacoes">Resolver</a>` : ''}</div>` : ''}
  <section class="kpis"><div class="kpi"><span>Confirmadas</span><strong>${s.confirmed}</strong></div><div class="kpi"><span>Reservas em pagamento</span><strong>${s.reserved}</strong></div><div class="kpi"><span>Receita bruta confirmada</span><strong>${can(req.member, 'finance', e.id) ? brl(s.gross) : '—'}</strong></div><div class="kpi"><span>Cancel./reembolsos</span><strong>${s.cancelled}</strong></div><div class="kpi"><span>Kits entregues</span><strong>${s.kits_delivered}</strong></div><div class="kpi"><span>Solicitações abertas</span><strong>${s.open_requests}</strong></div></section>
  <p class="muted">Atualizado em ${fmtDateTime(nowIso(), e.timezone)} (recarregue para atualizar).</p>
  <div class="cols"><section class="card col-main"><h2>Vagas por modalidade</h2>${table(['Modalidade', 'Confirmadas', 'Limite'], mods.map((m) => [m.name, String(m.n), m.capacity ?? 'Sem limite']))}
  <h2>Estoque de camisetas</h2>${table(['Kit', 'Tamanho', 'Reservado/vendido', 'Estoque'], sizes.map((x) => [x.name, x.size, String(x.used), String(x.stock)]))}
  <h2>Conversão</h2><p class="muted">Pedidos iniciados no período do evento. "Abandono" = reserva expirada sem pagamento; difere de "pagamento pendente" (aguardando confirmação do provedor).</p>
  ${table(['Pedidos iniciados', 'Concluídos', 'Pendentes', 'Abandonados', 'Conversão'], [[String(funnel.started || 0), String(funnel.done || 0), String(funnel.pending || 0), String(funnel.abandoned || 0), funnel.started ? `${Math.round((funnel.done / funnel.started) * 100)}%` : '—']])}</section>
  <aside class="col-side card"><h2>Ações</h2>
  ${can(req.member, 'events', e.id) ? html`<p><a class="btn btn-block" href="/organizador/eventos/${e.id}/editar">Editar evento</a></p><p><a class="btn btn-ghost btn-block" href="/e/${e.slug}" target="_blank">Ver página pública</a></p>
  ${e.status === 'published' ? html`<form method="post" action="/organizador/eventos/${e.id}/status">${csrf(req)}<input type="hidden" name="status" value="closed"><button class="btn btn-ghost btn-block">Encerrar inscrições</button></form>` : ''}
  ${e.status === 'closed' ? html`<form method="post" action="/organizador/eventos/${e.id}/status">${csrf(req)}<input type="hidden" name="status" value="published"><button class="btn btn-ghost btn-block">Reabrir inscrições</button></form>` : ''}
  ${['published', 'closed'].includes(e.status) ? html`<form method="post" action="/organizador/eventos/${e.id}/status">${csrf(req)}<input type="hidden" name="status" value="completed"><button class="btn btn-ghost btn-block">Marcar como concluído</button></form>` : ''}
  <form method="post" action="/organizador/eventos/${e.id}/duplicar">${csrf(req)}<button class="btn btn-ghost btn-block">Duplicar como rascunho</button></form>
  ${e.status !== 'cancelled' ? html`<form method="post" action="/organizador/eventos/${e.id}/status" data-confirm="Cancelar o evento? Inscritos serão avisados.">${csrf(req)}<input type="hidden" name="status" value="cancelled"><button class="btn btn-danger btn-block">Cancelar evento</button></form>` : ''}` : html`<p class="muted">Seu perfil não edita o evento.</p>`}</aside></div>` });
});

// ---------- Inscritos ----------
async function regQuery(e, q) {
  const where = ['g.event_id=?']; const p = [e.id];
  if (q.status) { where.push('g.status=?'); p.push(q.status); }
  if (q.modalidade) { where.push('g.modality_id=?'); p.push(Number(q.modalidade)); }
  if (q.q) { where.push('(g.name ILIKE ? OR g.bib=? OR g.cpf ILIKE ? OR o.code=?)'); p.push(`%${q.q}%`, q.q, `%${String(q.q).replace(/\D/g, '') || '§'}%`, q.q); }
  return await db.all(`SELECT g.*, m.name modality, c.name category, k.name kit, o.code, o.status order_status, o.total_cents, (SELECT picked_at FROM kit_pickups WHERE registration_id=g.id) picked FROM registrations g JOIN orders o ON o.id=g.order_id JOIN modalities m ON m.id=g.modality_id LEFT JOIN categories c ON c.id=g.category_id LEFT JOIN kits k ON k.id=g.kit_id WHERE ${where.join(' AND ')} ORDER BY g.id DESC LIMIT 1000`, ...p);
}
r.get('/eventos/:id/inscritos', async (req, res) => {
  const e = await ev(req, 'registrations'); const q = req.query;
  const rows = await regQuery(e, q); const mods = await db.all('SELECT id,name FROM modalities WHERE event_id=?', e.id);
  res.page({ title: 'Inscritos', wide: true, body: html`${await tabs(req, e, '/inscritos')}
  <form class="filters inline-filters">${field('q', 'Nome, CPF, nº ou pedido', { value: q.q })}${field('status', 'Situação', { value: q.status, options: [['', 'Todas'], ...Object.entries(REG_STATUS).map(([k, v]) => [k, v[0]])] })}${field('modalidade', 'Modalidade', { value: q.modalidade, options: [['', 'Todas'], ...mods.map((m) => [m.id, m.name])] })}<button class="btn">Filtrar</button>
  <a class="btn btn-ghost" href="/organizador/eventos/${e.id}/inscritos.csv?${new URLSearchParams(q)}">Exportar CSV</a></form>
  <p class="muted">${rows.length} registro(s). CPFs mascarados na listagem; a exportação completa é registrada em auditoria.</p>
  ${table(['Nº', 'Nome', 'CPF', 'Modalidade', 'Categoria', 'Kit/camiseta', 'Pedido', 'Situação', 'Kit'], rows.map((g) => [g.bib || '—', g.name + (g.guardian_name ? ` (resp.: ${g.guardian_name})` : ''), maskCpf(g.cpf), g.modality, g.category || '—', `${g.kit || '—'} ${g.kit_size || ''}`, g.code, badge(...REG_STATUS[g.status]), g.picked ? badge('Entregue', 'ok') : '—']))}` });
});
r.get('/eventos/:id/inscritos.csv', async (req, res) => {
  const e = await ev(req, 'registrations');
  const rows = await regQuery(e, req.query);
  const qs = await db.all('SELECT * FROM questions WHERE event_id=?', e.id);
  await audit(req, 'export.registrations', { orgId: req.org.id, entity: 'event', entityId: e.id, detail: { count: rows.length } });
  res.type('text/csv').attachment(`inscritos-${e.slug}.csv`).send(toCsv(rows, [
    { label: 'Número', key: 'bib' }, { label: 'Nome', key: 'name' }, { label: 'CPF', value: (g) => fmtCpf(g.cpf) }, { label: 'Nascimento', key: 'birth_date' }, { label: 'Sexo', key: 'gender' }, { label: 'E-mail', key: 'email' },
    { label: 'Responsável', key: 'guardian_name' }, { label: 'Modalidade', key: 'modality' }, { label: 'Categoria', key: 'category' }, { label: 'Kit', key: 'kit' }, { label: 'Camiseta', key: 'kit_size' }, { label: 'Equipe', key: 'team_name' },
    { label: 'Pedido', key: 'code' }, { label: 'Situação', value: (g) => REG_STATUS[g.status][0] }, { label: 'Valor', value: (g) => (g.price_cents / 100).toFixed(2) }, { label: 'Regulamento (versão)', key: 'regulation_version' }, { label: 'Aceite em', key: 'regulation_accepted_at' },
    ...qs.map((q) => ({ label: `${q.label} (v${q.version})`, value: (g) => json(g.answers, {})[q.id]?.value ?? '' }))]));
});

// ---------- Solicitações, reembolsos e exceções ----------
r.get('/eventos/:id/solicitacoes', async (req, res) => {
  const e = await ev(req, 'registrations');
  const reqs = await db.all("SELECT q.*, g.name, g.bib, g.price_cents, o.code, o.status order_status FROM requests q JOIN registrations g ON g.id=q.registration_id JOIN orders o ON o.id=g.order_id WHERE g.event_id=? ORDER BY q.status='open' DESC, q.id DESC", e.id);
  const exc = await db.all("SELECT x.*, o.code, o.total_cents FROM payment_exceptions x JOIN orders o ON o.id=x.order_id WHERE o.event_id=? ORDER BY x.status='open' DESC, x.id DESC", e.id);
  const fin = can(req.member, 'finance', e.id);
  res.page({ title: 'Solicitações', wide: true, body: html`${await tabs(req, e, '/solicitacoes')}
  <section class="card"><h2>Solicitações dos atletas</h2>${tip('Cancelamentos com reembolso exigem permissão financeira. O valor é estornado pelo provedor de pagamento e a vaga volta ao estoque.')}
  ${table(['Data', 'Atleta', 'Tipo', 'Detalhes', 'Situação', 'Decisão'], reqs.map((q) => [fmtDateTime(q.created_at, e.timezone), `${q.name} (${q.bib || q.code})`, REQ_TYPE[q.type] || q.type, `${q.reason || ''} ${q.type !== 'cancel' ? JSON.stringify(json(q.payload)) : ''}`,
    q.status === 'open' ? badge('Aberta', 'warn') : badge(`${q.status === 'approved' ? 'Aprovada' : 'Recusada'}${q.refund_cents ? ` · reembolso ${brl(q.refund_cents)}` : ''}`, q.status === 'approved' ? 'ok' : 'muted'),
    q.status === 'open' ? html`<form method="post" action="/organizador/eventos/${e.id}/solicitacoes/${q.id}" class="stack">${csrf(req)}${q.type === 'cancel' ? field('refund', 'Valor do reembolso (R$)', { value: (q.price_cents / 100).toFixed(2).replace('.', ','), id: `rf-${q.id}` }) : ''}${field('response', 'Resposta ao atleta', { id: `rs-${q.id}` })}
      <button name="decisao" value="approve" class="btn btn-sm" ${q.type === 'cancel' && !fin ? 'disabled' : ''}>Aprovar</button> <button name="decisao" value="deny" class="btn btn-sm btn-ghost">Recusar</button></form>` : q.response || '']), { emptyMsg: 'Nenhuma solicitação.' })}</section>
  <section class="card"><h2>Exceções de pagamento</h2><p class="muted">Ex.: pagamento aprovado após a reserva expirar, sem vaga disponível. A inscrição não foi confirmada para não ultrapassar a capacidade.</p>
  ${table(['Pedido', 'Motivo', 'Situação', ''], exc.map((x) => [x.code, x.reason, x.status === 'open' ? badge('Aberta', 'danger') : badge(x.resolution || 'Resolvida', 'ok'),
    x.status === 'open' && fin ? html`<form method="post" action="/organizador/eventos/${e.id}/excecoes/${x.id}" class="inline">${csrf(req)}<button name="acao" value="refund" class="btn btn-sm">Reembolsar integralmente</button> <button name="acao" value="force" class="btn btn-sm btn-ghost" data-confirm="Confirmar mesmo assim? Isso pode exceder a capacidade planejada.">Confirmar acima do limite</button></form>` : '']), { emptyMsg: 'Nenhuma exceção.' })}</section>` });
});
r.post('/eventos/:id/solicitacoes/:rid', async (req, res) => {
  const e = await ev(req, 'registrations');
  const q = await db.one("SELECT q.*, g.order_id, g.price_cents, g.event_id FROM requests q JOIN registrations g ON g.id=q.registration_id WHERE q.id=? AND g.event_id=? AND q.status='open'", Number(req.params.rid), e.id);
  if (!q) throw new UserError('Solicitação não encontrada.');
  const approve = req.body.decisao === 'approve';
  let refundCents = null;
  if (approve && q.type === 'cancel') {
    assertCan(req.member, 'finance', e.id);
    const order = await db.one('SELECT * FROM orders WHERE id=?', q.order_id);
    refundCents = Math.max(0, Math.round(Number(String(req.body.refund || '0').replace(/\./g, '').replace(',', '.')) * 100));
    if (refundCents > 0) await payments.refund(order, refundCents, req);
    await cancelRegistration(q.registration_id, refundCents > 0 ? 'refunded' : 'cancelled');
  }
  if (approve && q.type === 'shirt') { const pl = json(q.payload); await db.run('UPDATE registrations SET kit_size=? WHERE id=?', pl.kit_size, q.registration_id); }
  if (approve && q.type === 'transfer') { const pl = json(q.payload); await db.run('UPDATE registrations SET name=?, cpf=?, birth_date=?, gender=?, email=?, user_id=NULL WHERE id=?', pl.name, pl.cpf, pl.birth_date, pl.gender, pl.email, q.registration_id); }
  await db.run('UPDATE requests SET status=?, response=?, decided_by=?, decided_at=?, refund_cents=? WHERE id=?', approve ? 'approved' : 'denied', req.body.response || null, req.user.id, nowIso(), refundCents, q.id);
  const u = await db.one('SELECT email FROM users WHERE id=?', q.user_id);
  await sendMail(u.email, `Sua solicitação foi ${approve ? 'aprovada' : 'recusada'} — ${e.name}`, `${REQ_TYPE[q.type]}: ${approve ? 'aprovada' : 'recusada'}. ${req.body.response || ''}${refundCents ? ` Reembolso de ${brl(refundCents)} solicitado ao provedor de pagamento; o prazo de estorno depende do meio de pagamento.` : ''}`);
  await audit(req, 'request.decided', { orgId: req.org.id, entity: 'request', entityId: q.id, detail: { approve, refundCents } });
  res.redirect(303, `/organizador/eventos/${e.id}/solicitacoes`);
});
r.post('/eventos/:id/excecoes/:xid', async (req, res) => {
  const e = await ev(req, 'finance');
  const x = await db.one("SELECT x.*, o.id oid FROM payment_exceptions x JOIN orders o ON o.id=x.order_id WHERE x.id=? AND o.event_id=? AND x.status='open'", Number(req.params.xid), e.id);
  if (!x) throw new UserError('Exceção não encontrada.');
  const order = await db.one('SELECT * FROM orders WHERE id=?', x.oid);
  if (req.body.acao === 'refund') {
    // pedido em exceção: status temporário para permitir o estorno
    await db.run("UPDATE orders SET status='paid' WHERE id=?", order.id);
    await payments.refund({ ...order, status: 'paid' }, order.total_cents, req);
    await db.run("UPDATE registrations SET status='refunded', cancelled_at=? WHERE order_id=?", nowIso(), order.id);
    await db.run("UPDATE payment_exceptions SET status='resolved', resolution='Reembolsado' WHERE id=?", x.id);
  } else {
    await db.tx(async () => {
      await db.run("UPDATE orders SET status='paid', paid_at=? WHERE id=?", nowIso(), order.id);
      await db.run("UPDATE registrations SET status='confirmed', confirmed_at=? WHERE order_id=?", nowIso(), order.id);
      await db.run("UPDATE order_items SET status='paid' WHERE order_id=?", order.id);
      for (const g of await db.all('SELECT * FROM registrations WHERE order_id=? AND bib IS NULL', order.id)) { const max = (await db.one("SELECT MAX(CAST(bib AS INTEGER)) m FROM registrations WHERE event_id=? AND bib ~ '^[0-9]+$'", e.id)).m || 0; await db.run('UPDATE registrations SET bib=? WHERE id=?', String(max + 1), g.id); }
      await db.run("UPDATE payment_exceptions SET status='resolved', resolution='Confirmado acima do limite pelo organizador' WHERE id=?", x.id);
    });
  }
  await audit(req, 'payment_exception.resolved', { orgId: req.org.id, entity: 'order', entityId: order.id, detail: { acao: req.body.acao } });
  res.redirect(303, `/organizador/eventos/${e.id}/solicitacoes`);
});

// ---------- Comunicação ----------
r.get('/eventos/:id/comunicacao', async (req, res) => {
  const e = await ev(req, 'communication'); const mods = await db.all('SELECT id,name FROM modalities WHERE event_id=?', e.id);
  const sent = await db.all("SELECT * FROM audit_log WHERE org_id=? AND action='communication.sent' AND entity_id=? ORDER BY id DESC LIMIT 20", req.org.id, String(e.id));
  res.page({ title: 'Comunicação', wide: true, body: html`${await tabs(req, e, '/comunicacao')}<section class="card"><h2>Aviso aos inscritos confirmados</h2>
  ${tip('Use para informações operacionais do evento (alterações, retirada de kit, resultados). Respeita as preferências de notificação dos atletas. Campanhas promocionais exigem consentimento e ficam para etapa posterior.')}
  <form method="post" action="/organizador/eventos/${e.id}/comunicacao">${csrf(req)}${field('modality_id', 'Destinatários', { options: [['', 'Todos os confirmados'], ...mods.map((m) => [m.id, `Somente ${m.name}`])] })}${field('subject', 'Assunto', { required: true })}${field('body', 'Mensagem', { type: 'textarea', rows: 6, required: true })}${config.messaging.mode === 'twilio' ? field('also_phone', 'Também enviar por WhatsApp/SMS para quem autorizou esse tipo de aviso', { type: 'checkbox' }) : ''}<button class="btn">Enviar</button></form></section>
  <section class="card"><h2>Histórico</h2>${table(['Data', 'Assunto', 'Destinatários'], sent.map((s) => { const d = json(s.detail); return [fmtDateTime(s.created_at), d.subject, String(d.count)]; }))}</section>` });
});
r.post('/eventos/:id/comunicacao', async (req, res) => {
  const e = await ev(req, 'communication');
  if (!req.body.subject || !req.body.body) throw new UserError('Informe assunto e mensagem.');
  const list = await db.all(`SELECT DISTINCT COALESCE(g.email, u.email) email FROM registrations g JOIN users u ON u.id=g.buyer_user_id WHERE g.event_id=? AND g.status='confirmed' ${req.body.modality_id ? 'AND g.modality_id=?' : ''}`, e.id, ...(req.body.modality_id ? [Number(req.body.modality_id)] : []));
  let n = 0; for (const x of list) if (x.email && await sendMail(x.email, `[${e.name}] ${req.body.subject}`, req.body.body, 'event_updates')) n++;
  let m = 0;
  if (req.body.also_phone) {
    const users = await db.all(`SELECT DISTINCT g.buyer_user_id id FROM registrations g WHERE g.event_id=? AND g.status='confirmed' ${req.body.modality_id ? 'AND g.modality_id=?' : ''}`, e.id, ...(req.body.modality_id ? [Number(req.body.modality_id)] : []));
    const prefsOk = async (id) => { const u = await db.one('SELECT notify_prefs FROM users WHERE id=?', id); return json(u?.notify_prefs, {}).event_updates !== false; };
    for (const x of users) if (await prefsOk(x.id)) m += await require('../lib/delivery').queueUserMessage(x.id, `[${e.name}] ${req.body.subject}: ${req.body.body}`.slice(0, 1400), { category: 'event_updates' });
  }
  await audit(req, 'communication.sent', { orgId: req.org.id, entity: 'event', entityId: e.id, detail: { subject: req.body.subject, count: n, phone: m } });
  res.flash('success', `Mensagem enviada para ${n} destinatário(s) por e-mail${m ? ` e ${m} por WhatsApp/SMS` : ''}.`);
  res.redirect(303, `/organizador/eventos/${e.id}/comunicacao`);
});

// ---------- Kits e check-in (interface móvel) ----------
async function findRegs(e, q) {
  const t = String(q || '').trim(); if (!t) return [];
  const tok = t.includes('/k/') ? t.split('/k/').pop() : t;
  return await db.all(`SELECT g.*, m.name modality, k.name kit, o.status order_status, (SELECT picked_at FROM kit_pickups WHERE registration_id=g.id) picked FROM registrations g JOIN modalities m ON m.id=g.modality_id LEFT JOIN kits k ON k.id=g.kit_id JOIN orders o ON o.id=g.order_id
    WHERE g.event_id=? AND (g.qr_token=? OR g.bib=? OR g.name ILIKE ? OR (length(?)>=4 AND g.cpf ILIKE ?)) ORDER BY g.name LIMIT 30`, e.id, tok, t, `%${t}%`, t.replace(/\D/g, ''), `%${t.replace(/\D/g, '') || '§'}%`);
}
r.get('/eventos/:id/checkin', async (req, res) => {
  const e = await ev(req, 'kits'); const pts = await db.all('SELECT * FROM pickup_points WHERE event_id=?', e.id);
  const list = await findRegs(e, req.query.q);
  const totals = await db.one("SELECT (SELECT COUNT(*) FROM registrations WHERE event_id=? AND status='confirmed') total, (SELECT COUNT(*) FROM kit_pickups k JOIN registrations g ON g.id=k.registration_id WHERE g.event_id=?) given, (SELECT COUNT(*) FROM checkins c JOIN registrations g ON g.id=c.registration_id WHERE g.event_id=?) present", e.id, e.id, e.id);
  const point = req.query.ponto || req.cookies.ponto || '';
  res.page({ title: 'Kits e check-in', body: html`${await tabs(req, e, '/checkin')}
  <section class="card mobile-op"><p>${totals.given}/${totals.total} kits entregues · ${totals.present} check-ins de presença</p>
  <form method="get" class="op-search">${pts.length ? field('ponto', 'Ponto de retirada', { value: point, options: pts.map((p) => [p.id, p.name]) }) : ''}${field('q', 'QR Code, número, nome ou CPF', { value: req.query.q, attrs: 'autofocus autocomplete="off"', hint: 'Leitores de QR Code funcionam como teclado: posicione o cursor aqui e leia o código.' })}<button class="btn btn-block">Buscar</button></form>
  ${req.query.q && !list.length ? empty('Nenhuma inscrição encontrada.') : ''}
  ${await Promise.all(list.map(async (g) => html`<article class="op-card ${g.picked ? 'is-done' : ''}"><h3>${g.name} <small>nº ${g.bib || '—'}</small></h3>
    <p>${g.modality} · ${g.kit || 'sem kit'} ${g.kit_size ? `· camiseta ${g.kit_size}` : ''}</p><p>CPF ${maskCpf(g.cpf)} ${g.guardian_name ? `· responsável: ${g.guardian_name}` : ''}</p>
    <p>${badge(...REG_STATUS[g.status])} ${g.picked ? badge(`Kit entregue em ${fmtDateTime(g.picked, e.timezone)}`, 'ok') : ''}</p>
    ${(await db.all('SELECT i.*, v.label, p.name FROM order_items i JOIN product_variants v ON v.id=i.variant_id JOIN products p ON p.id=v.product_id WHERE i.order_id=? AND i.status=\'paid\'', g.order_id)).map((i) => html`<p>Produto extra: ${i.qty}× ${i.name} (${i.label}) ${i.picked_up_at ? badge('entregue', 'ok') : ''}</p>`)}
    ${g.status === 'confirmed' && !g.picked ? html`<form method="post" action="/organizador/eventos/${e.id}/checkin/${g.id}/kit" class="stack">${csrf(req)}<input type="hidden" name="ponto" value="${point}">
      ${e.allow_third_party_pickup ? html`<details><summary>Retirada por terceiro</summary>${field('third_name', 'Nome de quem retira', { id: `tn-${g.id}` })}${field('third_doc', 'Documento de quem retira', { id: `td-${g.id}` })}</details>` : ''}
      <button class="btn btn-lg btn-block">Entregar kit</button></form>` : ''}
    ${g.status === 'confirmed' ? html`<form method="post" action="/organizador/eventos/${e.id}/checkin/${g.id}/presenca">${csrf(req)}<input type="hidden" name="ponto" value="${point}"><button class="btn btn-ghost btn-block">Registrar check-in de presença</button></form>` : html`<p class="err">Inscrição não confirmada: não entregar kit.</p>`}</article>`))}</section>` });
});
r.post('/eventos/:id/checkin/:gid/kit', async (req, res) => {
  const e = await ev(req, 'kits');
  const g = await db.one('SELECT * FROM registrations WHERE id=? AND event_id=?', Number(req.params.gid), e.id);
  if (!g) throw new UserError('Inscrição não encontrada.', 404);
  if (g.status !== 'confirmed') throw new UserError('Inscrição não confirmada: kit não pode ser entregue.');
  const third = req.body.third_name?.trim();
  if (third && !e.allow_third_party_pickup) throw new UserError('Este evento não permite retirada por terceiros.');
  if (third && !req.body.third_doc?.trim()) throw new UserError('Informe o documento de quem retira.');
  const point = (await db.one('SELECT id FROM pickup_points WHERE id=? AND event_id=?', Number(req.body.ponto) || 0, e.id))?.id ?? null;
  try {
    await db.tx(async () => {
      await db.run('INSERT INTO kit_pickups(registration_id,operator_id,point_id,third_party_name,third_party_doc) VALUES(?,?,?,?,?)', g.id, req.user.id, point, third || null, third ? req.body.third_doc.trim().slice(0, 40) : null);
      await db.run("UPDATE order_items SET picked_up_at=?, picked_up_by=? WHERE order_id=? AND status='paid' AND picked_up_at IS NULL", nowIso(), req.user.id, g.order_id);
    });
  } catch (err) {
    if (err.code !== '23505' && !String(err.message).includes('UNIQUE')) throw err;
    const k = await db.one('SELECT k.*, u.name op, p.name pt FROM kit_pickups k JOIN users u ON u.id=k.operator_id LEFT JOIN pickup_points p ON p.id=k.point_id WHERE registration_id=?', g.id);
    throw new UserError(`Kit JÁ ENTREGUE em ${fmtDateTime(k.picked_at, e.timezone)} por ${k.op}${k.pt ? ` (${k.pt})` : ''}${k.third_party_name ? `, retirado por ${k.third_party_name}` : ''}.`, 409);
  }
  await audit(req, 'kit.delivered', { orgId: req.org.id, entity: 'registration', entityId: g.id, detail: { point, third: !!third } });
  const u = await db.one('SELECT id, email FROM users WHERE id=?', g.buyer_user_id);
  await require('../lib/delivery').queueUserMessage(u.id, `${e.name}: kit da inscrição nº ${g.bib} retirado${third ? ` por ${third}` : ''}.`);
  await sendMail(u.email, `Kit retirado — ${e.name}`, `O kit da inscrição nº ${g.bib} foi retirado${third ? ` por ${third}` : ''} em ${fmtDateTime(nowIso(), e.timezone)}.`, 'kit');
  res.flash('success', `Kit de ${g.name} entregue.`);
  if (point) res.setCookie('ponto', String(point), { maxAge: 864e5 });
  res.redirect(303, `/organizador/eventos/${e.id}/checkin`);
});
r.post('/eventos/:id/checkin/:gid/presenca', async (req, res) => {
  const e = await ev(req, 'kits');
  const g = await db.one("SELECT * FROM registrations WHERE id=? AND event_id=? AND status='confirmed'", Number(req.params.gid), e.id);
  if (!g) throw new UserError('Inscrição não confirmada.');
  const r0 = await db.run('INSERT INTO checkins(registration_id,operator_id,point_id) VALUES(?,?,?) ON CONFLICT DO NOTHING', g.id, req.user.id, Number(req.body.ponto) || null);
  if (!r0.changes) throw new UserError('Check-in de presença já registrado para este atleta.', 409);
  await audit(req, 'checkin.registered', { orgId: req.org.id, entity: 'registration', entityId: g.id });
  res.flash('success', `Check-in de ${g.name} registrado.`);
  res.redirect(303, `/organizador/eventos/${e.id}/checkin`);
});

// ---------- Resultados ----------
const VSTATUS = { draft: ['Rascunho', 'muted'], preliminary: ['Preliminar publicado', 'warn'], official: ['Oficial publicado', 'ok'], superseded: ['Substituída', 'muted'] };
r.get('/eventos/:id/resultados', async (req, res) => {
  const e = await ev(req, 'timing');
  const versions = await db.all('SELECT * FROM result_versions WHERE event_id=? ORDER BY version DESC', e.id);
  const reviews = await db.all('SELECT v.*, g.name, g.bib FROM result_reviews v JOIN registrations g ON g.id=v.registration_id WHERE v.event_id=? ORDER BY v.status=\'open\' DESC, v.id DESC', e.id);
  const sel = versions.find((v) => v.id === Number(req.query.versao)) || versions[0];
  const rows = sel ? await results.versionRows(sel.id) : [];
  res.page({ title: 'Resultados', wide: true, body: html`${await tabs(req, e, '/resultados')}
  <section class="card"><h2>Importar resultados</h2>${tip('Baixe o modelo, preencha (separador ";" ou ","), envie e confira a prévia. Nada é salvo antes da sua confirmação. Integração direta com cronometragem por API: etapa seguinte (veja /api/docs).')}
  <p><a class="btn btn-ghost btn-sm" href="/organizador/eventos/${e.id}/resultados/modelo.csv">Baixar modelo CSV</a></p>
  <form method="post" action="/organizador/eventos/${e.id}/resultados/previa" enctype="multipart/form-data">${csrf(req)}<div class="field"><label for="file">Arquivo CSV</label><input type="file" id="file" name="file" accept=".csv,text/csv" required></div><button class="btn">Ver prévia</button></form></section>
  <section class="card"><h2>Versões</h2>${table(['Versão', 'Situação', 'Observação', 'Criada', 'Publicada', 'Ações'], versions.map((v) => [String(v.version), badge(...VSTATUS[v.status]), v.note || '—', fmtDateTime(v.created_at, e.timezone), fmtDateTime(v.published_at, e.timezone),
    html`<a href="?versao=${v.id}">Ver</a> ${['draft', 'preliminary'].includes(v.status) ? html`<form method="post" action="/organizador/eventos/${e.id}/resultados/${v.id}/publicar" class="inline">${csrf(req)}${v.status === 'draft' ? html`<button name="status" value="preliminary" class="btn btn-sm btn-ghost">Publicar preliminar</button>` : ''} <button name="status" value="official" class="btn btn-sm">Publicar oficial</button></form>` : ''}`]), { emptyMsg: 'Nenhuma importação ainda.' })}</section>
  ${sel ? html`<section class="card"><h2>Versão ${sel.version}</h2>${table(['Pos.', 'Nº', 'Nome', 'Modalidade', 'Categoria (pos.)', 'Bruto', 'Líquido', 'Ritmo', 'Situação'], rows.map((x) => [x.rank_overall ?? '—', x.bib, x.name, x.modality_name, `${x.category_name || '—'} (${x.rank_category ?? '—'})`, fmtDuration(x.gun_s), fmtDuration(x.net_s), fmtPace(x.pace_s_km), results.RESULT_STATUS[x.status]]))}
    <details><summary>Corrigir um resultado (gera nova versão)</summary><form method="post" action="/organizador/eventos/${e.id}/resultados/${sel.id}/corrigir">${csrf(req)}<div class="row">${field('bib', 'Número de peito', { required: true })}${field('gun', 'Tempo bruto', { placeholder: 'hh:mm:ss' })}${field('net', 'Tempo líquido', { placeholder: 'hh:mm:ss' })}${field('status', 'Situação', { options: Object.entries(results.RESULT_STATUS) })}</div>${field('note', 'Motivo da correção', { required: true })}<button class="btn btn-sm">Gerar versão corrigida</button></form></details></section>` : ''}
  <section class="card"><h2>Pedidos de revisão dos atletas</h2>${table(['Data', 'Atleta', 'Mensagem', 'Situação', 'Resposta'], reviews.map((v) => [fmtDateTime(v.created_at, e.timezone), `${v.name} (${v.bib})`, v.message, v.status === 'open' ? badge('Aberto', 'warn') : badge('Respondido', 'ok'),
    v.status === 'open' ? html`<form method="post" action="/organizador/eventos/${e.id}/resultados/revisao/${v.id}" class="inline">${csrf(req)}<input name="response" aria-label="Resposta" required> <button class="btn btn-sm">Responder</button></form>` : v.response]), { emptyMsg: 'Nenhum pedido de revisão.' })}</section>` });
});
r.get('/eventos/:id/resultados/modelo.csv', async (req, res) => { await ev(req, 'timing'); res.type('text/csv').attachment('modelo-resultados.csv').send(results.TEMPLATE_CSV); });
r.post('/eventos/:id/resultados/previa', upload(5).single('file'), csrfAfterMultipart, async (req, res) => {
  const e = await ev(req, 'timing');
  const text = req.file ? req.file.buffer.toString('utf8') : String(req.body.csv || '');
  const pv = await results.preview(e.id, text);
  const bad = pv.rows.filter((x) => x.errors.length);
  res.page({ title: 'Prévia da importação', wide: true, body: html`${await tabs(req, e, '/resultados')}<section class="card"><h2>Prévia da importação</h2>${errorsBox(pv.errors)}
  <p>${pv.rows.length} linha(s): ${badge(`${pv.valid} válidas`, 'ok')} ${bad.length ? badge(`${bad.length} com erro`, 'danger') : ''}</p>
  ${bad.length ? html`<h3>Relatório de erros</h3>${table(['Linha', 'Nº', 'Erros'], bad.map((x) => [String(x.line), x.bib, x.errors.join('; ')]))}` : ''}
  ${table(['Linha', 'Nº', 'Nome', 'Modalidade', 'Bruto', 'Líquido', 'Situação', 'Validação'], pv.rows.slice(0, 300).map((x) => [String(x.line), x.bib, x.name, x.modality_name || '—', fmtDuration(x.gun_s), fmtDuration(x.net_s), results.RESULT_STATUS[x.status] || '—', x.errors.length ? badge('Erro', 'danger') : badge('OK', 'ok')]))}
  ${pv.valid ? html`<form method="post" action="/organizador/eventos/${e.id}/resultados/salvar">${csrf(req)}<textarea name="csv" hidden>${text}</textarea>${field('note', 'Observação da versão', { value: 'Importação de planilha' })}
  ${bad.length ? field('ignore_errors', `Salvar somente as ${pv.valid} linhas válidas (as linhas com erro serão descartadas)`, { type: 'checkbox', required: true }) : ''}<button class="btn">Salvar como nova versão (rascunho)</button> <a href="/organizador/eventos/${e.id}/resultados">Cancelar</a></form>` : ''}</section>` });
});
r.post('/eventos/:id/resultados/salvar', async (req, res) => {
  const e = await ev(req, 'timing');
  const pv = await results.preview(e.id, String(req.body.csv || ''));
  const bad = pv.rows.filter((x) => x.errors.length);
  if (bad.length && !req.body.ignore_errors) throw new UserError('Há linhas com erro. Corrija o arquivo ou confirme salvar somente as válidas.');
  const valid = pv.rows.filter((x) => !x.errors.length);
  if (!valid.length) throw new UserError('Nenhuma linha válida.');
  const vid = await results.saveVersion(e.id, valid, req.user.id, req.body.note);
  await audit(req, 'results.imported', { orgId: req.org.id, entity: 'event', entityId: e.id, detail: { version: vid, rows: valid.length, discarded: bad.length } });
  res.flash('success', 'Versão salva como rascunho. Revise e publique como preliminar ou oficial.');
  res.redirect(303, `/organizador/eventos/${e.id}/resultados?versao=${vid}`);
});
r.post('/eventos/:id/resultados/:vid/publicar', async (req, res) => {
  const e = await ev(req, 'timing');
  const v = await db.one('SELECT * FROM result_versions WHERE id=? AND event_id=?', Number(req.params.vid), e.id);
  if (!v) throw new UserError('Versão não encontrada.', 404);
  const status = req.body.status === 'official' ? 'official' : 'preliminary';
  await results.publish(v.id, status);
  const emails = await db.all("SELECT DISTINCT u.email FROM registrations g JOIN users u ON u.id=g.buyer_user_id WHERE g.event_id=? AND g.status='confirmed'", e.id);
  for (const x of emails) await sendMail(x.email, `Resultados ${status === 'official' ? 'oficiais' : 'preliminares'} — ${e.name}`, `Os resultados foram publicados: ${config.baseUrl}/e/${e.slug}/resultados${status === 'preliminary' ? `\nVocê pode solicitar revisão em até ${e.review_days} dia(s) pelo seu painel.` : ''}`, 'results');
  await audit(req, 'results.published', { orgId: req.org.id, entity: 'event', entityId: e.id, detail: { version: v.version, status } });
  res.flash('success', `Versão ${v.version} publicada como ${status === 'official' ? 'oficial' : 'preliminar'}.`);
  res.redirect(303, `/organizador/eventos/${e.id}/resultados`);
});
r.post('/eventos/:id/resultados/:vid/corrigir', async (req, res) => {
  const e = await ev(req, 'timing');
  const v = await db.one('SELECT * FROM result_versions WHERE id=? AND event_id=?', Number(req.params.vid), e.id);
  if (!v) throw new UserError('Versão não encontrada.', 404);
  if (!req.body.note) throw new UserError('Informe o motivo da correção.');
  const row = await db.one('SELECT * FROM results WHERE version_id=? AND bib=?', v.id, String(req.body.bib));
  if (!row) throw new UserError('Número não encontrado nesta versão.');
  const patch = { status: results.RESULT_STATUS[req.body.status] ? req.body.status : row.status };
  if (req.body.gun) { patch.gun_s = parseDuration(req.body.gun); if (Number.isNaN(patch.gun_s)) throw new UserError('Tempo bruto inválido.'); }
  if (req.body.net) { patch.net_s = parseDuration(req.body.net); if (Number.isNaN(patch.net_s)) throw new UserError('Tempo líquido inválido.'); }
  const vid = await results.correct(v.id, row.bib, patch, req.user.id, req.body.note);
  await audit(req, 'results.corrected', { orgId: req.org.id, entity: 'event', entityId: e.id, detail: { from: v.version, bib: row.bib, patch, note: req.body.note } });
  res.flash('success', 'Versão corrigida criada como rascunho. Publique para substituir a anterior.');
  res.redirect(303, `/organizador/eventos/${e.id}/resultados?versao=${vid}`);
});
r.post('/eventos/:id/resultados/revisao/:rid', async (req, res) => {
  const e = await ev(req, 'timing');
  const v = await db.one("SELECT * FROM result_reviews WHERE id=? AND event_id=? AND status='open'", Number(req.params.rid), e.id);
  if (!v) throw new UserError('Pedido não encontrado.');
  await db.run("UPDATE result_reviews SET status='answered', response=?, responded_by=?, responded_at=? WHERE id=?", String(req.body.response || '').slice(0, 1000), req.user.id, nowIso(), v.id);
  const u = await db.one('SELECT email FROM users WHERE id=?', v.user_id);
  await sendMail(u.email, `Resposta à revisão de resultado — ${e.name}`, String(req.body.response || ''), 'results');
  await audit(req, 'results.review_answered', { orgId: req.org.id, entity: 'result_review', entityId: v.id });
  res.redirect(303, `/organizador/eventos/${e.id}/resultados`);
});

module.exports = r;
