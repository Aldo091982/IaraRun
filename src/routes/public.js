'use strict';
const express = require('express');
const db = require('../db');
const config = require('../config');
const { html, raw, brl, fmtDate, fmtDateTime, fmtTime, tzLabel, UF, NotFound, fmtDuration, fmtPace, json, someAsync, filterAsync } = require('../lib/util');
const { publicStatus, PUBLIC_STATUS, currentLot, counts } = require('../lib/events');
const { currentPublished, versionRows, totals, placings, RESULT_STATUS } = require('../lib/results');
const { settings } = require('../lib/core');
const { kitBlockingItem } = require('../lib/kitStock');
const { page, csrf, badge, field, empty, APP_NAME } = require('../views/layout');
const { requireUser } = require('../lib/guards');
const { art, sportKey } = require('../views/sportArt');

const r = express.Router();
const statusBadge = async (ev) => { const s = PUBLIC_STATUS[await publicStatus(ev)]; return badge(s.label, s.tone); };

const CTA = { open: ['Inscreva-se', 'go'], soon: ['Em breve', 'off'], soldout: ['Inscrições esgotadas', 'off'], closed: ['Inscrições encerradas', 'off'], completed: ['Ver resultados', 'alt'], cancelled: ['Evento cancelado', 'off'], draft: ['Rascunho', 'off'] };
async function eventCard(ev) {
  const st = await publicStatus(ev); const [label, tone] = CTA[st] || ['Ver evento', 'go'];
  const href = st === 'completed' ? `/e/${ev.slug}/resultados` : `/e/${ev.slug}`;
  return html`<article class="event-card">
    <a href="/e/${ev.slug}" class="event-cover" style="${ev.cover_path ? `background-image:url('/media/${ev.cover_path}')` : ''}" aria-hidden="true" tabindex="-1">${ev.cover_path ? '' : html`<span class="cover-art">${raw(art(sportKey(ev.sport)))}</span><span class="cover-sport">${ev.sport || 'Corrida'}</span>`}</a>
    <div class="event-body">
      <h3><a href="/e/${ev.slug}">${ev.name}</a>${ev.is_demo ? html` ${badge('Demo', 'info')}` : ''}</h3>
      <p class="event-when">${fmtDate(ev.start_utc, ev.timezone)} - ${fmtTime(ev.start_utc, ev.timezone)}</p>
      <p class="event-where">${ev.city} - ${ev.state}</p>
      <a class="card-cta cta-${tone}" href="${href}"><span aria-hidden="true">🎟</span> ${label}</a></div></article>`;
}

function searchPanel(q = {}) {
  return html`<form action="/eventos" class="search-panel" role="search" aria-label="Buscar eventos">
    <div class="sp-field sp-grow"><label for="sp-q">Nome do evento</label><input id="sp-q" name="q" value="${q.q || ''}" placeholder="Ex.: Corrida da Orla"></div>
    <div class="sp-field"><label for="sp-uf">Estado</label><select id="sp-uf" name="uf"><option value="">Todos</option>${UF.map((u) => html`<option ${q.uf === u ? 'selected' : ''}>${u}</option>`)}</select></div>
    <div class="sp-field"><label for="sp-de">Data inicial</label><input id="sp-de" type="date" name="de" value="${q.de || ''}"></div>
    <div class="sp-field"><label for="sp-ate">Data final</label><input id="sp-ate" type="date" name="ate" value="${q.ate || ''}"></div>
    <label class="sp-toggle"><input type="checkbox" name="abertas" value="1" ${q.abertas ? 'checked' : ''}><span class="switch" aria-hidden="true"></span>Inscrições abertas</label>
    <div class="sp-actions"><button class="btn">Buscar</button><a class="btn btn-outline" href="/eventos">Limpar</a></div></form>`;
}

/**
 * Números públicos da plataforma, calculados do banco (dados de demonstração não contam).
 * Guardados por 5 minutos para não pesar na página inicial.
 */
