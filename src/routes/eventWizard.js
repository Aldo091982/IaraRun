'use strict';
const express = require('express');
const db = require('../db');
const { html, raw, brl, toCents, centsToInput, zonedToUtc, utcToZonedInput, fmtDateTime, TIMEZONES, tzLabel, UF, slugify, UserError, nowIso, json, randomToken } = require('../lib/util');
const { assertCan, eventForOrg, activation } = require('../lib/orgs');
const { publishChecklist, isPaidEvent } = require('../lib/events');
const { audit, settings } = require('../lib/core');
const { requireOrg, upload, checkFile, store, csrfAfterMultipart } = require('../lib/guards');
const { csrf, field, steps, badge, table, tip, errorsBox, empty } = require('../views/layout');
const { suggestFromRegulation } = require('../lib/aiAssist');
const kitStock = require('../lib/kitStock');

const r = express.Router();
r.use((req, res, next) => (req.path.startsWith('/cadastro') ? next('router') : next()));
r.use(requireOrg);

const STEPS = ['Informações básicas', 'Local, percurso e distâncias', 'Categorias e classificação', 'Lotes, preços e vagas', 'Kits, camisetas e produtos', 'Regulamento, regras e questionário', 'Retirada de kits e atendimento', 'Pagamentos e taxa', 'Revisão e publicação'];
const SPORTS = ['Corrida de rua', 'Trail run', 'Caminhada', 'Ciclismo', 'Mountain bike', 'Triathlon', 'Duathlon', 'Natação', 'Aquathlon', 'Outro'];

async function uniqueSlug(name) { const base = slugify(name); let s = base, i = 2; while (await db.one('SELECT 1 FROM events WHERE slug=?', s)) s = `${base}-${i++}`; return s; }

r.get('/eventos/novo', async (req, res) => {
  assertCan(req.member, 'events');
  res.page({ title: 'Novo evento', body: html`<section class="card wizard"><h1>Criar evento</h1>${steps(STEPS.map((l) => ({ label: l })), 1)}
  ${tip('O evento fica em rascunho privado até você publicar. Salve a qualquer momento e retome depois.')}${await stepForm(req, null, 1)}</section>` });
});
r.post('/eventos/novo', async (req, res) => {
  assertCan(req.member, 'events');
  const b = req.body;
  if (!b.name || b.name.trim().length < 3) throw new UserError('Informe o nome do evento.');
  const s = await settings();
  const tz = TIMEZONES.includes(b.timezone) ? b.timezone : 'America/Sao_Paulo';
  const id = Number((await db.run('INSERT INTO events(org_id,slug,name,description,sport,start_local,timezone,start_utc,capacity,fee_percent,fee_payer,reservation_minutes,support_email,support_phone,wizard_step,regulation_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,2,0)',
    req.org.id, await uniqueSlug(b.name), b.name.trim(), b.description || null, SPORTS.includes(b.sport) ? b.sport : 'Corrida de rua', b.start_local || null, tz, zonedToUtc(b.start_local, tz), b.capacity ? Number(b.capacity) : null,
    s.platform_fee_percent, s.default_fee_payer, s.reservation_minutes, req.org.support_email, req.org.support_phone)).lastInsertRowid);
  await audit(req, 'event.created', { orgId: req.org.id, entity: 'event', entityId: id });
  res.redirect(303, `/organizador/eventos/${id}/editar?etapa=${b.acao === 'salvar' ? 1 : 2}`);
});

function itemsTable(req, ev, type, headers, rows) {
  return table([...headers, ''], rows.map((x) => [...x.cells, html`<form method="post" action="/organizador/eventos/${ev.id}/itens/${type}/${x.id}/remover" class="inline">${csrf(req)}<button class="linklike danger" aria-label="Remover">Remover</button></form>`]), { emptyMsg: 'Nenhum item cadastrado.' });
}

