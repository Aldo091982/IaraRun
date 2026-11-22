'use strict';
const crypto = require('node:crypto');

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
/** Template tag que escapa interpolações; use raw() para HTML confiável. */
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(String(s ?? ''));
function html(strings, ...vals) {
  let out = '';
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) out += render(vals[i]);
  });
  return raw(out);
}
function render(v) {
  if (v == null || v === false) return '';
  if (Array.isArray(v)) return v.map(render).join('');
  if (v instanceof Raw) return v.s;
  return esc(v);
}

const brl = (cents) => (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const toCents = (v) => {
  if (v == null || v === '') return 0;
  const s = String(v).trim().replace(/[R$\s]/g, '');
  const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : Number(s);
  if (!Number.isFinite(n) || n < 0) throw new UserError('Valor monetário inválido: ' + v);
  return Math.round(n * 100);
};
const centsToInput = (c) => (Number(c || 0) / 100).toFixed(2).replace('.', ',');

function tzOffsetMs(date, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(date).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}
/** Converte 'YYYY-MM-DDTHH:mm' no fuso informado para ISO UTC. */
function zonedToUtc(local, tz = 'America/Sao_Paulo') {
  if (!local) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let ts = guess - tzOffsetMs(new Date(guess), tz);
  ts = guess - tzOffsetMs(new Date(ts), tz);
  return new Date(ts).toISOString();
}
/** ISO UTC -> 'YYYY-MM-DDTHH:mm' no fuso (para inputs datetime-local). */
function utcToZonedInput(iso, tz = 'America/Sao_Paulo') {
  if (!iso) return '';
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
const fmtDateTime = (iso, tz = 'America/Sao_Paulo') => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso)) : '—';
const fmtDate = (iso, tz = 'America/Sao_Paulo') => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'long' }).format(new Date(iso)) : '—';
const fmtDateShort = (iso, tz = 'America/Sao_Paulo') => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, dateStyle: 'short' }).format(new Date(iso)) : '—';
const fmtTime = (iso, tz = 'America/Sao_Paulo') => iso ? new Intl.DateTimeFormat('pt-BR', { timeZone: tz, timeStyle: 'short' }).format(new Date(iso)) : '—';
const tzLabel = (tz) => ({ 'America/Sao_Paulo': 'Brasília', 'America/Manaus': 'Manaus', 'America/Cuiaba': 'Cuiabá', 'America/Rio_Branco': 'Rio Branco', 'America/Noronha': 'Fernando de Noronha', 'America/Belem': 'Belém', 'America/Fortaleza': 'Fortaleza', 'America/Recife': 'Recife', 'America/Bahia': 'Salvador', 'America/Porto_Velho': 'Porto Velho', 'America/Boa_Vista': 'Boa Vista', 'America/Campo_Grande': 'Campo Grande' }[tz] || tz);
const TIMEZONES = ['America/Sao_Paulo', 'America/Bahia', 'America/Fortaleza', 'America/Recife', 'America/Belem', 'America/Manaus', 'America/Cuiaba', 'America/Campo_Grande', 'America/Porto_Velho', 'America/Boa_Vista', 'America/Rio_Branco', 'America/Noronha'];
const UF = ['AC', 'AL', 'AP', 'AM', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MT', 'MS', 'MG', 'PA', 'PB', 'PR', 'PE', 'PI', 'RJ', 'RN', 'RS', 'RO', 'RR', 'SC', 'SP', 'SE', 'TO'];

function ageAt(birth, atIso) {
  if (!birth) return null;
  const b = new Date(birth + 'T12:00:00Z'), a = atIso ? new Date(atIso) : new Date();
  let age = a.getUTCFullYear() - b.getUTCFullYear();
  if (a.getUTCMonth() < b.getUTCMonth() || (a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() < b.getUTCDate())) age--;
  return age;
}
const fmtDuration = (s) => {
  if (s == null) return '—';
  s = Math.round(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}`;
};
const fmtPace = (s) => (s == null ? '—' : `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}/km`);
function parseDuration(str) {
  if (str == null) return null;
  const t = String(str).trim();
  if (!t) return null;
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/.exec(t);
  if (!m) return NaN;
  const h = Number(m[1] || 0), mi = Number(m[2]), s = Number(m[3]);
  if (mi > 59 || s > 59) return NaN;
  return h * 3600 + mi * 60 + s;
}

const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'evento';
const randomToken = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
const code = (prefix = 'P') => prefix + crypto.randomBytes(5).toString('hex').toUpperCase();
const nowIso = () => new Date().toISOString();
const addMinutes = (min, from = new Date()) => new Date(from.getTime() + min * 60000).toISOString();
/** Equivalentes assíncronos de some/every/filter (avaliação em sequência). */
async function someAsync(arr, fn) { for (const [i, x] of arr.entries()) if (await fn(x, i)) return true; return false; }
async function everyAsync(arr, fn) { for (const [i, x] of arr.entries()) if (!(await fn(x, i))) return false; return true; }
async function filterAsync(arr, fn) { const out = []; for (const [i, x] of arr.entries()) if (await fn(x, i)) out.push(x); return out; }
const json = (s, fb = {}) => { try { return s ? JSON.parse(s) : fb; } catch { return fb; } };
const maskCpf = (c) => (c ? `***.${String(c).replace(/\D/g, '').slice(3, 6)}.***-**` : '—');
const maskEmail = (e) => (e ? e.replace(/^(.).*(@.*)$/, '$1***$2') : '—');

class UserError extends Error { constructor(msg, status = 400, fields) { super(msg); this.status = status; this.fields = fields; this.expose = true; } }
class Forbidden extends UserError { constructor(msg = 'Acesso não autorizado.') { super(msg, 403); } }
class NotFound extends UserError { constructor(msg = 'Não encontrado.') { super(msg, 404); } }

function toCsv(rows, headers) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmulas em planilhas
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '﻿' + [headers.map((h) => cell(h.label)).join(';'), ...rows.map((r) => headers.map((h) => cell(typeof h.value === 'function' ? h.value(r) : r[h.key])).join(';'))].join('\r\n');
}
function parseCsv(text) {
  text = String(text).replace(/^﻿/, '');
  const firstLine = text.split(/\r?\n/)[0] || '';
  const delim = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; continue; }
    if (c === '"') q = true; else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
    else cur += c;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

module.exports = { someAsync, everyAsync, filterAsync, esc, html, raw, Raw, brl, toCents, centsToInput, zonedToUtc, utcToZonedInput, fmtDateTime, fmtDate, fmtDateShort, fmtTime, tzLabel, TIMEZONES, UF, ageAt, fmtDuration, fmtPace, parseDuration, slugify, randomToken, code, nowIso, addMinutes, json, maskCpf, maskEmail, UserError, Forbidden, NotFound, toCsv, parseCsv };