let statsCache = { at: 0, value: null };
async function platformStats() {
  if (statsCache.value && Date.now() - statsCache.at < 5 * 60000) return statsCache.value;
  const now = new Date().toISOString();
  const v = await db.one(`SELECT
    (SELECT COUNT(*) FROM events WHERE is_demo=0 AND status IN ('published','closed','completed') AND start_utc < ?) events_done,
    (SELECT COUNT(*) FROM organizations WHERE is_demo=0 AND status='active') organizers,
    (SELECT COUNT(*) FROM users WHERE is_demo=0 AND status='active') athletes,
    (SELECT COUNT(*) FROM registrations g JOIN events e ON e.id=g.event_id WHERE e.is_demo=0 AND g.status='confirmed') registrations`, now);
  statsCache = { at: Date.now(), value: v };
  return v;
}
platformStats.reset = () => { statsCache = { at: 0, value: null }; };
const fmtInt = (n) => Number(n || 0).toLocaleString('pt-BR');

function statsSection(s) {
  const items = [[s.events_done, 'Eventos realizados'], [s.organizers, 'Organizadores'], [s.athletes, 'Atletas cadastrados'], [s.registrations, 'Inscrições realizadas']];
  if (!items.some(([n]) => n > 0)) return ''; // plataforma recém-aberta: a seção aparece com o primeiro número
  return html`<section class="stats-band" aria-labelledby="stats-title">
    <h2 id="stats-title">Nossa história em números</h2>
    <p>Cada prova realizada, cada organizador e cada atleta que cruza a linha de chegada aumenta esses números.</p>
    <div class="stats-grid">${items.map(([n, label]) => html`<div class="stat"><strong data-count="${n}">${n > 0 ? '+' : ''}${fmtInt(n)}</strong><span>${label}</span></div>`)}</div>
  </section>`;
}

r.get('/', async (req, res) => {
  const evs = await db.all("SELECT * FROM events WHERE status='published' AND start_utc > ? ORDER BY start_utc LIMIT 12", new Date().toISOString());
  const stats = await platformStats();
  res.page({ title: null, description: 'Encontre corridas e eventos esportivos, inscreva-se e acompanhe seus resultados.', body: html`
  <section class="hero"><div class="hero-figure" aria-hidden="true">${raw(art('run'))}</div><div class="hero-in"><h1>Sua próxima largada começa aqui</h1><p>Provas de corrida, ciclismo, triathlon e trail com inscrições abertas. Escolha a sua e vá além do seu limite.</p></div></section>
  ${searchPanel()}
  <nav class="sport-strip" aria-label="Modalidades">${[['run', 'Corrida', 'Corrida de rua'], ['trail', 'Trail', 'Trail'], ['bike', 'Ciclismo', 'Ciclismo'], ['swim', 'Triathlon', 'Triathlon'], ['medal', 'Resultados', null]].map(([k, l, m]) => html`<a class="sport-chip" href="${m ? `/eventos?modalidade=${encodeURIComponent(m)}` : '/minha-conta/historico'}"><span class="chip-art" aria-hidden="true">${raw(art(k))}</span>${l}</a>`)}</nav>
  <section><div class="section-head"><h2>Próximos eventos</h2><a href="/eventos">Ver todos</a></div>
  <div class="grid grid-events">${evs.length ? await Promise.all(evs.map(eventCard)) : empty('Nenhum evento publicado ainda.')}</div></section>
  ${statsSection(stats)}
  <section class="org-strip"><div><h2>Organiza eventos?</h2><p>Cadastre sua empresa e publique sua prova sozinho, em poucos passos.</p></div><a class="btn btn-lg" href="/organizadores">Quero organizar</a></section>` });
});