async function stepForm(req, ev, step, extra = {}) {
  const v = ev || {};
  const nav = html`<div class="wizard-nav">${step > 1 && ev ? html`<a class="btn btn-ghost" href="/organizador/eventos/${ev.id}/editar?etapa=${step - 1}">Voltar</a>` : ''}<button class="btn btn-ghost" name="acao" value="salvar">Salvar rascunho</button><button class="btn" name="acao" value="avancar">Salvar e avançar</button></div>`;
  const action = ev ? `/organizador/eventos/${ev.id}/editar?etapa=${step}` : '/organizador/eventos/novo';
  const mods = ev ? await db.all('SELECT * FROM modalities WHERE event_id=? ORDER BY sort,id', ev.id) : [];
  const modOpts = [['', 'Todas as modalidades'], ...mods.map((m) => [m.id, m.name])];
  const sub = (type, inner) => html`<form method="post" action="/organizador/eventos/${ev.id}/itens/${type}" class="subform card">${csrf(req)}${inner}<button class="btn btn-sm">Adicionar</button></form>`;
  switch (step) {
    case 1: return html`<form method="post" action="${action}" novalidate>${csrf(req)}
      ${field('name', 'Nome do evento', { value: v.name, required: true })}
      ${field('description', 'Descrição', { type: 'textarea', rows: 6, value: v.description, required: true, hint: 'Apresente a prova, público, programação e diferenciais. Mínimo 30 caracteres.' })}
      <div class="row">${field('sport', 'Modalidade esportiva', { value: v.sport, options: SPORTS })}${field('start_local', 'Data e horário da largada', { type: 'datetime-local', value: v.start_local, required: true })}${field('timezone', 'Fuso horário do evento', { value: v.timezone || 'America/Sao_Paulo', options: TIMEZONES.map((t) => [t, tzLabel(t)]) })}</div>
      ${field('capacity', 'Limite total de inscritos (opcional)', { type: 'number', value: v.capacity, attrs: 'min="1"', hint: 'Além dos limites por modalidade e por lote.' })}
      ${ev ? html`<div class="field"><label for="cover">Imagem de capa</label><input type="file" id="cover" name="cover" accept="image/png,image/jpeg,image/webp" data-preview="cp"><small class="hint">JPG, PNG ou WEBP até 3 MB, proporção 16:9 (ex.: 1600×900).</small><img id="cp" alt="Prévia da capa" class="cover-prev" ${v.cover_path ? raw(`src="/media/${v.cover_path}"`) : raw('hidden')}></div>` : ''}
      ${nav}</form>`;
    case 2: return html`<form method="post" action="${action}" novalidate>${csrf(req)}
      <div class="row">${field('venue', 'Local (nome)', { value: v.venue })}${field('address', 'Endereço', { value: v.address, required: true })}</div>
      <div class="row">${field('city', 'Cidade', { value: v.city, required: true })}${field('state', 'UF', { value: v.state, required: true, options: [['', '—'], ...UF] })}</div>
      ${field('route_info', 'Descrição do percurso', { type: 'textarea', value: v.route_info })}${field('route_url', 'Link do mapa do percurso (opcional)', { type: 'url', value: v.route_url })}${nav}</form>
      <h2>Modalidades e distâncias</h2>${itemsTable(req, ev, 'modality', ['Nome', 'Distância', 'Vagas', 'Largada'], mods.map((m) => ({ id: m.id, cells: [m.name, m.distance_km ? `${m.distance_km} km` : '—', m.capacity ?? 'Sem limite', m.start_time || '—'] })))}
      ${sub('modality', html`<div class="row">${field('name', 'Nome (ex.: 5 km)', { required: true, id: 'm-name' })}${field('distance_km', 'Distância (km)', { type: 'number', attrs: 'step="0.001" min="0"', id: 'm-dist' })}${field('capacity', 'Vagas', { type: 'number', attrs: 'min="1"', id: 'm-cap' })}${field('start_time', 'Horário de largada', { type: 'time', id: 'm-time' })}</div>`)}`;
    case 3: {
      const cats = await db.all('SELECT c.*, m.name mn FROM categories c LEFT JOIN modalities m ON m.id=c.modality_id WHERE c.event_id=?', ev.id);
      return html`${tip('A categoria de cada atleta é atribuída automaticamente pela idade na data da prova e pelo sexo informado. Crie ao menos "Geral".')}
      ${itemsTable(req, ev, 'category', ['Categoria', 'Modalidade', 'Sexo', 'Idade'], cats.map((c) => ({ id: c.id, cells: [c.name, c.mn || 'Todas', { any: 'Todos', M: 'Masculino', F: 'Feminino' }[c.gender], `${c.min_age ?? '—'} a ${c.max_age ?? '—'}` ] })))}
      ${sub('category', html`<div class="row">${field('name', 'Nome', { required: true, id: 'c-name' })}${field('modality_id', 'Modalidade', { options: modOpts, id: 'c-mod' })}${field('gender', 'Sexo', { options: [['any', 'Todos'], ['M', 'Masculino'], ['F', 'Feminino']], id: 'c-g' })}${field('min_age', 'Idade mín.', { type: 'number', id: 'c-min' })}${field('max_age', 'Idade máx.', { type: 'number', id: 'c-max' })}</div>`)}
      <form method="post" action="/organizador/eventos/${ev.id}/itens/category-preset" class="inline">${csrf(req)}<button class="btn btn-ghost btn-sm">Gerar faixas etárias padrão (M/F, a cada 10 anos)</button></form>
      <form method="post" action="${action}">${csrf(req)}<h2>Critérios de classificação</h2>${field('ranking_basis', 'Classificação por', { value: v.ranking_basis, options: [['net', 'Tempo líquido (chip) — desempate pelo bruto'], ['gun', 'Tempo bruto (tiro) — desempate pelo líquido']] })}
      ${field('review_days', 'Prazo para atletas solicitarem revisão de resultado (dias)', { type: 'number', value: v.review_days, attrs: 'min="0" max="60"' })}${nav}</form>`;
    }
    case 4: {
      const lots = await db.all('SELECT l.*, m.name mn FROM lots l LEFT JOIN modalities m ON m.id=l.modality_id WHERE l.event_id=? ORDER BY sort,id', ev.id);
      return html`${tip('Os lotes viram automaticamente pelo período ou quando a quantidade esgota, na ordem abaixo. Preço zero = inscrição gratuita.')}
      ${itemsTable(req, ev, 'lot', ['Ordem', 'Lote', 'Modalidade', 'Preço', 'Início', 'Fim', 'Quantidade'], lots.map((l) => ({ id: l.id, cells: [String(l.sort), l.name, l.mn || 'Todas', l.price_cents ? brl(l.price_cents) : 'Gratuito', fmtDateTime(l.starts_utc, ev.timezone), fmtDateTime(l.ends_utc, ev.timezone), l.quantity ?? 'Sem limite'] })))}
      ${sub('lot', html`<div class="row">${field('name', 'Nome (ex.: 1º lote)', { required: true, id: 'l-name' })}${field('modality_id', 'Modalidade', { options: modOpts, id: 'l-mod' })}${field('price', 'Preço (R$)', { attrs: 'inputmode="decimal"', id: 'l-price', placeholder: '0,00' })}${field('sort', 'Ordem', { type: 'number', value: lots.length + 1, id: 'l-sort' })}</div>
        <div class="row">${field('starts_local', `Início (${tzLabel(ev.timezone)})`, { type: 'datetime-local', id: 'l-start' })}${field('ends_local', `Fim (${tzLabel(ev.timezone)})`, { type: 'datetime-local', id: 'l-end' })}${field('quantity', 'Quantidade', { type: 'number', attrs: 'min="1"', id: 'l-qty' })}</div>`)}
      <form method="post" action="${action}">${csrf(req)}${nav}</form>`;
    }
    case 5: {
      const kits = await db.all('SELECT * FROM kits WHERE event_id=?', ev.id);
      const prods = await db.all('SELECT * FROM products WHERE event_id=?', ev.id);
      return html`<h2>Kits</h2>${itemsTable(req, ev, 'kit', ['Kit', 'Adicional', 'Camisetas (estoque por tamanho)', 'Itens (estoque)'], await Promise.all(kits.map(async (k) => ({ id: k.id, cells: [k.name, k.extra_price_cents ? brl(k.extra_price_cents) : 'Incluso', k.has_shirt ? (await db.all('SELECT * FROM kit_sizes WHERE kit_id=?', k.id)).map((s) => `${s.size}: ${s.stock}`).join(' · ') : 'Sem camiseta', (await db.all('SELECT * FROM kit_items WHERE kit_id=? ORDER BY sort, id', k.id)).map((x) => `${x.name}: ${x.stock ?? 'sem controle'}`).join(' · ') || '—'] }))))}
      ${sub('kit', html`<div class="row">${field('name', 'Nome do kit', { required: true, id: 'k-name' })}${field('extra_price', 'Valor adicional (R$)', { id: 'k-price', placeholder: '0,00' })}</div>${field('description', 'Descrição do kit', { id: 'k-desc' })}${field('sizes', 'Tamanhos da camiseta e estoque', { id: 'k-sizes', placeholder: 'PP:20, P:80, M:120, G:100, GG:40', hint: 'Deixe vazio para kit sem camiseta.' })}
      ${field('items', 'Itens do kit e quantidade em estoque', { id: 'k-items', placeholder: 'Boné:300, Medalha de participação:500, Número de peito', hint: 'Formato Nome:quantidade separado por vírgula. Sem quantidade = sem controle de estoque. Quando um item acaba, o kit fica esgotado.' })}
      <fieldset class="kit-suggest"><legend>Itens comuns (marque para incluir sem controle de estoque)</legend>${kitStock.SUGGESTED_ITEMS.map((n, i) => field(`item_s${i}`, n, { type: 'checkbox', id: `k-s${i}` }))}</fieldset>
      <p class="hint">Tênis não faz parte do kit. Ajuste quantidades depois na aba Estoque do kit.</p>`)}
      <h2>Produtos extras</h2>${tip('Acessórios e camisetas adicionais vendidos no carrinho ou depois da inscrição. Comprar um produto não gera nova inscrição.')}
      ${itemsTable(req, ev, 'product', ['Produto', 'Preço', 'Variações (estoque)'], await Promise.all(prods.map(async (p) => ({ id: p.id, cells: [p.name, brl(p.price_cents), (await db.all('SELECT * FROM product_variants WHERE product_id=?', p.id)).map((x) => `${x.label}: ${x.stock}`).join(' · ')] }))))}
      ${sub('product', html`<div class="row">${field('name', 'Produto', { required: true, id: 'p-name' })}${field('price', 'Preço (R$)', { required: true, id: 'p-price' })}${field('variants', 'Variações e estoque', { required: true, id: 'p-var', placeholder: 'Único:50  ou  P:10, M:20' })}</div>`)}
      <form method="post" action="${action}">${csrf(req)}${nav}</form>`;
    }
    case 6: {
      const qs = await db.all('SELECT q.*, m.name mn FROM questions q LEFT JOIN modalities m ON m.id=q.modality_id WHERE q.event_id=? AND q.active=1', ev.id);
      return html`<form method="post" action="${action}" novalidate>${csrf(req)}
      ${field('regulation', `Regulamento (versão atual: ${v.regulation_version || 'nenhuma'})`, { type: 'textarea', rows: 10, value: v.regulation, required: true, hint: 'Alterar o texto gera nova versão. O aceite de cada atleta registra a versão vigente.' })}
      ${field('change_policy', 'Regras de alteração (titular, modalidade, camiseta)', { type: 'textarea', value: v.change_policy })}
      ${field('cancel_policy', 'Política de cancelamento e reembolso', { type: 'textarea', value: v.cancel_policy, required: true })}
      <div class="row">${field('change_deadline_local', 'Prazo para alterações e cancelamentos', { type: 'datetime-local', value: utcToZonedInput(v.change_deadline_utc, v.timezone) })}${field('change_fee', 'Taxa por alteração (R$, 0 = grátis)', { value: centsToInput(v.change_fee_cents) })}</div>
      ${field('allow_modality_change', 'Permitir troca de modalidade/distância', { type: 'checkbox', value: v.allow_modality_change })}${field('allow_shirt_change', 'Permitir troca de tamanho de camiseta', { type: 'checkbox', value: v.allow_shirt_change })}${field('allow_transfer', 'Permitir transferência de titularidade', { type: 'checkbox', value: v.allow_transfer })}
      ${nav}</form>
      <section class="card"><h2>Assistente de conteúdo (opcional)</h2><p>Gera sugestões de blocos da página <strong>somente</strong> a partir do regulamento salvo. Nada é publicado sem sua revisão.</p>
      <form method="post" action="/organizador/eventos/${ev.id}/assistente">${csrf(req)}<button class="btn btn-ghost btn-sm" ${v.regulation ? '' : 'disabled'}>Sugerir textos a partir do regulamento</button></form>${extra.ai || ''}</section>
      <h2>Questionário personalizado</h2>${tip('Pergunte apenas o necessário e informe a finalidade. As respostas ficam restritas à equipe autorizada.')}
      ${itemsTable(req, ev, 'question', ['Pergunta', 'Finalidade', 'Tipo', 'Modalidade', 'Obrigatória'], qs.map((q) => ({ id: q.id, cells: [q.label, q.purpose || '—', { text: 'Texto', select: `Seleção (${json(q.options, []).join(', ')})`, checkbox: 'Confirmação' }[q.type], q.mn || 'Todas', q.required ? 'Sim' : 'Não'] })))}
      ${sub('question', html`<div class="row">${field('label', 'Pergunta', { required: true, id: 'q-l' })}${field('purpose', 'Finalidade (exibida ao atleta)', { required: true, id: 'q-p' })}</div><div class="row">${field('type', 'Tipo', { options: [['text', 'Texto'], ['select', 'Seleção'], ['checkbox', 'Confirmação (sim)']], id: 'q-t' })}${field('options', 'Opções (seleção, separadas por vírgula)', { id: 'q-o' })}${field('modality_id', 'Modalidade', { options: modOpts, id: 'q-m' })}</div>${field('required', 'Obrigatória', { type: 'checkbox', id: 'q-r' })}`)}`;
    }
    case 7: {
      const pts = await db.all('SELECT * FROM pickup_points WHERE event_id=?', ev.id);
      return html`<form method="post" action="${action}" novalidate>${csrf(req)}
      ${field('kit_pickup_info', 'Retirada dos kits: locais, datas, horários e documentos exigidos', { type: 'textarea', value: v.kit_pickup_info, required: true })}
      ${field('allow_third_party_pickup', 'Permitir retirada por terceiros (com registro de nome e documento)', { type: 'checkbox', value: v.allow_third_party_pickup })}
      <div class="row">${field('support_email', 'E-mail de atendimento do evento', { type: 'email', value: v.support_email, required: true })}${field('support_phone', 'Telefone de atendimento do evento', { value: v.support_phone, required: true })}</div>${nav}</form>
      <h2>Pontos de retirada</h2>${itemsTable(req, ev, 'point', ['Ponto'], pts.map((p) => ({ id: p.id, cells: [p.name] })))}${sub('point', field('name', 'Nome do ponto (ex.: Loja Centro — Balcão 1)', { required: true, id: 'pt-n' }))}`;
    }
    case 8: {
      const cps = await db.all('SELECT * FROM coupons WHERE event_id=?', ev.id);
      const paid = await isPaidEvent(ev.id); const act = await activation(req.org);
      return html`<form method="post" action="${action}">${csrf(req)}
      <p>Evento ${paid ? html`<strong>pago</strong> — exige recebimento configurado (${act.items.payments ? badge('configurado', 'ok') : html`${badge('pendente', 'warn')} <a href="/organizador/recebimentos">configurar</a>`}).` : html`<strong>gratuito</strong> — pode ser publicado sem integração financeira.`}</p>
      <p>Taxa de serviço da plataforma para este evento: <strong>${String(v.fee_percent).replace('.', ',')}%</strong> (definida pela administração).</p>
      ${field('fee_payer', 'Quem assume a taxa de serviço?', { value: v.fee_payer, options: [['athlete', 'Atleta (acrescida no pagamento)'], ['organizer', 'Organização (descontada do repasse)']] })}
      ${field('reservation_minutes', 'Tempo de reserva da vaga durante o pagamento (minutos)', { type: 'number', value: v.reservation_minutes, attrs: 'min="5" max="120"' })}
      ${field('allow_duplicate', 'Permitir mais de uma inscrição por CPF neste evento', { type: 'checkbox', value: v.allow_duplicate })}${nav}</form>
      <h2>Cupons e condições para grupos</h2>${itemsTable(req, ev, 'coupon', ['Código', 'Desconto', 'Mín. no pedido', 'Limite de usos'], cps.map((c) => ({ id: c.id, cells: [c.code, c.percent_off ? `${c.percent_off}%` : brl(c.amount_off_cents), String(c.min_group), c.max_uses ?? 'Sem limite'] })))}
      ${sub('coupon', html`<div class="row">${field('code', 'Código', { required: true, id: 'cp-c' })}${field('percent_off', 'Desconto %', { type: 'number', attrs: 'min="1" max="100"', id: 'cp-p' })}${field('amount_off', 'ou valor (R$)', { id: 'cp-a' })}${field('min_group', 'Mínimo de inscrições no pedido (grupos)', { type: 'number', value: 1, id: 'cp-g' })}${field('max_uses', 'Limite de usos', { type: 'number', id: 'cp-m' })}</div>`)}`;
    }
    default: {
      const pend = await publishChecklist(ev, req.org);
      return html`<p><a class="btn btn-ghost" href="/e/${ev.slug}" target="_blank">Ver prévia da página pública</a></p>
      ${pend.length ? html`<div class="alert alert-warn"><strong>Pendências para publicar:</strong><ul>${pend.map((p) => html`<li>${p.msg} <a href="${p.href}">Corrigir</a></li>`)}</ul></div>` : html`<div class="alert alert-success">Tudo pronto para publicar.</div>`}
      ${ev.status === 'draft' ? html`<form method="post" action="/organizador/eventos/${ev.id}/publicar">${csrf(req)}<button class="btn btn-lg" ${pend.length ? 'disabled' : ''}>Publicar evento</button></form>` : html`<p>Situação: <strong>${ev.status}</strong>. Alterações salvas aparecem imediatamente na página pública.</p>`}`;
    }
  }
}

