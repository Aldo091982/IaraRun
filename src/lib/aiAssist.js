'use strict';
/**
 * Assistente de conteúdo do evento (item 21.8) — versão inicial EXTRATIVA.
 * Seleciona trechos do próprio regulamento por palavras-chave; não gera texto novo,
 * portanto não inventa regras, datas ou benefícios. Informações ausentes são sinalizadas.
 * Integração com modelo de linguagem: etapa seguinte (deve manter a mesma regra:
 * usar apenas o conteúdo fornecido e retornar campos ausentes).
 */
const TOPICS = {
  description: ['evento', 'prova', 'corrida', 'objetivo', 'realiza', 'organiza'],
  route_info: ['percurso', 'trajeto', 'largada', 'chegada', 'altimetria', 'hidrata'],
  kit_pickup_info: ['retirada', 'kit', 'entrega'],
  schedule: ['programação', 'horário', 'cronograma', 'concentração'],
  awards: ['premiação', 'premio', 'prêmio', 'troféu', 'medalha'],
};
const LABELS = { description: 'descrição geral', route_info: 'percurso', kit_pickup_info: 'retirada de kits', schedule: 'programação', awards: 'premiação' };

async function suggestFromRegulation(text) {
  const paras = String(text || '').split(/\n\s*\n|\r\n\r\n|(?<=\.)\s*\n/).map((p) => p.trim()).filter((p) => p.length > 15);
  const out = { source: 'extract', missing: [] };
  for (const [k, words] of Object.entries(TOPICS)) {
    const hits = paras.filter((p) => words.some((w) => p.toLowerCase().includes(w)));
    out[k] = hits.slice(0, 3).join('\n\n');
    if (!out[k]) out.missing.push(LABELS[k]);
  }
  return out;
}
module.exports = { suggestFromRegulation };