r.get('/eventos', async (req, res) => {
  const q = req.query; const where = ["e.status IN ('published','closed','completed','cancelled')"]; const p = [];
  if (q.q) { where.push('(e.name ILIKE ? OR e.city ILIKE ?)'); p.push(`%${q.q}%`, `%${q.q}%`); }
  if (q.uf) { where.push('e.state=?'); p.push(q.uf); }
  if (q.cidade) { where.push('e.city ILIKE ?'); p.push(`%${q.cidade}%`); }
  if (q.modalidade) { where.push('e.sport=?'); p.push(q.modalidade); }
  if (q.de) { where.push('e.start_utc>=?'); p.push(q.de); }
  if (q.ate) { where.push('e.start_utc<=?'); p.push(q.ate + 'T23:59:59Z'); }
  if (q.dist) { const [a, b] = String(q.dist).split('-').map(Number); where.push('EXISTS (SELECT 1 FROM modalities m WHERE m.event_id=e.id AND m.distance_km>=? AND m.distance_km<=?)'); p.push(a || 0, b || 1000); }
  if (!q.passados) { where.push('e.start_utc>=?'); p.push(new Date(Date.now() - 864e5).toISOString()); }
  let evs = await db.all(`SELECT e.* FROM events e WHERE ${where.join(' AND ')} ORDER BY e.start_utc LIMIT 60`, ...p);
  if (q.abertas) evs = await filterAsync(evs, async (e) => await publicStatus(e) === 'open');
  const sports = (await db.all("SELECT DISTINCT sport FROM events WHERE status<>'draft' ORDER BY sport")).map((s) => s.sport);
  res.page({ title: 'Eventos', wide: true, body: html`<h1>Eventos</h1>${searchPanel(q)}
  <details class="more-filters" ${q.cidade || q.modalidade || q.dist || q.passados ? 'open' : ''}><summary>Mais filtros</summary>
  <form class="filters card" role="search" aria-label="Filtrar eventos">
    ${field('q', 'Nome ou cidade', { value: q.q })}${field('uf', 'Estado', { value: q.uf, options: [['', 'Todos'], ...UF] })}
    ${field('cidade', 'Cidade', { value: q.cidade })}${field('modalidade', 'Modalidade', { value: q.modalidade, options: [['', 'Todas'], ...sports] })}
    ${field('dist', 'Distância', { value: q.dist, options: [['', 'Todas'], ['0-5', 'Até 5 km'], ['5.01-10', '5 a 10 km'], ['10.01-21.1', '10 a 21 km'], ['21.1-42.2', 'Meia a maratona'], ['42.3-1000', 'Ultra']] })}
    ${field('de', 'De', { type: 'date', value: q.de })}${field('ate', 'Até', { type: 'date', value: q.ate })}
    ${field('passados', 'Incluir eventos passados', { type: 'checkbox', value: q.passados })}
    ${q.abertas ? html`<input type="hidden" name="abertas" value="1">` : ''}<div class="filters-actions"><button class="btn">Filtrar</button> <a href="/eventos">Limpar</a></div></form></details>
  <p class="muted" aria-live="polite">${evs.length} evento(s) encontrado(s).</p>
  <div class="grid">${evs.length ? await Promise.all(evs.map(eventCard)) : empty('Nenhum evento corresponde aos filtros. Tente ampliar a busca.')}</div>` });
});

async function loadPublicEvent(req) {
  const ev = await db.one('SELECT * FROM events WHERE slug=?', req.params.slug);
  if (!ev) throw new NotFound('Evento não encontrado.');
  if (ev.status === 'draft') {
    const isMember = req.user && await db.one('SELECT 1 FROM org_members WHERE org_id=? AND user_id=?', ev.org_id, req.user.id);
    if (!isMember) throw new NotFound('Evento não encontrado.');
  }
  return ev;
}