async function loadEv(req) { const ev = await eventForOrg(Number(req.params.id), req.org.id); assertCan(req.member, 'events', ev.id); return ev; }

r.get('/eventos/:id/editar', async (req, res) => {
  const ev = await loadEv(req);
  const step = Math.min(9, Math.max(1, Number(req.query.etapa) || ev.wizard_step || 1));
  res.page({ title: `Editar — ${ev.name}`, wide: true, body: html`<section class="card wizard"><p><a href="/organizador/eventos/${ev.id}">← ${ev.name}</a> ${ev.status === 'draft' ? badge('Rascunho', 'muted') : badge('Publicado', 'ok')}</p>
  ${steps(STEPS.map((l, i) => ({ label: l, href: `/organizador/eventos/${ev.id}/editar?etapa=${i + 1}` })), step)}${await stepForm(req, ev, step)}</section>` });
});

r.post('/eventos/:id/editar', upload(3).single('cover'), (req, res, next) => ((req.headers['content-type'] || '').startsWith('multipart') ? csrfAfterMultipart(req, res, next) : next()), async (req, res) => {
  const ev = await loadEv(req); const b = req.body; const step = Number(req.query.etapa) || 1;
  const set = {};
  if (step === 1) {
    if (!b.name?.trim()) throw new UserError('Informe o nome do evento.');
    const tz = TIMEZONES.includes(b.timezone) ? b.timezone : ev.timezone;
    Object.assign(set, { name: b.name.trim(), description: b.description || null, sport: SPORTS.includes(b.sport) ? b.sport : ev.sport, start_local: b.start_local || null, timezone: tz, start_utc: zonedToUtc(b.start_local, tz), capacity: b.capacity ? Number(b.capacity) : null });
    const cover = checkFile(req.file, ['image/png', 'image/jpeg', 'image/webp'], 'Capa');
    if (cover) set.cover_path = store(cover, { isPrivate: false });
  } else if (step === 2) Object.assign(set, { venue: b.venue || null, address: b.address || null, city: b.city || null, state: UF.includes(b.state) ? b.state : null, route_info: b.route_info || null, route_url: b.route_url || null });
  else if (step === 3) Object.assign(set, { ranking_basis: b.ranking_basis === 'gun' ? 'gun' : 'net', review_days: Math.max(0, Math.min(60, Number(b.review_days) || 0)) });
  else if (step === 6) {
    Object.assign(set, { change_policy: b.change_policy || null, cancel_policy: b.cancel_policy || null, change_deadline_utc: zonedToUtc(b.change_deadline_local, ev.timezone), change_fee_cents: toCents(b.change_fee), allow_modality_change: b.allow_modality_change ? 1 : 0, allow_shirt_change: b.allow_shirt_change ? 1 : 0, allow_transfer: b.allow_transfer ? 1 : 0 });
    if ((b.regulation || '') !== (ev.regulation || '')) { set.regulation = b.regulation || null; set.regulation_version = ev.regulation_version + 1; }
  } else if (step === 7) Object.assign(set, { kit_pickup_info: b.kit_pickup_info || null, allow_third_party_pickup: b.allow_third_party_pickup ? 1 : 0, support_email: b.support_email || null, support_phone: b.support_phone || null });
  else if (step === 8) Object.assign(set, { fee_payer: b.fee_payer === 'organizer' ? 'organizer' : 'athlete', reservation_minutes: Math.max(5, Math.min(120, Number(b.reservation_minutes) || 15)), allow_duplicate: b.allow_duplicate ? 1 : 0 });
  const next = b.acao === 'avancar' ? Math.min(9, step + 1) : step;
  set.wizard_step = Math.max(ev.wizard_step, next); set.updated_at = nowIso();
  const keys = Object.keys(set);
  await db.run(`UPDATE events SET ${keys.map((k) => `${k}=?`).join(', ')} WHERE id=? AND org_id=?`, ...keys.map((k) => set[k]), ev.id, req.org.id);
  await audit(req, 'event.updated', { orgId: req.org.id, entity: 'event', entityId: ev.id, detail: { step, regulation_version: set.regulation_version } });
  if (b.acao !== 'avancar') res.flash('success', 'Rascunho salvo.');
  res.redirect(303, `/organizador/eventos/${ev.id}/editar?etapa=${next}`);
});

