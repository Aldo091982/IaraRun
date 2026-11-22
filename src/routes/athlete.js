'use strict';
const express = require('express');
const QRCode = require('qrcode');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDate, fmtDateTime, fmtDuration, fmtPace, parseDuration, json, UserError, NotFound, nowIso, code, addMinutes } = require('../lib/util');
const { isCpf, digits, fmtCpf, isEmail } = require('../lib/docs');
const { counts, currentLot } = require('../lib/events');
const { currentPublished, RESULT_STATUS } = require('../lib/results');
const { audit, recordConsent, sendMail } = require('../lib/core');
const { requireUser, upload, checkFile, store, csrfAfterMultipart } = require('../lib/guards');
const { ORDER_STATUS } = require('./checkout');
const { csrf, field, badge, table, tip, empty, avatar } = require('../views/layout');

const r = express.Router();
r.use(requireUser);

const NOTIFY = { payments: 'Pagamentos (aprovado/pendente)', kit: 'Retirada de kit', event_updates: 'Alterações nos eventos em que estou inscrito', results: 'Publicação de resultados', reminders: 'Lembretes de provas e abertura de inscrições dos favoritos' };

async function myRegs(userId) {
  return await db.all(`SELECT g.*, e.name event_name, e.slug, e.start_utc, e.timezone, e.status event_status, e.change_deadline_utc, e.allow_modality_change, e.allow_shirt_change, e.allow_transfer, e.change_fee_cents, e.review_days,
    m.name modality, m.distance_km, c.name category, k.name kit, o.code, o.status order_status, (SELECT picked_at FROM kit_pickups WHERE registration_id=g.id) picked
    FROM registrations g JOIN events e ON e.id=g.event_id JOIN modalities m ON m.id=g.modality_id LEFT JOIN categories c ON c.id=g.category_id LEFT JOIN kits k ON k.id=g.kit_id JOIN orders o ON o.id=g.order_id
    WHERE (g.buyer_user_id=? OR g.user_id=?) AND g.status IN ('confirmed','reserved','cancelled','refunded') ORDER BY e.start_utc DESC`, userId, userId);
}
const accountNav = (active) => html`<nav class="subnav" aria-label="Minha conta">${[['/minha-conta', 'Inscrições'], ['/minha-conta/historico', 'Histórico e resultados'], ['/minha-conta/favoritos', 'Favoritos e agenda'], ['/minha-conta/perfil', 'Perfil'], ['/minha-conta/preferencias', 'Privacidade e comunicação']].map(([h, l]) => html`<a href="${h}" ${active === h ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;

r.get('/', async (req, res) => {
  const regs = await myRegs(req.user.id);
  const upcoming = regs.filter((g) => g.start_utc >= new Date(Date.now() - 864e5).toISOString());
  const orders = await db.all("SELECT o.*, e.name FROM orders o JOIN events e ON e.id=o.event_id WHERE o.user_id=? ORDER BY o.id DESC LIMIT 20", req.user.id);
  const requests = await db.all('SELECT q.*, g.name, e.name event_name FROM requests q JOIN registrations g ON g.id=q.registration_id JOIN events e ON e.id=g.event_id WHERE q.user_id=? ORDER BY q.id DESC LIMIT 20', req.user.id);
  const draft = await db.one('SELECT * FROM onboarding_drafts WHERE user_id=?', req.user.id);
  const draftOpen = draft && (!draft.org_id || await db.one("SELECT 1 FROM organizations WHERE id=? AND status='onboarding'", draft.org_id));
  const qrs = {};
  for (const g of upcoming.filter((x) => x.status === 'confirmed')) qrs[g.id] = await QRCode.toString(`${config.baseUrl}/k/${g.qr_token}`, { type: 'svg', margin: 1, width: 160 });
  res.page({ title: 'Minha conta', wide: true, body: html`<h1>Olá, ${req.user.name.split(' ')[0]}!</h1>${accountNav('/minha-conta')}
  ${req.user.email_verified_at ? '' : html`<div class="alert alert-warn">Confirme seu e-mail para receber avisos importantes. <form method="post" action="/reenviar-confirmacao" class="inline">${csrf(req)}<button class="linklike">Reenviar link</button></form></div>`}
  ${draftOpen ? html`<div class="alert alert-info">Você tem um cadastro de organizador em andamento (etapa ${draft.step} de 4). <a href="/organizador/cadastro">Continuar</a></div>` : ''}
  <section><h2>Próximas provas</h2>${upcoming.length ? html`<div class="grid">${upcoming.map((g) => html`<article class="card reg-card">
    <h3><a href="/e/${g.slug}">${g.event_name}</a></h3><p>${fmtDate(g.start_utc, g.timezone)} · ${g.modality}${g.category ? ` · ${g.category}` : ''}</p>
    <p>${g.name} ${g.bib ? html`· <strong>nº ${g.bib}</strong>` : ''}</p>
    <p>${g.status === 'confirmed' ? badge('Confirmada', 'ok') : g.status === 'reserved' ? html`${badge('Aguardando pagamento', 'warn')} <a href="/pedido/${g.code}">Pagar</a>` : badge(g.status === 'refunded' ? 'Reembolsada' : 'Cancelada', 'muted')} ${g.picked ? badge('Kit retirado', 'ok') : ''}</p>
    ${g.status === 'confirmed' && !g.picked ? html`<details><summary>QR Code para retirada do kit</summary><div class="qr" role="img" aria-label="QR Code de retirada">${raw(qrs[g.id])}</div><p class="muted">O código não contém seus dados pessoais.</p></details>` : ''}
    <p><a href="/pedido/${g.code}">Comprovante</a>${g.status === 'confirmed' ? html` · <a href="/minha-conta/inscricao/${g.id}/servicos">Serviços e alterações</a>` : ''}</p></article>`)}</div>` : empty('Você ainda não tem inscrições futuras.', html`<a class="btn" href="/eventos">Encontrar eventos</a>`)}</section>
  <section class="card"><h2>Pagamentos e pedidos</h2>${table(['Pedido', 'Evento', 'Total', 'Situação', 'Data'], orders.map((o) => [html`<a href="/pedido/${o.code}">${o.code}</a>`, o.name, brl(o.total_cents), badge(...(ORDER_STATUS[o.status] || [o.status, 'muted'])), fmtDateTime(o.created_at)]), { emptyMsg: 'Nenhum pedido.' })}</section>
  <section class="card"><h2>Minhas solicitações</h2>${table(['Evento', 'Tipo', 'Situação', 'Resposta'], requests.map((q) => [q.event_name, q.type, q.status === 'open' ? badge('Em análise', 'warn') : badge(q.status === 'approved' ? 'Aprovada' : 'Recusada', q.status === 'approved' ? 'ok' : 'muted'), q.response || '—']), { emptyMsg: 'Nenhuma solicitação.' })}</section>` });
});

// ---------- Menu de serviços do participante ----------
async function loadReg(req) {
  const g = (await myRegs(req.user.id)).find((x) => x.id === Number(req.params.id));
  if (!g) throw new NotFound('Inscrição não encontrada.');
  return g;
}
const withinDeadline = (g) => !g.change_deadline_utc || g.change_deadline_utc > nowIso();
r.get('/inscricao/:id/servicos', async (req, res) => {
  const g = await loadReg(req);
  const mods = await db.all('SELECT * FROM modalities WHERE event_id=? AND id<>?', g.event_id, g.modality_id);
  const sizes = g.kit_id ? await db.all('SELECT * FROM kit_sizes WHERE kit_id=? AND size<>?', g.kit_id, g.kit_size || '') : [];
  const variants = await db.all('SELECT v.*, p.name, p.price_cents FROM product_variants v JOIN products p ON p.id=v.product_id WHERE p.event_id=? AND p.active=1', g.event_id);
  const open = withinDeadline(g) && g.status === 'confirmed' && ['published', 'closed'].includes(g.event_status);
  const fee = g.change_fee_cents;
  const result = await currentPublished(g.event_id);
  res.page({ title: 'Serviços da inscrição', wide: true, body: html`<p><a href="/minha-conta">← Minhas inscrições</a></p><h1>Serviços — ${g.event_name}</h1><p>${g.name} · ${g.modality} · nº ${g.bib || '—'}</p>
  ${tip(`Alterações seguem as regras do evento${g.change_deadline_utc ? ` e são aceitas até ${fmtDateTime(g.change_deadline_utc, g.timezone)}` : ''}. ${fee ? `Taxa por alteração: ${brl(fee)}.` : 'Alterações sem taxa.'} Alterações pagas só valem após a confirmação do pagamento; sua inscrição atual permanece válida até lá.`)}
  ${!open ? html`<div class="alert alert-warn">Prazo de alterações encerrado ou inscrição não confirmada.</div>` : ''}
  <div class="grid">
  ${g.allow_modality_change && mods.length ? html`<section class="card"><h2>Trocar modalidade/distância</h2><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/modalidade">${csrf(req)}${field('modality_id', 'Nova modalidade', { options: await Promise.all(mods.map(async (m) => { const l = await currentLot(g.event_id, m.id); const full = !l || (m.capacity != null && await counts.modality(m.id) >= m.capacity); return [m.id, `${m.name} ${full ? '(sem vagas)' : `— diferença ${brl(Math.max(0, l.price_cents - g.price_cents) + fee)}`}`]; })) })}<button class="btn" ${open ? '' : 'disabled'}>Solicitar troca</button></form></section>` : ''}
  ${g.allow_shirt_change && sizes.length ? html`<section class="card"><h2>Trocar tamanho da camiseta</h2><p>Atual: ${g.kit_size}</p><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/camiseta">${csrf(req)}${field('kit_size', 'Novo tamanho', { options: await Promise.all(sizes.map(async (s) => [s.size, `${s.size}${await counts.size(g.kit_id, s.size) >= s.stock ? ' (esgotado)' : ''}`])) })}<button class="btn" ${open && !g.picked ? '' : 'disabled'}>Trocar${fee ? ` (${brl(fee)})` : ''}</button></form></section>` : ''}
  ${g.allow_transfer ? html`<section class="card"><h2>Transferir titularidade</h2><p class="muted">Sujeito à aprovação do organizador.</p><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/transferir">${csrf(req)}${field('name', 'Nome do novo titular', { required: true })}${field('cpf', 'CPF', { required: true })}${field('birth_date', 'Nascimento', { type: 'date', required: true })}${field('gender', 'Sexo', { options: [['F', 'Feminino'], ['M', 'Masculino']] })}${field('email', 'E-mail', { type: 'email', required: true })}<button class="btn" ${open && !g.picked ? '' : 'disabled'}>Solicitar transferência</button></form></section>` : ''}
  ${variants.length ? html`<section class="card"><h2>Comprar produtos extras</h2><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/produtos">${csrf(req)}${await Promise.all(variants.map(async (v) => field(`x[v${v.id}]`, `${v.name} — ${v.label} (${brl(v.price_cents)})${v.stock - await counts.variant(v.id) <= 0 ? ' — esgotado' : ''}`, { type: 'number', value: 0, attrs: 'min="0" max="10"', id: `sx-${v.id}` })))}<button class="btn">Comprar</button></form></section>` : ''}
  <section class="card"><h2>Cancelar com reembolso</h2><p class="muted">Conforme a política de cancelamento do evento. O organizador analisa a solicitação.</p><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/cancelar" data-confirm="Solicitar cancelamento desta inscrição?">${csrf(req)}${field('reason', 'Motivo', { type: 'textarea', required: true })}<button class="btn btn-danger" ${open ? '' : 'disabled'}>Solicitar cancelamento</button></form></section>
  ${result ? html`<section class="card"><h2>Revisão de resultado</h2><form method="post" action="/minha-conta/inscricao/${g.id}/servicos/revisao">${csrf(req)}${field('message', 'Descreva o problema (tempo, categoria, situação)', { type: 'textarea', required: true })}<button class="btn">Solicitar revisão</button></form></section>` : ''}
  </div>` });
});
async function openRequest(req, g, type, payload, reason) {
  if (await db.one("SELECT 1 FROM requests WHERE registration_id=? AND type=? AND status='open'", g.id, type)) throw new UserError('Já existe uma solicitação desse tipo em análise.');
  await db.run('INSERT INTO requests(registration_id,user_id,type,payload,reason) VALUES(?,?,?,?,?)', g.id, req.user.id, type, JSON.stringify(payload || {}), reason || null);
  await audit(req, `request.created.${type}`, { entity: 'registration', entityId: g.id });
}
async function changeOrder(req, g, total, payload) {
  const ev = await db.one('SELECT * FROM events WHERE id=?', g.event_id);
  const c = code('A');
  await db.run("INSERT INTO orders(code,user_id,event_id,kind,status,subtotal_cents,total_cents,expires_at,related_registration_id,change_payload) VALUES(?,?,?,'change','pending',?,?,?,?,?)", c, req.user.id, g.event_id, total, total, addMinutes(ev.reservation_minutes), g.id, JSON.stringify(payload));
  return c;
}
const ensureOpen = (g) => { if (!(withinDeadline(g) && g.status === 'confirmed')) throw new UserError('Prazo de alterações encerrado ou inscrição não confirmada.'); };
r.post('/inscricao/:id/servicos/modalidade', async (req, res) => {
  const g = await loadReg(req); ensureOpen(g);
  if (!g.allow_modality_change) throw new UserError('Este evento não permite troca de modalidade.');
  const m = await db.one('SELECT * FROM modalities WHERE id=? AND event_id=?', Number(req.body.modality_id), g.event_id);
  if (!m) throw new UserError('Modalidade inválida.');
  const lot = await currentLot(g.event_id, m.id);
  if (!lot || (m.capacity != null && await counts.modality(m.id) >= m.capacity)) throw new UserError('Sem vagas na modalidade escolhida.', 409);
  const total = Math.max(0, lot.price_cents - g.price_cents) + g.change_fee_cents;
  if (total > 0) return res.redirect(303, `/pedido/${await changeOrder(req, g, total, { modality_id: m.id, lot_id: lot.id })}`);
  await db.tx(async () => {
    if (m.capacity != null && await counts.modality(m.id) >= m.capacity) throw new UserError('Sem vagas.', 409);
    const { assignCategory } = require('../lib/orders');
    const cat = await assignCategory(g.event_id, m.id, g.gender, g.birth_date, g.start_utc);
    await db.run('UPDATE registrations SET modality_id=?, lot_id=?, category_id=? WHERE id=?', m.id, lot.id, cat?.id ?? null, g.id);
  });
  await audit(req, 'registration.changed', { entity: 'registration', entityId: g.id, detail: { modality_id: m.id } });
  res.flash('success', 'Modalidade alterada.');
  res.redirect(303, '/minha-conta');
});
r.post('/inscricao/:id/servicos/camiseta', async (req, res) => {
  const g = await loadReg(req); ensureOpen(g);
  if (!g.allow_shirt_change || g.picked) throw new UserError('Troca de camiseta indisponível.');
  const s = await db.one('SELECT * FROM kit_sizes WHERE kit_id=? AND size=?', g.kit_id, String(req.body.kit_size));
  if (!s || await counts.size(g.kit_id, s.size) >= s.stock) throw new UserError('Tamanho esgotado.', 409);
  if (g.change_fee_cents > 0) return res.redirect(303, `/pedido/${await changeOrder(req, g, g.change_fee_cents, { kit_size: s.size })}`);
  await db.tx(async () => { if (await counts.size(g.kit_id, s.size) >= s.stock) throw new UserError('Tamanho esgotado.', 409); await db.run('UPDATE registrations SET kit_size=? WHERE id=?', s.size, g.id); });
  await audit(req, 'registration.changed', { entity: 'registration', entityId: g.id, detail: { kit_size: s.size } });
  res.flash('success', 'Tamanho alterado.');
  res.redirect(303, '/minha-conta');
});
r.post('/inscricao/:id/servicos/transferir', async (req, res) => {
  const g = await loadReg(req); ensureOpen(g);
  if (!g.allow_transfer) throw new UserError('Transferência não permitida neste evento.');
  const b = req.body;
  if (!b.name || !isCpf(b.cpf) || !b.birth_date || !isEmail(b.email)) throw new UserError('Preencha nome, CPF válido, nascimento e e-mail do novo titular.');
  await openRequest(req, g, 'transfer', { name: b.name.trim(), cpf: digits(b.cpf), birth_date: b.birth_date, gender: b.gender === 'M' ? 'M' : 'F', email: b.email.trim() });
  res.flash('success', 'Solicitação de transferência enviada ao organizador.');
  res.redirect(303, '/minha-conta');
});
r.post('/inscricao/:id/servicos/cancelar', async (req, res) => {
  const g = await loadReg(req); ensureOpen(g);
  if (!req.body.reason) throw new UserError('Informe o motivo.');
  await openRequest(req, g, 'cancel', {}, String(req.body.reason).slice(0, 1000));
  res.flash('success', 'Solicitação de cancelamento enviada. Acompanhe a resposta nesta página.');
  res.redirect(303, '/minha-conta');
});
r.post('/inscricao/:id/servicos/produtos', async (req, res) => {
  const g = await loadReg(req);
  const extras = Object.entries(req.body.x || {}).map(([variant_id, qty]) => ({ variant_id: Number(String(variant_id).replace(/^v/, '')), qty: Number(qty) })).filter((x) => x.qty > 0);
  if (!extras.length) throw new UserError('Selecione ao menos um produto.');
  const { createOrder } = require('../lib/orders');
  const o = await createOrder({ user: req.user, eventId: g.event_id, participants: [], extras, acceptRegulation: true, req });
  await db.run('UPDATE order_items SET registration_id=? WHERE order_id=?', g.id, o.id);
  res.redirect(303, `/pedido/${o.code}`);
});
r.post('/inscricao/:id/servicos/revisao', async (req, res) => {
  const g = await loadReg(req);
  const v = await currentPublished(g.event_id);
  if (!v) throw new UserError('Resultados ainda não publicados.');
  const deadline = new Date(new Date(v.published_at).getTime() + g.review_days * 864e5).toISOString();
  if (v.status === 'official' && deadline < nowIso()) throw new UserError('Prazo de revisão encerrado.');
  if (!req.body.message) throw new UserError('Descreva o problema.');
  await db.run('INSERT INTO result_reviews(event_id,registration_id,user_id,message) VALUES(?,?,?,?)', g.event_id, g.id, req.user.id, String(req.body.message).slice(0, 1000));
  res.flash('success', 'Pedido de revisão enviado ao organizador.');
  res.redirect(303, '/minha-conta/historico');
});

// ---------- Histórico, recordes e certificados ----------
async function history(userId) {
  return await db.all(`SELECT res.*, e.name event_name, e.slug, e.start_utc, e.timezone, m.distance_km, m.name modality, c.name category, v.status vstatus, g.id reg_id
    FROM registrations g JOIN events e ON e.id=g.event_id JOIN result_versions v ON v.event_id=e.id AND v.status IN ('preliminary','official')
    JOIN results res ON res.version_id=v.id AND res.registration_id=g.id LEFT JOIN modalities m ON m.id=res.modality_id LEFT JOIN categories c ON c.id=res.category_id
    WHERE (g.user_id=? OR (g.buyer_user_id=? AND g.cpf=(SELECT cpf FROM users WHERE id=?))) AND v.version=(SELECT MAX(version) FROM result_versions WHERE event_id=e.id AND status IN ('preliminary','official')) ORDER BY e.start_utc`, userId, userId, userId);
}
r.get('/historico', async (req, res) => {
  const h = await history(req.user.id);
  const manual = await db.all('SELECT * FROM athlete_records WHERE user_id=? ORDER BY date', req.user.id);
  const all = [...h.filter((x) => x.status === 'finished').map((x) => ({ d: x.distance_km, t: x.net_s ?? x.gun_s, date: x.start_utc, src: 'Oficial (organizador)', name: x.event_name })), ...manual.map((x) => ({ d: x.distance_km, t: x.time_s, date: x.date, src: 'Registro pessoal', name: x.event_name }))];
  const prs = Object.values(all.reduce((m, x) => { if (x.t && (!m[x.d] || x.t < m[x.d].t)) m[x.d] = x; return m; }, {})).sort((a, b) => a.d - b.d);
  const series = all.filter((x) => x.t && x.d).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const maxPace = Math.max(...series.map((x) => x.t / x.d), 1), minPace = Math.min(...series.map((x) => x.t / x.d), maxPace);
  const chart = series.length >= 2 ? raw(`<svg viewBox="0 0 600 180" class="chart" role="img" aria-label="Evolução do ritmo médio (menor é melhor)"><polyline fill="none" stroke="currentColor" stroke-width="2" points="${series.map((x, i) => `${20 + (i * 560) / (series.length - 1)},${20 + ((x.t / x.d - minPace) / (maxPace - minPace || 1)) * 140}`).join(' ')}"/>${series.map((x, i) => `<circle cx="${20 + (i * 560) / (series.length - 1)}" cy="${20 + ((x.t / x.d - minPace) / (maxPace - minPace || 1)) * 140}" r="4"><title>${x.name}: ${fmtPace(x.t / x.d)}</title></circle>`).join('')}</svg>`) : '';
  res.page({ title: 'Histórico', wide: true, body: html`<h1>Histórico esportivo</h1>${accountNav('/minha-conta/historico')}
  <section class="card"><h2>Resultados</h2>${table(['Data', 'Evento', 'Modalidade', 'Tempo', 'Ritmo', 'Geral', 'Categoria', 'Situação', 'Fonte', ''], h.map((x) => [fmtDate(x.start_utc, x.timezone), html`<a href="/e/${x.slug}/resultados">${x.event_name}</a>`, x.modality, fmtDuration(x.net_s ?? x.gun_s), fmtPace(x.pace_s_km), x.rank_overall ?? '—', x.rank_category ? `${x.rank_category}º ${x.category}` : '—', RESULT_STATUS[x.status], badge(x.vstatus === 'official' ? 'Oficial' : 'Preliminar', x.vstatus === 'official' ? 'ok' : 'warn'), html`<a href="/minha-conta/certificado/${x.reg_id}">Certificado</a>`]), { emptyMsg: 'Nenhum resultado oficial ainda.' })}</section>
  <section class="card"><h2>Recordes pessoais por distância</h2>${table(['Distância', 'Melhor tempo', 'Ritmo', 'Prova', 'Fonte'], prs.map((x) => [`${x.d} km`, fmtDuration(x.t), fmtPace(x.t / x.d), x.name, x.src === 'Registro pessoal' ? badge(x.src, 'info') : badge(x.src, 'ok')]))}
  ${chart ? html`<h3>Evolução do ritmo (todas as distâncias)</h3>${chart}<p class="muted">Comparação por ritmo médio entre distâncias; quanto mais baixo o ponto, mais rápido.</p>` : ''}</section>
  <section class="card"><h2>Registros pessoais</h2><p class="muted">Provas fora da plataforma. São exibidos como "registro pessoal", nunca como resultado oficial.</p>
  ${table(['Data', 'Prova', 'Distância', 'Tempo'], manual.map((x) => [x.date || '—', x.event_name, `${x.distance_km} km`, fmtDuration(x.time_s)]))}
  <form method="post" action="/minha-conta/historico">${csrf(req)}<div class="row">${field('event_name', 'Prova', { required: true })}${field('date', 'Data', { type: 'date' })}${field('distance_km', 'Distância (km)', { type: 'number', attrs: 'step="0.01"', required: true })}${field('time', 'Tempo', { placeholder: 'hh:mm:ss', required: true })}</div><button class="btn btn-sm">Adicionar registro pessoal</button></form></section>` });
});
r.post('/historico', async (req, res) => {
  const t = parseDuration(req.body.time); const d = Number(req.body.distance_km);
  if (!req.body.event_name || !(t > 0) || !(d > 0)) throw new UserError('Informe prova, distância e tempo (hh:mm:ss).');
  await db.run("INSERT INTO athlete_records(user_id,event_name,date,distance_km,time_s,source) VALUES(?,?,?,?,?,'athlete')", req.user.id, req.body.event_name.slice(0, 120), req.body.date || null, d, t);
  res.redirect(303, '/minha-conta/historico');
});
r.get('/certificado/:regId', async (req, res) => {
  const x = (await history(req.user.id)).find((h) => h.reg_id === Number(req.params.regId));
  if (!x) throw new NotFound('Certificado indisponível: não há resultado publicado para esta inscrição.');
  const done = x.status === 'finished';
  res.page({ title: 'Certificado', body: html`<article class="certificate"><p class="muted">${x.vstatus === 'official' ? 'Resultado oficial' : 'Resultado preliminar'}</p><h1>Certificado de ${done ? 'conclusão' : 'participação'}</h1>
  <p class="lead">Certificamos que <strong>${x.name}</strong> ${done ? 'concluiu' : 'participou de'} <strong>${x.event_name}</strong>, na modalidade ${x.modality}, em ${fmtDate(x.start_utc, x.timezone)}.</p>
  ${done ? html`<p>Tempo líquido: <strong>${fmtDuration(x.net_s)}</strong> · Tempo bruto: ${fmtDuration(x.gun_s)} · Ritmo: ${fmtPace(x.pace_s_km)}</p><p>Classificação geral: ${x.rank_overall}º · Categoria ${x.category || '—'}: ${x.rank_category ?? '—'}º</p>` : html`<p>Situação: ${RESULT_STATUS[x.status]}</p>`}
  <p class="muted">Dados conforme resultado importado pelo organizador. Código de verificação: ${x.reg_id}-${x.version_id}</p><button class="btn" data-print>Imprimir / salvar em PDF</button></article>` });
});

// ---------- Favoritos, perfil e preferências ----------
r.get('/favoritos', async (req, res) => {
  const favs = await db.all('SELECT e.* FROM favorites f JOIN events e ON e.id=f.event_id WHERE f.user_id=? ORDER BY e.start_utc', req.user.id);
  res.page({ title: 'Favoritos', wide: true, body: html`<h1>Favoritos e agenda</h1>${accountNav('/minha-conta/favoritos')}
  <section class="card"><p>Assine sua agenda pessoal (provas inscritas e favoritas) no seu aplicativo de calendário: <a href="/minha-agenda.ics">baixar minha-agenda.ics</a>. Lembretes e alertas de abertura de inscrições/mudança de lote seguem suas <a href="/minha-conta/preferencias">preferências</a>.</p>
  ${table(['Evento', 'Data', 'Cidade'], favs.map((e) => [html`<a href="/e/${e.slug}">${e.name}</a>`, fmtDate(e.start_utc, e.timezone), `${e.city}/${e.state}`]), { emptyMsg: 'Nenhum favorito. Use ☆ Favoritar na página do evento.' })}</section>` });
});
r.get('/perfil', (req, res) => {
  const u = req.user;
  res.page({ title: 'Perfil', body: html`<h1>Perfil</h1>${accountNav('/minha-conta/perfil')}
  <section class="card photo-card"><h2>Foto de perfil</h2><div class="photo-row">${avatar(u, 'lg')}
    <div class="photo-actions"><form method="post" action="/minha-conta/perfil/foto" enctype="multipart/form-data">${csrf(req)}
      <label for="foto" class="btn btn-ghost btn-file">${u.avatar_path ? 'Trocar foto' : 'Enviar foto'}<input type="file" id="foto" name="foto" accept="image/png,image/jpeg,image/webp" required data-autosubmit data-preview="foto-prev"></label>
      <noscript><button class="btn btn-sm">Enviar</button></noscript>
      <small class="hint">JPG, PNG ou WEBP até 3 MB. Aparece no topo do site e no seu painel.</small></form>
      ${u.avatar_path ? html`<form method="post" action="/minha-conta/perfil/foto/remover">${csrf(req)}<button class="linklike">Remover foto</button></form>` : ''}</div></div></section>
  <section class="card"><p class="muted">Usamos estes dados para preencher suas inscrições. Validação local de CPF (dígitos verificadores); não há verificação documental externa.</p>
  <form method="post" action="/minha-conta/perfil">${csrf(req)}${field('name', 'Nome completo', { value: u.name, required: true })}
  <div class="row">${field('cpf', 'CPF', { value: u.cpf ? fmtCpf(u.cpf) : '' })}${field('birth_date', 'Nascimento', { type: 'date', value: u.birth_date })}${field('gender', 'Sexo', { value: u.gender, options: [['', '—'], ['F', 'Feminino'], ['M', 'Masculino']] })}</div>
  <div class="row">${field('phone', 'Telefone', { value: u.phone })}${field('city', 'Cidade', { value: u.city })}${field('state', 'UF', { value: u.state })}${field('shirt_size', 'Tamanho de camiseta preferido', { value: u.shirt_size })}</div>
  <div class="row">${field('emergency_name', 'Contato de emergência', { value: u.emergency_name })}${field('emergency_phone', 'Telefone de emergência', { value: u.emergency_phone })}</div>
  <button class="btn">Salvar</button></form></section>` });
});
const removePublicFile = (key) => { if (!key) return; try { require('node:fs').unlinkSync(require('node:path').join(config.publicUploadDir, require('node:path').basename(key))); } catch { /* já removido */ } };
r.post('/perfil/foto', upload(3).single('foto'), csrfAfterMultipart, async (req, res) => {
  const f = checkFile(req.file, ['image/png', 'image/jpeg', 'image/webp'], 'Foto');
  if (!f) throw new UserError('Escolha uma imagem.');
  const key = store(f, { isPrivate: false });
  await db.run('UPDATE users SET avatar_path=? WHERE id=?', key, req.user.id);
  removePublicFile(req.user.avatar_path);
  await audit(req, 'user.avatar_updated', { entity: 'user', entityId: req.user.id });
  res.flash('success', 'Foto atualizada.');
  res.redirect(303, '/minha-conta/perfil');
});
r.post('/perfil/foto/remover', async (req, res) => {
  await db.run('UPDATE users SET avatar_path=NULL WHERE id=?', req.user.id);
  removePublicFile(req.user.avatar_path);
  res.flash('success', 'Foto removida.');
  res.redirect(303, '/minha-conta/perfil');
});
r.post('/perfil', async (req, res) => {
  const b = req.body;
  if (!b.name || b.name.trim().length < 3) throw new UserError('Informe o nome.');
  if (b.cpf && !isCpf(b.cpf)) throw new UserError('CPF inválido.');
  if (b.cpf && await db.one('SELECT 1 FROM users WHERE cpf=? AND id<>?', digits(b.cpf), req.user.id)) throw new UserError('CPF já vinculado a outra conta. Fale com o suporte.');
  await db.run('UPDATE users SET name=?, cpf=?, birth_date=?, gender=?, phone=?, city=?, state=?, shirt_size=?, emergency_name=?, emergency_phone=? WHERE id=?', b.name.trim(), b.cpf ? digits(b.cpf) : null, b.birth_date || null, ['M', 'F'].includes(b.gender) ? b.gender : null, b.phone || null, b.city || null, b.state || null, b.shirt_size || null, b.emergency_name || null, b.emergency_phone || null, req.user.id);
  res.flash('success', 'Perfil atualizado.');
  res.redirect(303, '/minha-conta/perfil');
});
r.get('/preferencias', (req, res) => {
  const p = json(req.user.notify_prefs, {});
  res.page({ title: 'Preferências', body: html`<h1>Privacidade e comunicação</h1>${accountNav('/minha-conta/preferencias')}<section class="card"><form method="post" action="/minha-conta/preferencias">${csrf(req)}
  <fieldset><legend>Notificações por e-mail</legend><p class="muted">Confirmações de inscrição e segurança da conta são sempre enviadas.</p>${Object.entries(NOTIFY).map(([k, l]) => field(`n_${k}`, l, { type: 'checkbox', value: p[k] !== false }))}</fieldset>
  <fieldset><legend>WhatsApp e SMS</legend><p class="muted">Avisos sobre suas inscrições (confirmação, kit e mudanças no evento) no telefone ${req.user.phone ? html`<strong>${req.user.phone}</strong>` : html`<a href="/minha-conta/perfil">cadastre seu telefone no perfil</a>`}. Só enviamos se você autorizar.</p>
    ${field('c_whatsapp', 'Receber avisos por WhatsApp', { type: 'checkbox', value: p.whatsapp === true })}${field('c_sms', 'Receber avisos por SMS', { type: 'checkbox', value: p.sms === true })}</fieldset>
  <fieldset><legend>Marketing</legend>${field('marketing', 'Receber divulgação de eventos e novidades', { type: 'checkbox', value: req.user.marketing_opt_in })}</fieldset>
  <fieldset><legend>Privacidade</legend>${field('public_results', 'Exibir meu nome nos resultados públicos (se desmarcado, aparece "perfil privado")', { type: 'checkbox', value: req.user.public_results })}</fieldset>
  <button class="btn">Salvar preferências</button></form>
</section>` });
});
r.post('/preferencias', async (req, res) => {
  const prefs = Object.fromEntries(Object.keys(NOTIFY).map((k) => [k, !!req.body[`n_${k}`]]));
  const old = json(req.user.notify_prefs, {});
  prefs.whatsapp = !!req.body.c_whatsapp; prefs.sms = !!req.body.c_sms;
  for (const ch of ['whatsapp', 'sms']) if (prefs[ch] !== (old[ch] === true)) await recordConsent(req, req.user.id, prefs[ch] ? `channel_${ch}` : `channel_${ch}_revoked`, 'preferences');
  const mk = req.body.marketing ? 1 : 0;
  await db.run('UPDATE users SET notify_prefs=?, marketing_opt_in=?, public_results=? WHERE id=?', JSON.stringify(prefs), mk, req.body.public_results ? 1 : 0, req.user.id);
  if (mk !== req.user.marketing_opt_in) await recordConsent(req, req.user.id, mk ? 'marketing' : 'marketing_revoked', 'preferences');
  res.flash('success', 'Preferências salvas.');
  res.redirect(303, '/minha-conta/preferencias');
});
module.exports = r;
module.exports.history = history;