r.get('/e/:slug', async (req, res) => {
  const ev = await loadPublicEvent(req);
  const org = await db.one('SELECT trade_name, legal_name, logo_path, website, support_email, support_phone, bio FROM organizations WHERE id=?', ev.org_id);
  const mods = await db.all('SELECT * FROM modalities WHERE event_id=? ORDER BY sort,id', ev.id);
  const lots = await db.all('SELECT l.*, m.name modality_name FROM lots l LEFT JOIN modalities m ON m.id=l.modality_id WHERE l.event_id=? ORDER BY l.sort, l.id', ev.id);
  const kits = await db.all('SELECT * FROM kits WHERE event_id=?', ev.id);
  const cats = await db.all('SELECT * FROM categories WHERE event_id=?', ev.id);
  const products = await db.all('SELECT * FROM products WHERE event_id=? AND active=1', ev.id);
  const st = await publicStatus(ev);
  const fav = req.user && await db.one('SELECT 1 FROM favorites WHERE user_id=? AND event_id=?', req.user.id, ev.id);
  const url = `${config.baseUrl}/e/${ev.slug}`;
  const now = new Date().toISOString();
  const published = await currentPublished(ev.id);
  res.page({ title: ev.name, description: (ev.description || '').slice(0, 160), wide: true, body: html`
  ${ev.status === 'draft' ? raw('<div class="alert alert-warn">Prévia de rascunho privado — visível apenas para a equipe do organizador.</div>') : ''}
  ${ev.is_demo ? raw('<div class="alert alert-info">Evento fictício de demonstração.</div>') : ''}
  <section class="event-hero" style="${ev.cover_path ? `--cover:url('/media/${ev.cover_path}')` : ''}"><div>
    ${await statusBadge(ev)}<h1>${ev.name}</h1>
    <p class="lead">${fmtDate(ev.start_utc, ev.timezone)} · largada ${fmtTime(ev.start_utc, ev.timezone)} (horário de ${tzLabel(ev.timezone)})</p>
    <p>${ev.venue ? `${ev.venue} — ` : ''}${ev.address}, ${ev.city}/${ev.state}</p>
    <div class="actions">${st === 'open' ? html`<a class="btn btn-lg" href="/e/${ev.slug}/inscricao">Inscrever-se</a>` : ''}
      ${published ? html`<a class="btn btn-ghost" href="/e/${ev.slug}/resultados">Resultados</a>` : ''}
      ${req.user ? html`<form method="post" action="/e/${ev.slug}/favorito" class="inline">${csrf(req)}<button class="btn btn-ghost" aria-pressed="${fav ? 'true' : 'false'}">${fav ? '★ Favorito' : '☆ Favoritar'}</button></form>` : html`<a class="btn btn-ghost" href="/entrar?volta=/e/${ev.slug}">☆ Favoritar</a>`}
      <button class="btn btn-ghost" data-share="${url}" data-title="${ev.name}">Compartilhar</button>
      <a class="btn btn-ghost" href="https://wa.me/?text=${encodeURIComponent(`${ev.name} ${url}`)}" rel="noopener" target="_blank">WhatsApp</a>
      <a class="btn btn-ghost" href="/e/${ev.slug}/calendario.ics">Adicionar à agenda</a></div></div></section>
  <div class="cols"><div class="col-main">
    <section class="card"><h2>Sobre o evento</h2><div class="prose">${raw(paragraphs(ev.description))}</div></section>
    <section class="card"><h2>Modalidades e percurso</h2>${await Promise.all(mods.map(async (m) => html`<p><strong>${m.name}</strong>${m.distance_km ? ` — ${String(m.distance_km).replace('.', ',')} km` : ''}${m.start_time ? ` · largada ${m.start_time}` : ''}${m.capacity ? ` · ${Math.max(0, m.capacity - await counts.modality(m.id))} vagas restantes de ${m.capacity}` : ''}</p>`))}
      ${ev.route_info ? html`<div class="prose">${raw(paragraphs(ev.route_info))}</div>` : ''}${ev.route_url ? html`<p><a href="${ev.route_url}" rel="noopener" target="_blank">Ver mapa do percurso</a></p>` : ''}
      ${cats.length ? html`<h3>Categorias</h3><p>${cats.map((c) => c.name).join(' · ')}</p>` : ''}</section>
    <section class="card"><h2>Lotes e preços</h2>${lots.length ? html`<div class="table-wrap"><table><thead><tr><th>Lote</th><th>Modalidade</th><th>Preço</th><th>Período</th><th>Situação</th></tr></thead><tbody>
      ${await Promise.all(lots.map(async (l) => { const cur = await someAsync(mods, async (m) => (await currentLot(ev.id, m.id))?.id === l.id); const ended = (l.ends_utc && l.ends_utc <= now) || (l.quantity != null && await counts.lot(l.id) >= l.quantity); return html`<tr><td>${l.name}</td><td>${l.modality_name || 'Todas'}</td><td>${l.price_cents ? brl(l.price_cents) : 'Gratuito'}</td><td>${l.starts_utc ? fmtDateTime(l.starts_utc, ev.timezone) : 'Imediato'} – ${l.ends_utc ? fmtDateTime(l.ends_utc, ev.timezone) : 'até esgotar'}</td><td>${cur ? badge('Vigente', 'ok') : ended ? badge('Encerrado', 'muted') : badge('Futuro', 'info')}</td></tr>`; }))}</tbody></table></div>
      ${ev.fee_percent > 0 && ev.fee_payer === 'athlete' ? html`<p class="muted">Taxa de serviço de ${String(ev.fee_percent).replace('.', ',')}% acrescida no pagamento.</p>` : ''}` : empty('Preços ainda não divulgados.')}</section>
    ${kits.length ? html`<section class="card"><h2>Kits</h2>${await Promise.all(kits.map(async (k) => html`<h3>${k.name}${k.extra_price_cents ? ` (+ ${brl(k.extra_price_cents)})` : ''}${await kitBlockingItem(k.id) ? ' (esgotado)' : ''}</h3><p>${k.description}</p>${await (async () => { const its = await db.all('SELECT name FROM kit_items WHERE kit_id=? ORDER BY sort, id', k.id); return its.length ? html`<p class="muted">Itens: ${its.map((x) => x.name).join(', ')}</p>` : ''; })()}${k.has_shirt ? html`<p class="muted">Camiseta: ${(await db.all('SELECT size FROM kit_sizes WHERE kit_id=? ORDER BY id', k.id)).map((s) => s.size).join(', ')}</p>` : ''}`))}
      ${products.length ? html`<h3>Produtos extras</h3><p>${products.map((p) => `${p.name} (${brl(p.price_cents)})`).join(' · ')}</p>` : ''}</section>` : ''}
    <section class="card"><h2>Retirada do kit</h2><div class="prose">${raw(paragraphs(ev.kit_pickup_info || 'A divulgar.'))}</div></section>
    <section class="card"><h2>Regulamento</h2><details><summary>Ler regulamento completo (versão ${ev.regulation_version})</summary><div class="prose">${raw(paragraphs(ev.regulation))}</div></details>
      <h3>Alterações e cancelamento</h3><div class="prose">${raw(paragraphs(ev.change_policy || ''))}${raw(paragraphs(ev.cancel_policy || ''))}</div></section>
  </div><aside class="col-side">
    <section class="card"><h2>Organização</h2>${org.logo_path ? html`<img src="/media/${org.logo_path}" alt="Logomarca de ${org.trade_name}" class="org-logo">` : ''}<p><strong>${org.trade_name || org.legal_name}</strong></p>${org.bio ? html`<p>${org.bio}</p>` : ''}${org.website ? html`<p><a href="${org.website}" rel="noopener" target="_blank">Site oficial</a></p>` : ''}</section>
    <section class="card"><h2>Atendimento</h2><p>E-mail: <a href="mailto:${ev.support_email || org.support_email}">${ev.support_email || org.support_email}</a></p><p>Telefone: ${ev.support_phone || org.support_phone}</p></section>
  </aside></div>` });
});
const paragraphs = (t) => String(t || '').split(/\n{2,}|\r\n\r\n/).map((p) => `<p>${require('../lib/util').esc(p).replace(/\n/g, '<br>')}</p>`).join('');