const parsePairs = (s) => kitStock.parsePairs(s);
const optMod = async (ev, id) => { if (!id) return null; if (!await db.one('SELECT 1 FROM modalities WHERE id=? AND event_id=?', Number(id), ev.id)) throw new UserError('Modalidade inválida.'); return Number(id); };

r.post('/eventos/:id/itens/:type', async (req, res) => {
  const ev = await loadEv(req); const b = req.body; const t = req.params.type;
  const step = { modality: 2, category: 3, 'category-preset': 3, lot: 4, kit: 5, product: 5, question: 6, point: 7, coupon: 8 }[t];
  if (!step) throw new UserError('Tipo inválido.');
  await db.tx(async () => {
    if (t === 'modality') { if (!b.name) throw new UserError('Informe o nome.'); await db.run('INSERT INTO modalities(event_id,name,distance_km,capacity,start_time,sort) VALUES(?,?,?,?,?,?)', ev.id, b.name.trim(), b.distance_km ? Number(b.distance_km) : null, b.capacity ? Number(b.capacity) : null, b.start_time || null, (await db.one('SELECT COUNT(*) n FROM modalities WHERE event_id=?', ev.id)).n); }
    if (t === 'category') { if (!b.name) throw new UserError('Informe o nome.'); await db.run('INSERT INTO categories(event_id,modality_id,name,gender,min_age,max_age) VALUES(?,?,?,?,?,?)', ev.id, await optMod(ev, b.modality_id), b.name.trim(), ['M', 'F'].includes(b.gender) ? b.gender : 'any', b.min_age !== '' && b.min_age != null ? Number(b.min_age) : null, b.max_age !== '' && b.max_age != null ? Number(b.max_age) : null); }
    if (t === 'category-preset') {
      for (const g of ['F', 'M']) for (const [a, z] of [[0, 19], [20, 29], [30, 39], [40, 49], [50, 59], [60, 69], [70, null]]) await db.run('INSERT INTO categories(event_id,name,gender,min_age,max_age) VALUES(?,?,?,?,?)', ev.id, `${g === 'F' ? 'Feminino' : 'Masculino'} ${z == null ? `${a}+` : `${a}-${z}`}`, g, a, z);
    }
    if (t === 'lot') { if (!b.name) throw new UserError('Informe o nome do lote.'); const s = zonedToUtc(b.starts_local, ev.timezone), e = zonedToUtc(b.ends_local, ev.timezone); if (s && e && e <= s) throw new UserError('O fim do lote deve ser depois do início.'); await db.run('INSERT INTO lots(event_id,modality_id,name,price_cents,starts_utc,ends_utc,quantity,sort) VALUES(?,?,?,?,?,?,?,?)', ev.id, await optMod(ev, b.modality_id), b.name.trim(), toCents(b.price), s, e, b.quantity ? Number(b.quantity) : null, Number(b.sort) || 0); }
    if (t === 'kit') { if (!b.name) throw new UserError('Informe o nome do kit.'); const sizes = parsePairs(b.sizes); const items = kitStock.parseKitItems(b); const id = Number((await db.run('INSERT INTO kits(event_id,name,description,extra_price_cents,has_shirt) VALUES(?,?,?,?,?)', ev.id, b.name.trim(), b.description || null, toCents(b.extra_price), sizes.length ? 1 : 0)).lastInsertRowid); for (const [s, n] of sizes) await db.run('INSERT INTO kit_sizes(kit_id,size,stock) VALUES(?,?,?)', id, s, n); for (const [i, [n, q]] of items.entries()) await db.run('INSERT INTO kit_items(kit_id,name,stock,sort) VALUES(?,?,?,?)', id, n, q, i); }
    if (t === 'product') { if (!b.name) throw new UserError('Informe o produto.'); const vs = parsePairs(b.variants); if (!vs.length) throw new UserError('Informe ao menos uma variação com estoque.'); const id = Number((await db.run('INSERT INTO products(event_id,name,price_cents) VALUES(?,?,?)', ev.id, b.name.trim(), toCents(b.price))).lastInsertRowid); for (const [l, n] of vs) await db.run('INSERT INTO product_variants(product_id,label,stock) VALUES(?,?,?)', id, l, n); }
    if (t === 'question') { if (!b.label || !b.purpose) throw new UserError('Informe pergunta e finalidade.'); const opts = b.type === 'select' ? String(b.options || '').split(',').map((x) => x.trim()).filter(Boolean) : []; if (b.type === 'select' && opts.length < 2) throw new UserError('Informe ao menos duas opções.'); await db.run('INSERT INTO questions(event_id,modality_id,label,purpose,type,options,required) VALUES(?,?,?,?,?,?,?)', ev.id, await optMod(ev, b.modality_id), b.label.trim(), b.purpose.trim(), ['text', 'select', 'checkbox'].includes(b.type) ? b.type : 'text', JSON.stringify(opts), b.required ? 1 : 0); }
    if (t === 'point') { if (!b.name) throw new UserError('Informe o nome.'); await db.run('INSERT INTO pickup_points(event_id,name) VALUES(?,?)', ev.id, b.name.trim()); }
    if (t === 'coupon') { if (!b.code || (!b.percent_off && !b.amount_off)) throw new UserError('Informe código e desconto.'); await db.run('INSERT INTO coupons(event_id,code,percent_off,amount_off_cents,min_group,max_uses) VALUES(?,?,?,?,?,?)', ev.id, b.code.trim().toUpperCase(), b.percent_off ? Number(b.percent_off) : null, b.amount_off ? toCents(b.amount_off) : null, Math.max(1, Number(b.min_group) || 1), b.max_uses ? Number(b.max_uses) : null); }
  });
  await audit(req, `event.item_added.${t}`, { orgId: req.org.id, entity: 'event', entityId: ev.id });
  res.redirect(303, `/organizador/eventos/${ev.id}/editar?etapa=${step}`);
});

