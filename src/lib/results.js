'use strict';
const db = require('../db');
const { parseCsv, parseDuration, nowIso } = require('./util');

const RESULT_STATUS = { finished: 'Concluiu', dns: 'Não largou', dnf: 'Não concluiu', dsq: 'Desclassificado' };
const STATUS_IN = { CONCLUIU: 'finished', FINISHED: 'finished', '': 'finished', NAO_LARGOU: 'dns', DNS: 'dns', NAO_CONCLUIU: 'dnf', DNF: 'dnf', DESCLASSIFICADO: 'dsq', DSQ: 'dsq' };
const TEMPLATE_HEADERS = ['numero_peito', 'nome', 'modalidade', 'tempo_bruto', 'tempo_liquido', 'situacao'];
const TEMPLATE_CSV = '﻿' + TEMPLATE_HEADERS.join(';') + '\r\n1;Nome do Atleta;5 km;00:25:31;00:25:10;CONCLUIU\r\n2;Outra Atleta;10 km;;;NAO_LARGOU\r\n';

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toUpperCase().replace(/\s+/g, '_');

/** Lê CSV e devolve prévia com erros por linha. Nada é salvo aqui. */
async function preview(eventId, text) {
  const rows = parseCsv(text);
  if (!rows.length) return { rows: [], errors: ['Arquivo vazio.'], valid: 0 };
  const header = rows[0].map((h) => norm(h).toLowerCase());
  const missing = ['numero_peito', 'tempo_bruto', 'tempo_liquido', 'situacao'].filter((h) => !header.includes(h));
  if (missing.length) return { rows: [], errors: [`Colunas obrigatórias ausentes: ${missing.join(', ')}. Use o modelo de importação.`], valid: 0 };
  const col = (r, name) => (r[header.indexOf(name)] ?? '').trim();
  const regs = new Map((await db.all("SELECT g.*, m.name modality_name, m.distance_km FROM registrations g JOIN modalities m ON m.id=g.modality_id WHERE g.event_id=? AND g.status='confirmed' AND g.bib IS NOT NULL", eventId)).map((g) => [g.bib, g]));
  const seen = new Set();
  const out = rows.slice(1).map((r, i) => {
    const line = i + 2; const errors = [];
    const bib = col(r, 'numero_peito').replace(/^0+(?=\d)/, '');
    const reg = regs.get(bib);
    if (!bib) errors.push('Número de peito vazio');
    else if (!reg) errors.push(`Número ${bib} não corresponde a inscrição confirmada`);
    if (seen.has(bib)) errors.push(`Número ${bib} repetido no arquivo`);
    seen.add(bib);
    const st = STATUS_IN[norm(col(r, 'situacao'))];
    if (!st) errors.push(`Situação inválida "${col(r, 'situacao')}" (use CONCLUIU, NAO_LARGOU, NAO_CONCLUIU ou DESCLASSIFICADO)`);
    const gun = parseDuration(col(r, 'tempo_bruto')), net = parseDuration(col(r, 'tempo_liquido'));
    if (Number.isNaN(gun)) errors.push('Tempo bruto inválido (use hh:mm:ss)');
    if (Number.isNaN(net)) errors.push('Tempo líquido inválido (use hh:mm:ss)');
    if (st === 'finished' && !(gun > 0) && !(net > 0)) errors.push('Participante que concluiu precisa de tempo');
    if (gun > 0 && net > 0 && net > gun) errors.push('Tempo líquido maior que o bruto');
    const modCsv = col(r, 'modalidade');
    if (reg && modCsv && norm(modCsv) !== norm(reg.modality_name)) errors.push(`Modalidade "${modCsv}" difere da inscrição (${reg.modality_name})`);
    return { line, bib, name: reg?.name || col(r, 'nome'), registration_id: reg?.id, modality_id: reg?.modality_id, modality_name: reg?.modality_name, category_id: reg?.category_id, gender: reg?.gender, distance_km: reg?.distance_km,
      gun_s: Number.isNaN(gun) ? null : gun, net_s: Number.isNaN(net) ? null : net, status: st, errors };
  });
  return { rows: out, errors: [], valid: out.filter((r) => !r.errors.length).length };
}

