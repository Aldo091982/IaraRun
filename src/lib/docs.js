'use strict';
// Validação local de CPF/CNPJ (dígitos verificadores). Não consulta órgãos externos.
const digits = (s) => String(s || '').replace(/\D/g, '');

function isCpf(v) {
  const c = digits(v);
  if (c.length !== 11 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n) => { let s = 0; for (let i = 0; i < n; i++) s += +c[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return calc(9) === +c[9] && calc(10) === +c[10];
}
function isCnpj(v) {
  const c = digits(v);
  if (c.length !== 14 || /^(\d)\1+$/.test(c)) return false;
  const calc = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; let s = 0; for (let i = 0; i < n; i++) s += +c[i] * w[i]; const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === +c[12] && calc(13) === +c[13];
}
const fmtCnpj = (v) => digits(v).replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
const fmtCpf = (v) => digits(v).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(v || '').trim());
const isPhone = (v) => { const d = digits(v); return d.length >= 10 && d.length <= 13; };
const isUrl = (v) => { try { const u = new URL(v); return ['http:', 'https:'].includes(u.protocol); } catch { return false; } };

/** Documento do organizador: CNPJ (empresa/MEI) ou CPF (pessoa física). */
const orgDoc = (o) => (o?.person_type === 'pf' ? `CPF ${fmtCpf(o.cpf || '')}` : `CNPJ ${fmtCnpj(o?.cnpj || '')}`);
module.exports = { digits, isCpf, isCnpj, fmtCnpj, fmtCpf, isEmail, isPhone, isUrl, orgDoc };
