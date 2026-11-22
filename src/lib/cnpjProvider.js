'use strict';
/**
 * Consulta cadastral de CNPJ por fornecedor autorizado.
 * Não há validação direta na Receita Federal. Sem fornecedor configurado,
 * retorna { configured:false } e o cadastro segue manual, "pendente de verificação".
 *
 * Contrato esperado do fornecedor HTTP (adapte o mapeamento em normalize()):
 *   GET {CNPJ_PROVIDER_URL com {cnpj}}  Authorization: Bearer {CNPJ_PROVIDER_TOKEN}
 */
const config = require('../config');
const { isCnpj, digits } = require('./docs');

function normalize(j) {
  return {
    legal_name: j.razao_social || j.legal_name || j.nome || '',
    trade_name: j.nome_fantasia || j.trade_name || j.fantasia || '',
    cnpj_status: j.descricao_situacao_cadastral || j.situacao || j.status || '',
    address: {
      street: j.logradouro || j.street || '', number: j.numero || j.number || '', complement: j.complemento || '',
      district: j.bairro || j.district || '', city: j.municipio || j.city || '', state: j.uf || j.state || '', zip: j.cep || j.zip || '',
    },
  };
}

async function lookup(cnpj, { fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  const c = digits(cnpj);
  if (!isCnpj(c)) return { ok: false, error: 'invalid', message: 'CNPJ inválido. Confira os 14 dígitos.' };
  if (config.cnpj.provider !== 'http' || !config.cnpj.url) return { ok: false, error: 'not_configured', configured: false, message: 'A consulta cadastral automática não está configurada. Preencha os dados manualmente; eles ficarão pendentes de verificação.' };
  try {
    const res = await fetchImpl(config.cnpj.url.replace('{cnpj}', c), {
      headers: { Accept: 'application/json', ...(config.cnpj.token ? { Authorization: `Bearer ${config.cnpj.token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 404) return { ok: false, error: 'not_found', message: 'Empresa não encontrada no fornecedor de dados cadastrais.' };
    if (!res.ok) return { ok: false, error: 'unavailable', message: 'Consulta cadastral indisponível no momento. Tente novamente ou preencha manualmente.' };
    return { ok: true, source: `provider:${config.cnpj.name}`, data: normalize(await res.json()) };
  } catch {
    return { ok: false, error: 'unavailable', message: 'Consulta cadastral indisponível no momento. Tente novamente ou preencha manualmente.' };
  }
}
module.exports = { lookup, normalize };