/** Classificação geral, por sexo e por categoria. Critério: líquido ou bruto; desempate pelo outro tempo e número. */
function rank(rows, basis = 'net') {
  const key = (r) => (basis === 'gun' ? [r.gun_s ?? r.net_s, r.net_s ?? r.gun_s] : [r.net_s ?? r.gun_s, r.gun_s ?? r.net_s]);
  const cmp = (a, b) => { const ka = key(a), kb = key(b); return ka[0] - kb[0] || ka[1] - kb[1] || Number(a.bib) - Number(b.bib); };
  rows.forEach((r) => {
    r.rank_overall = r.rank_gender = r.rank_category = null;
    const t = r.net_s ?? r.gun_s;
    r.pace_s_km = r.status === 'finished' && t > 0 && r.distance_km > 0 ? Math.round(t / r.distance_km) : null;
  });
  const fin = rows.filter((r) => r.status === 'finished');
  const groups = (fn) => fin.reduce((m, r) => { const k = fn(r); (m[k] ||= []).push(r); return m; }, {});
  for (const g of Object.values(groups((r) => r.modality_id))) g.sort(cmp).forEach((r, i) => (r.rank_overall = i + 1));
  for (const g of Object.values(groups((r) => `${r.modality_id}|${r.gender}`))) g.sort(cmp).forEach((r, i) => (r.rank_gender = i + 1));
  for (const g of Object.values(groups((r) => `${r.modality_id}|${r.category_id}`))) g.sort(cmp).forEach((r, i) => (r.rank_category = r.category_id ? i + 1 : null));
  return rows;
}

async function saveVersion(eventId, rows, userId, note) {
  return await db.tx(async () => {
    const ev = await db.one('SELECT ranking_basis FROM events WHERE id=?', eventId);
    const v = ((await db.one('SELECT MAX(version) v FROM result_versions WHERE event_id=?', eventId)).v || 0) + 1;
    const vid = Number((await db.run("INSERT INTO result_versions(event_id,version,status,note,created_by) VALUES(?,?,'draft',?,?)", eventId, v, note || null, userId)).lastInsertRowid);
    for (const r of rank(rows.map((x) => ({ ...x })), ev.ranking_basis)) {
      await db.run('INSERT INTO results(version_id,event_id,registration_id,bib,name,modality_id,category_id,gender,gun_s,net_s,status,pace_s_km,rank_overall,rank_gender,rank_category) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
        vid, eventId, r.registration_id, r.bib, r.name, r.modality_id, r.category_id, r.gender, r.gun_s, r.net_s, r.status, r.pace_s_km, r.rank_overall, r.rank_gender, r.rank_category);
    }
    return vid;
  });
}
async function versionRows(versionId) {
  return await db.all('SELECT r.*, m.distance_km, m.name modality_name, c.name category_name FROM results r LEFT JOIN modalities m ON m.id=r.modality_id LEFT JOIN categories c ON c.id=r.category_id WHERE version_id=? ORDER BY r.modality_id, (r.rank_overall IS NULL), r.rank_overall, r.bib', versionId);
}
/** Correção: gera nova versão a partir de outra com a linha alterada (histórico preservado). */
async function correct(versionId, bib, patch, userId, note) {
  const base = await db.one('SELECT * FROM result_versions WHERE id=?', versionId);
  const rows = (await versionRows(versionId)).map((r) => (r.bib === bib ? { ...r, ...patch } : r));
  return await saveVersion(base.event_id, rows, userId, note || `Correção do nº ${bib} sobre a versão ${base.version}`);
}
async function publish(versionId, status) {
  return await db.tx(async () => {
    const v = await db.one('SELECT * FROM result_versions WHERE id=?', versionId);
    await db.run("UPDATE result_versions SET status='superseded' WHERE event_id=? AND status IN ('preliminary','official') AND id<>?", v.event_id, v.id);
    await db.run('UPDATE result_versions SET status=?, published_at=? WHERE id=?', status, nowIso(), v.id);
    return v;
  });
}
async function currentPublished(eventId) { return await db.one("SELECT * FROM result_versions WHERE event_id=? AND status IN ('preliminary','official') ORDER BY version DESC LIMIT 1", eventId); }

module.exports = { preview, rank, saveVersion, versionRows, correct, publish, currentPublished, RESULT_STATUS, TEMPLATE_CSV };