r.post('/eventos/:id/itens/:type/:itemId/remover', async (req, res) => {
  const ev = await loadEv(req); const t = req.params.type; const id = Number(req.params.itemId);
  const map = { modality: ['modalities', 'modality_id', 2], category: ['categories', 'category_id', 3], lot: ['lots', 'lot_id', 4], kit: ['kits', 'kit_id', 5], product: ['products', null, 5], question: ['questions', null, 6], point: ['pickup_points', null, 7], coupon: ['coupons', 'coupon_id', 8] }[t];
  if (!map) throw new UserError('Tipo inválido.');
  const [tbl, fk, step] = map;
  if (!await db.one(`SELECT 1 FROM ${tbl} WHERE id=? AND event_id=?`, id, ev.id)) throw new UserError('Item não encontrado.', 404);
  const used = fk === 'coupon_id' ? await db.one('SELECT 1 FROM orders WHERE coupon_id=?', id) : fk ? await db.one(`SELECT 1 FROM registrations WHERE ${fk}=?`, id) : t === 'product' ? await db.one('SELECT 1 FROM order_items i JOIN product_variants v ON v.id=i.variant_id WHERE v.product_id=?', id) : null;
  if (t === 'question') { await db.run('UPDATE questions SET active=0 WHERE id=?', id); } // preserva respostas e versão
  else if (used) { if (t === 'product') await db.run('UPDATE products SET active=0 WHERE id=?', id); else if (t === 'coupon') await db.run('UPDATE coupons SET active=0 WHERE id=?', id); else throw new UserError('Item já utilizado em inscrições: não pode ser removido. Ajuste vagas ou período.'); }
  else await db.tx(async () => { if (t === 'kit') { await db.run('DELETE FROM kit_sizes WHERE kit_id=?', id); await db.run('DELETE FROM kit_items WHERE kit_id=?', id); await db.run('DELETE FROM kit_stock_moves WHERE kit_id=?', id); } if (t === 'product') await db.run('DELETE FROM product_variants WHERE product_id=?', id); if (t === 'modality') { await db.run('DELETE FROM categories WHERE modality_id=?', id); await db.run('DELETE FROM lots WHERE modality_id=?', id); } await db.run(`DELETE FROM ${tbl} WHERE id=?`, id); });
  await audit(req, `event.item_removed.${t}`, { orgId: req.org.id, entity: 'event', entityId: ev.id, detail: { id } });
  res.redirect(303, `/organizador/eventos/${ev.id}/editar?etapa=${step}`);
});