r.post('/e/:slug/favorito', requireUser, async (req, res) => {
  const ev = await loadPublicEvent(req);
  if (await db.one('SELECT 1 FROM favorites WHERE user_id=? AND event_id=?', req.user.id, ev.id)) await db.run('DELETE FROM favorites WHERE user_id=? AND event_id=?', req.user.id, ev.id);
  else await db.run('INSERT INTO favorites(user_id,event_id) VALUES(?,?)', req.user.id, ev.id);
  res.redirect(303, `/e/${ev.slug}`);
});

const icsDate = (iso) => iso.replace(/[-:]/g, '').replace(/\.\d{3}/, '');
function ics(evs) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${APP_NAME}//PT-BR`, ...evs.flatMap((e) => ['BEGIN:VEVENT', `UID:evento-${e.id}@${APP_NAME.toLowerCase()}`, `DTSTAMP:${icsDate(new Date().toISOString())}`, `DTSTART:${icsDate(e.start_utc)}`, `DTEND:${icsDate(new Date(new Date(e.start_utc).getTime() + 3 * 3600e3).toISOString())}`, `SUMMARY:${e.name.replace(/[,;]/g, ' ')}`, `LOCATION:${(e.address + ' ' + e.city + '/' + e.state).replace(/[,;]/g, ' ')}`, `URL:${config.baseUrl}/e/${e.slug}`, 'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:Lembrete de prova', 'END:VALARM', 'END:VEVENT']), 'END:VCALENDAR'].join('\r\n');
}
r.get('/e/:slug/calendario.ics', async (req, res) => { const ev = await loadPublicEvent(req); res.type('text/calendar').attachment(`${ev.slug}.ics`).send(ics([ev])); });
r.get('/minha-agenda.ics', requireUser, async (req, res) => {
  const evs = await db.all("SELECT DISTINCT e.* FROM events e WHERE e.status IN ('published','closed') AND (e.id IN (SELECT event_id FROM favorites WHERE user_id=?) OR e.id IN (SELECT event_id FROM registrations WHERE (user_id=? OR buyer_user_id=?) AND status='confirmed'))", req.user.id, req.user.id, req.user.id);
  res.type('text/calendar').attachment('minha-agenda.ics').send(ics(evs));
});

r.get('/e/:slug/resultados', async (req, res) => {
  const ev = await loadPublicEvent(req);
  const v = await currentPublished(ev.id);
  const mods = await db.all('SELECT * FROM modalities WHERE event_id=? ORDER BY sort,id', ev.id);
  const mod = Number(req.query.modalidade) || mods[0]?.id;
  const rows = v ? (await versionRows(v.id)).filter((x) => x.modality_id === mod) : [];
  const tot = v ? await totals(v.id) : null;
  const sexo = ['F', 'M'].includes(req.query.sexo) ? req.query.sexo : '';
  const cats = [...new Map(rows.filter((x) => x.category_id).map((x) => [x.category_id, x.category_name])).entries()];
  const cat = Number(req.query.categoria) || 0;
  const hidden = new Set((await db.all('SELECT g.bib FROM registrations g JOIN users u ON u.id=g.user_id WHERE g.event_id=? AND u.public_results=0', ev.id)).map((x) => x.bib));
  const q = String(req.query.q || '').toLowerCase();
  const list = rows.filter((x) => (!q || x.bib === q || x.name.toLowerCase().includes(q)) && (!sexo || x.gender === sexo) && (!cat || x.category_id === cat));
  const posKey = cat ? 'rank_category' : sexo ? 'rank_gender' : 'rank_overall';
  const pname = (x) => (hidden.has(x.bib) ? 'Atleta (perfil privado)' : x.name);
  const podiumFor = (g) => rows.filter((x) => x.status === 'finished' && (g ? x.gender === g && x.rank_gender <= 3 : x.rank_overall <= 3)).sort((a, b) => (g ? a.rank_gender - b.rank_gender : a.rank_overall - b.rank_overall));
  res.page({ title: `Resultados — ${ev.name}`, wide: true, body: html`<h1>Resultados — ${ev.name}</h1>
  ${!v ? empty('Resultados ainda não publicados.') : html`<p>${badge(v.status === 'official' ? 'Resultado oficial' : 'Resultado preliminar', v.status === 'official' ? 'ok' : 'warn')} Versão ${v.version} publicada em ${fmtDateTime(v.published_at, ev.timezone)}. ${v.status === 'preliminary' ? 'Pode sofrer correções após o prazo de revisão.' : ''}</p>
  <div class="podiums">${[['', 'Geral'], ['F', 'Feminino'], ['M', 'Masculino']].map(([g, label]) => { const pd = podiumFor(g); return pd.length ? html`<section class="card podium"><h2>Pódio ${label}</h2><ol>${pd.map((x) => { const pos = g ? x.rank_gender : x.rank_overall; return html`<li><span class="medal medal-${pos}">${pos}º</span> <strong>${pname(x)}</strong> <span class="muted">${fmtDuration(x.net_s ?? x.gun_s)}</span></li>`; })}</ol></section>` : ''; })}</div>
  <form class="filters inline-filters">${field('modalidade', 'Modalidade', { value: mod, options: mods.map((m) => [m.id, m.name]) })}${field('sexo', 'Sexo', { value: sexo, options: [['', 'Todos'], ['F', 'Feminino'], ['M', 'Masculino']] })}${cats.length ? field('categoria', 'Categoria', { value: cat || '', options: [['', 'Todas'], ...cats] }) : ''}${field('q', 'Nome ou número', { value: req.query.q })}<button class="btn">Filtrar</button></form>
  <p class="muted">${list.length} atleta(s). A coluna "Pos." mostra a posição ${cat ? 'na categoria' : sexo ? 'no sexo escolhido' : 'geral'}.</p>
  <div class="table-wrap"><table><thead><tr><th>Pos.</th><th>Nº</th><th>Atleta</th><th>Geral</th><th>Sexo</th><th>Categoria</th><th>Tempo líquido</th><th>Tempo bruto</th><th>Ritmo</th><th>Situação</th></tr></thead><tbody>
  ${list.sort((a, b) => (a[posKey] ?? 1e9) - (b[posKey] ?? 1e9) || Number(a.bib) - Number(b.bib)).map((x) => { const pl = placings(x, tot); return html`<tr><td><strong>${x[posKey] ? `${x[posKey]}º` : '—'}</strong></td><td>${x.bib}</td><td>${pname(x)}</td><td>${pl.overall}</td><td>${x.gender || '—'} · ${pl.gender}</td><td>${x.category_name || '—'} · ${pl.category}</td><td>${fmtDuration(x.net_s)}</td><td>${fmtDuration(x.gun_s)}</td><td>${fmtPace(x.pace_s_km)}</td><td>${RESULT_STATUS[x.status]}</td></tr>`; })}
  </tbody></table></div>`}` });
});