r.post('/eventos/:id/publicar', async (req, res) => {
  const ev = await loadEv(req);
  const pend = await publishChecklist(ev, req.org);
  if (pend.length) throw new UserError(`Não foi possível publicar: ${pend.map((p) => p.msg).join(' ')}`);
  await db.run("UPDATE events SET status='published', published_at=?, regulation_version=GREATEST(regulation_version,1) WHERE id=? AND status='draft'", nowIso(), ev.id);
  await audit(req, 'event.published', { orgId: req.org.id, entity: 'event', entityId: ev.id });
  res.flash('success', 'Evento publicado!');
  res.redirect(303, `/organizador/eventos/${ev.id}`);
});
r.post('/eventos/:id/status', async (req, res) => {
  const ev = await loadEv(req); const to = req.body.status;
  const allowed = { closed: ['published'], published: ['closed'], cancelled: ['published', 'closed', 'draft'], completed: ['published', 'closed'] }[to];
  if (!allowed || !allowed.includes(ev.status)) throw new UserError('Mudança de situação não permitida.');
  if (to === 'published' && (await publishChecklist(ev, req.org)).length) throw new UserError('Há pendências para reabrir as inscrições.');
  await db.run('UPDATE events SET status=?, updated_at=? WHERE id=?', to, nowIso(), ev.id);
  if (to === 'cancelled') {
    const emails = await db.all("SELECT DISTINCT u.email FROM registrations g JOIN users u ON u.id=g.buyer_user_id WHERE g.event_id=? AND g.status='confirmed'", ev.id);
    for (const e of emails) await require('../lib/core').sendMail(e.email, `Evento cancelado — ${ev.name}`, `O organizador cancelou o evento ${ev.name}. Acompanhe em Minhas inscrições as orientações de reembolso conforme a política do evento.`, 'event_updates');
  }
  await audit(req, 'event.status', { orgId: req.org.id, entity: 'event', entityId: ev.id, detail: { from: ev.status, to } });
  res.redirect(303, `/organizador/eventos/${ev.id}`);
});
r.post('/eventos/:id/duplicar', async (req, res) => {
  const ev = await loadEv(req);
  const id = await db.tx(async () => {
    const cols = ['name', 'description', 'sport', 'timezone', 'venue', 'address', 'city', 'state', 'route_info', 'route_url', 'cover_path', 'regulation', 'change_policy', 'cancel_policy', 'allow_transfer', 'allow_modality_change', 'allow_shirt_change', 'change_fee_cents', 'kit_pickup_info', 'support_phone', 'support_email', 'fee_percent', 'fee_payer', 'reservation_minutes', 'allow_duplicate', 'capacity', 'ranking_basis', 'review_days', 'allow_third_party_pickup'];
    const vals = cols.map((c) => (c === 'name' ? `${ev.name} (cópia)` : ev[c]));
    const nid = Number((await db.run(`INSERT INTO events(org_id,slug,status,wizard_step,regulation_version,${cols.join(',')}) VALUES(?,?,'draft',1,0,${cols.map(() => '?').join(',')})`, req.org.id, await uniqueSlug(`${ev.name} copia`), ...vals)).lastInsertRowid);
    const modMap = {};
    for (const m of await db.all('SELECT * FROM modalities WHERE event_id=?', ev.id)) modMap[m.id] = Number((await db.run('INSERT INTO modalities(event_id,name,distance_km,capacity,start_time,sort) VALUES(?,?,?,?,?,?)', nid, m.name, m.distance_km, m.capacity, m.start_time, m.sort)).lastInsertRowid);
    for (const c of await db.all('SELECT * FROM categories WHERE event_id=?', ev.id)) await db.run('INSERT INTO categories(event_id,modality_id,name,gender,min_age,max_age) VALUES(?,?,?,?,?,?)', nid, modMap[c.modality_id] ?? null, c.name, c.gender, c.min_age, c.max_age);
    for (const l of await db.all('SELECT * FROM lots WHERE event_id=?', ev.id)) await db.run('INSERT INTO lots(event_id,modality_id,name,price_cents,quantity,sort) VALUES(?,?,?,?,?,?)', nid, modMap[l.modality_id] ?? null, l.name, l.price_cents, l.quantity, l.sort); // períodos precisam ser redefinidos
    for (const k of await db.all('SELECT * FROM kits WHERE event_id=?', ev.id)) { const kid = Number((await db.run('INSERT INTO kits(event_id,name,description,extra_price_cents,has_shirt) VALUES(?,?,?,?,?)', nid, k.name, k.description, k.extra_price_cents, k.has_shirt)).lastInsertRowid); for (const s of await db.all('SELECT * FROM kit_sizes WHERE kit_id=?', k.id)) await db.run('INSERT INTO kit_sizes(kit_id,size,stock) VALUES(?,?,?)', kid, s.size, s.stock); for (const x of await db.all('SELECT * FROM kit_items WHERE kit_id=?', k.id)) await db.run('INSERT INTO kit_items(kit_id,name,stock,limits_sales,sort) VALUES(?,?,?,?,?)', kid, x.name, x.stock, x.limits_sales, x.sort); }
    for (const p of await db.all('SELECT * FROM products WHERE event_id=? AND active=1', ev.id)) { const pid = Number((await db.run('INSERT INTO products(event_id,name,description,price_cents) VALUES(?,?,?,?)', nid, p.name, p.description, p.price_cents)).lastInsertRowid); for (const v of await db.all('SELECT * FROM product_variants WHERE product_id=?', p.id)) await db.run('INSERT INTO product_variants(product_id,label,stock) VALUES(?,?,?)', pid, v.label, v.stock); }
    for (const q of await db.all('SELECT * FROM questions WHERE event_id=? AND active=1', ev.id)) await db.run('INSERT INTO questions(event_id,modality_id,label,purpose,type,options,required) VALUES(?,?,?,?,?,?,?)', nid, modMap[q.modality_id] ?? null, q.label, q.purpose, q.type, q.options, q.required);
    for (const p of await db.all('SELECT * FROM pickup_points WHERE event_id=?', ev.id)) await db.run('INSERT INTO pickup_points(event_id,name) VALUES(?,?)', nid, p.name);
    return nid;
  });
  await audit(req, 'event.duplicated', { orgId: req.org.id, entity: 'event', entityId: id, detail: { from: ev.id } });
  res.flash('success', 'Evento duplicado como rascunho, sem inscrições, transações ou resultados. Redefina data e períodos dos lotes.');
  res.redirect(303, `/organizador/eventos/${id}/editar?etapa=1`);
});

// Assistente de conteúdo: sugestões ficam em rascunho até aprovação explícita
r.post('/eventos/:id/assistente', async (req, res) => {
  const ev = await loadEv(req);
  const sug = await suggestFromRegulation(ev.regulation || '');
  const block = html`<div class="ai-box"><p>${badge(sug.source === 'llm' ? 'Sugestão gerada por IA — revise' : 'Extração automática do regulamento — revise', 'info')}</p>
    ${sug.missing.length ? html`<div class="alert alert-warn">Não encontrado no regulamento: ${sug.missing.join(', ')}. Complete manualmente; o assistente não inventa informações.</div>` : ''}
    <form method="post" action="/organizador/eventos/${ev.id}/assistente/aplicar">${csrf(req)}
    ${field('description', 'Descrição sugerida', { type: 'textarea', value: sug.description, rows: 5, id: 'ai-desc' })}
    ${field('route_info', 'Percurso sugerido', { type: 'textarea', value: sug.route_info, id: 'ai-route' })}
    ${field('kit_pickup_info', 'Retirada de kits sugerida', { type: 'textarea', value: sug.kit_pickup_info, id: 'ai-kit' })}
    <p class="muted">Programação e premiação identificadas: ${sug.schedule || '—'} / ${sug.awards || '—'}</p>
    <button class="btn btn-sm">Aprovar e aplicar ao rascunho</button> <a href="/organizador/eventos/${ev.id}/editar?etapa=6">Descartar</a></form></div>`;
  res.page({ title: 'Assistente de conteúdo', wide: true, body: html`<section class="card wizard"><p><a href="/organizador/eventos/${ev.id}/editar?etapa=6">← Voltar ao regulamento</a></p>${await stepForm(req, ev, 6, { ai: block })}</section>` });
});
r.post('/eventos/:id/assistente/aplicar', async (req, res) => {
  const ev = await loadEv(req); const b = req.body;
  await db.run('UPDATE events SET description=COALESCE(NULLIF(?,\'\'),description), route_info=COALESCE(NULLIF(?,\'\'),route_info), kit_pickup_info=COALESCE(NULLIF(?,\'\'),kit_pickup_info), updated_at=? WHERE id=?', b.description || '', b.route_info || '', b.kit_pickup_info || '', nowIso(), ev.id);
  await audit(req, 'event.ai_content_approved', { orgId: req.org.id, entity: 'event', entityId: ev.id });
  res.flash('success', 'Textos aprovados aplicados ao evento. Revise as etapas 1, 2 e 7.');
  res.redirect(303, `/organizador/eventos/${ev.id}/editar?etapa=1`);
});

module.exports = r;