// Página pública para organizadores
r.get('/organizadores', async (req, res) => {
  const s = await settings();
  res.page({ title: 'Para organizadores', description: 'Publique seu evento esportivo, venda inscrições e gerencie kits e resultados.', body: html`
  <section class="hero hero-org"><div><span class="hero-tag">Para organizadores</span><h1>Organize seu evento do cadastro ao resultado — sem depender de ninguém.</h1>
    <p>Crie sua conta, cadastre a empresa, configure recebimentos e publique o primeiro evento por um fluxo guiado. Sem convite e sem contato comercial obrigatório.</p>
    <div class="actions"><a class="btn btn-lg" href="${req.user ? '/organizador/cadastro' : '/cadastro?perfil=organizador'}">Começar cadastro</a><a class="btn btn-ghost btn-lg" href="/entrar?volta=/organizador">Acessar minha conta</a></div></div></section>
  <section><h2>O que você consegue fazer</h2><div class="grid features">
    ${[['Página do evento', 'Descrição, percurso, regulamento, lotes, kits e contatos de atendimento.'], ['Inscrições com controle de vagas', 'Lotes por período ou quantidade, reserva temporária durante o pagamento, cupons e grupos.'], ['Pagamentos pelo Mercado Pago', 'Pix e cartão conforme disponibilidade da integração. Confirmação somente após validação no servidor.'], ['Financeiro', 'Vendas brutas, descontos, taxas, reembolsos, líquido e conciliação.'], ['Entrega de kits por QR Code', 'Conferência por operador autorizado, retirada por terceiros e bloqueio de duplicidade.'], ['Resultados', 'Importação por planilha, prévia com erros, classificação geral e por categoria, versões preliminar e oficial.'], ['Equipe', 'Colaboradores com acesso por evento e função: financeiro, atendimento, cronometragem e kits.'], ['Questionário e produtos extras', 'Perguntas personalizadas e venda de acessórios com estoque.']].map(([t, d]) => html`<div class="card feature"><h3>${t}</h3><p>${d}</p></div>`)}</div></section>
  <section class="card"><h2>Como começar</h2><ol class="howto">
    <li><strong>Criar conta</strong> — nome, e-mail e senha do responsável. Se você já é atleta, use a mesma conta.</li>
    <li><strong>Cadastrar a empresa</strong> — CNPJ (incluindo MEI), logomarca, documento do responsável e comprovação de vínculo.</li>
    <li><strong>Contatos e aceites</strong> — e-mail e telefone de atendimento aos atletas, termos e política de privacidade.</li>
    <li><strong>Revisar e concluir</strong> — o painel abre com a lista de tarefas para publicar o primeiro evento.</li></ol></section>
  <section class="card"><h2>Conta criada, empresa verificada e recebimentos: qual a diferença?</h2>
    <dl class="defs"><dt>Conta criada</dt><dd>Você já acessa o painel e pode preparar eventos em rascunho.</dd>
    <dt>Empresa verificada</dt><dd>Nossa equipe confere os dados da empresa e os documentos enviados. Necessário para publicar eventos.</dd>
    <dt>Habilitado para receber</dt><dd>Recebimento configurado pelo Mercado Pago. Necessário apenas para eventos pagos; eventos gratuitos dispensam integração financeira.</dd></dl>
    <h3>Requisitos do cadastro</h3><ul><li>CNPJ ativo (empresas e MEI). Nesta versão não há cadastro como pessoa física.</li><li>Documento oficial com foto do responsável${s.require_identity_document ? ' (obrigatório)' : ''} e comprovante de vínculo com a empresa (contrato social, certificado MEI ou procuração).</li><li>E-mail e telefone de atendimento aos atletas.</li></ul></section>
  <section class="card"><h2>Condições comerciais</h2><p>${s.commercial_conditions}</p><p class="muted">Taxa de serviço configurada pela administração: ${s.platform_fee_percent ? `${String(s.platform_fee_percent).replace('.', ',')}% por inscrição paga` : 'a definir'}. Você escolhe, por evento, se a taxa é paga pelo atleta ou absorvida pela organização. Eventos gratuitos: ${s.free_events_fee_percent ? `${s.free_events_fee_percent}%` : 'sem taxa'}.</p></section>` });
});
module.exports = r;
module.exports.loadPublicEvent = loadPublicEvent;
module.exports.platformStats = platformStats;
