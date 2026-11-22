'use strict';
/**
 * Integrações configuradas pela administração (tela Administração › Integrações).
 *
 * - Cada integração é guardada na tabela settings com a chave "integration:<id>".
 * - Senhas, tokens e chaves secretas são criptografados (AES-256-GCM) antes de ir para o banco
 *   e nunca voltam para a tela: o formulário só mostra "configurado".
 * - Chave de criptografia: SETTINGS_ENCRYPTION_KEY, ou derivada do SESSION_SECRET.
 *   Se essa chave mudar, os segredos salvos deixam de abrir e precisam ser informados de novo.
 * - Valor salvo na tela tem prioridade; campo vazio volta a usar o valor do ambiente (.env).
 * - Depois de salvar, a configuração vale na hora (config.recompute), sem reiniciar.
 */
const crypto = require('node:crypto');
const db = require('../db');
const config = require('../config');

const KEY = crypto.createHash('sha256').update(`integrations:v1:${process.env.SETTINGS_ENCRYPTION_KEY || config.sessionSecret}`).digest();

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return { enc: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
}
function decrypt(box) {
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(box.iv, 'base64'));
    d.setAuthTag(Buffer.from(box.tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
  } catch { return null; } // chave mudou ou valor adulterado: tratado como não configurado
}

/**
 * Campos de cada integração. "target" é o caminho em config (seção.campo).
 * type: text | secret | select | checkboxes | number | email
 */
const SPEC = [
  { id: 'mercadopago', title: 'Mercado Pago', group: 'Pagamentos', help: 'Painel do desenvolvedor do Mercado Pago › Suas integrações › Credenciais. Use credenciais de teste (TEST-) para homologar. Notificações (webhook): {BASE}/webhooks/mercadopago, tópico Pagamentos.',
    fields: [
      { name: 'access_token', label: 'Access token', type: 'secret', target: 'mp.accessToken', hint: 'Começa com TEST- (testes) ou APP_USR- (produção).' },
      { name: 'webhook_secret', label: 'Chave secreta das notificações (webhook)', type: 'secret', target: 'mp.webhookSecret' },
      { name: 'collector_id', label: 'ID da conta recebedora (opcional)', type: 'text', target: 'mp.collectorId', hint: 'Confere se cada pagamento foi para a conta certa.' },
      { name: 'receiver_model', label: 'Quem recebe o dinheiro', type: 'select', target: 'mp.receiverModel', options: [['undecided', 'Ainda não decidido (bloqueia cobranças reais)'], ['platform', 'A plataforma recebe e repassa'], ['organizer', 'Cada organizador na própria conta']], hint: 'Vale também para PayPal e PicPay em produção.' },
    ] },
  { id: 'paypal', title: 'PayPal', group: 'Pagamentos', help: 'developer.paypal.com › Apps & Credentials. Webhook: {BASE}/webhooks/paypal com os eventos CHECKOUT.ORDER.APPROVED e PAYMENT.CAPTURE.*.',
    fields: [
      { name: 'client_id', label: 'Client ID', type: 'text', target: 'paypal.clientId' },
      { name: 'client_secret', label: 'Secret', type: 'secret', target: 'paypal.clientSecret' },
      { name: 'env', label: 'Ambiente', type: 'select', target: 'paypal.env', options: [['sandbox', 'Sandbox (testes)'], ['live', 'Produção']] },
      { name: 'webhook_id', label: 'ID do webhook', type: 'text', target: 'paypal.webhookId' },
      { name: 'merchant_id', label: 'Merchant ID esperado (opcional)', type: 'text', target: 'paypal.merchantId' },
    ] },
  { id: 'picpay', title: 'PicPay', group: 'Pagamentos', help: 'Painel do lojista PicPay e-commerce. Callback: {BASE}/webhooks/picpay. O PicPay não tem ambiente de testes público: credenciais configuradas cobram de verdade.',
    fields: [
      { name: 'token', label: 'x-picpay-token', type: 'secret', target: 'picpay.token' },
      { name: 'seller_token', label: 'x-seller-token', type: 'secret', target: 'picpay.sellerToken' },
    ] },
  { id: 'payment_methods', title: 'Meios oferecidos ao atleta', group: 'Pagamentos', help: 'Escolha quais meios aparecem na tela de pagamento, entre os que estiverem configurados.',
    fields: [
      { name: 'methods', label: 'Meios de pagamento', type: 'checkboxes', target: 'paymentMethods', options: [['mercadopago', 'Mercado Pago'], ['paypal', 'PayPal'], ['picpay', 'PicPay']] },
    ] },
  { id: 'mail', title: 'E-mail (servidor SMTP)', group: 'Mensagens', help: 'Use o SMTP do seu provedor (Google Workspace, Microsoft 365, Amazon SES, SendGrid, Brevo, Mailgun, Hostgator...). Sem servidor configurado, as mensagens ficam registradas, mas não são enviadas.',
    fields: [
      { name: 'smtp_host', label: 'Servidor SMTP', type: 'text', target: 'mail.smtpHost', placeholder: 'smtp.seuprovedor.com.br' },
      { name: 'smtp_port', label: 'Porta', type: 'number', target: 'mail.smtpPort', placeholder: '587' },
      { name: 'smtp_secure', label: 'Segurança', type: 'select', target: 'mail.smtpSecure', options: [['starttls', 'STARTTLS (porta 587)'], ['tls', 'SSL/TLS (porta 465)'], ['none', 'Sem criptografia (não recomendado)']] },
      { name: 'smtp_user', label: 'Usuário', type: 'text', target: 'mail.smtpUser' },
      { name: 'smtp_pass', label: 'Senha', type: 'secret', target: 'mail.smtpPass' },
      { name: 'from', label: 'Remetente', type: 'text', target: 'mail.from', placeholder: 'IaraRun <nao-responda@seudominio.com.br>', hint: 'O domínio do remetente precisa estar autorizado no provedor (SPF/DKIM) para não cair no spam.' },
    ] },
  { id: 'messaging', title: 'SMS e WhatsApp (Twilio)', group: 'Mensagens', help: 'console.twilio.com › Account Info. WhatsApp exige número aprovado pela Meta; mensagens iniciadas pela plataforma fora da janela de 24 h precisam de modelo (template) aprovado. Só recebe quem autorizou nas preferências.',
    fields: [
      { name: 'provider', label: 'Provedor', type: 'select', target: 'messaging.provider', options: [['', 'Desativado'], ['twilio', 'Twilio (SMS e WhatsApp)']] },
      { name: 'account_sid', label: 'Account SID', type: 'text', target: 'messaging.twilioSid' },
      { name: 'auth_token', label: 'Auth token', type: 'secret', target: 'messaging.twilioToken' },
      { name: 'sms_from', label: 'Número de envio de SMS', type: 'text', target: 'messaging.smsFrom', placeholder: '+5511999990000' },
      { name: 'whatsapp_from', label: 'Número do WhatsApp', type: 'text', target: 'messaging.whatsappFrom', placeholder: '+5511999990000' },
    ] },
  { id: 'google', title: 'Entrar com o Google', group: 'Acesso', help: 'Google Cloud Console › APIs e serviços › Credenciais › ID do cliente OAuth (aplicativo da Web). URI de redirecionamento autorizado: {BASE}/entrar/google/retorno.',
    fields: [
      { name: 'client_id', label: 'ID do cliente', type: 'text', target: 'google.clientId' },
      { name: 'client_secret', label: 'Chave secreta do cliente', type: 'secret', target: 'google.clientSecret' },
    ] },
  { id: 'cnpj', title: 'Consulta de CNPJ', group: 'Cadastro', help: 'Fornecedor autorizado de dados cadastrais. Use {cnpj} no endereço, por exemplo https://api.fornecedor.com/v1/cnpj/{cnpj}. Não é validação direta junto à Receita Federal.',
    fields: [
      { name: 'provider', label: 'Consulta automática', type: 'select', target: 'cnpj.provider', options: [['', 'Desativada (preenchimento manual)'], ['http', 'Ativada (fornecedor por API)']] },
      { name: 'url', label: 'Endereço da API', type: 'text', target: 'cnpj.url' },
      { name: 'token', label: 'Token', type: 'secret', target: 'cnpj.token' },
      { name: 'name', label: 'Nome do fornecedor', type: 'text', target: 'cnpj.name' },
    ] },
  { id: 'analytics', title: 'Medição (Google Analytics e Meta Pixel)', group: 'Marketing', help: 'Só é carregada para visitantes que aceitarem os cookies de medição.',
    fields: [
      { name: 'ga', label: 'ID do Google Analytics', type: 'text', target: 'analytics.ga', placeholder: 'G-XXXXXXXXXX' },
      { name: 'meta_pixel', label: 'ID do Meta Pixel', type: 'text', target: 'analytics.metaPixel' },
    ] },
];
const byId = Object.fromEntries(SPEC.map((s) => [s.id, s]));

const getPath = (obj, p) => p.split('.').reduce((o, k) => o?.[k], obj);
function setPath(obj, p, v) { const ks = p.split('.'); const last = ks.pop(); const o = ks.reduce((x, k) => x[k], obj); o[last] = v; }

/** Lê do banco os valores salvos (segredos decifrados). */
async function stored(id) {
  const row = await db.one('SELECT value FROM settings WHERE "key"=?', `integration:${id}`);
  if (!row) return {};
  const raw = JSON.parse(row.value);
  const out = {};
  for (const [k, v] of Object.entries(raw)) out[k] = v && typeof v === 'object' && v.enc ? decrypt(v) : v;
  return out;
}

/** Aplica em config: começa dos valores do ambiente e sobrepõe o que foi salvo na tela. */
async function load() {
  // 1) lê tudo do banco; 2) monta a configuração nova à parte; 3) aplica de uma vez, sem await no meio
  const all = {};
  for (const s of SPEC) { try { all[s.id] = await stored(s.id); } catch (e) { console.error(`[integrações] ${s.id} ilegível:`, e.message); all[s.id] = {}; } }
  const next = JSON.parse(JSON.stringify(config.envBaseline));
  for (const s of SPEC) {
    const vals = all[s.id];
    for (const f of s.fields) {
      if (!(f.name in vals)) continue; // não salvo na tela: vale o ambiente
      const v = vals[f.name];
      if (v === null || v === undefined) continue; // segredo ilegível
      if (v === '' && f.type !== 'select') continue; // texto vazio: vale o ambiente; select vazio = "Desativado" explícito
      setPath(next, f.target, f.type === 'number' ? Number(v) : v);
    }
  }
  for (const sec of config.INTEGRATION_SECTIONS) Object.assign(config[sec], next[sec]);
  config.paymentMethods = next.paymentMethods;
  config.recompute();
}

/**
 * Salva uma integração vinda do formulário.
 * Segredo em branco mantém o atual; marcar "remover" apaga o valor salvo.
 */
async function save(id, body) {
  const s = byId[id];
  if (!s) throw Object.assign(new Error('Integração desconhecida.'), { status: 404 });
  const row = await db.one('SELECT value FROM settings WHERE "key"=?', `integration:${id}`);
  const current = row ? JSON.parse(row.value) : {};
  const next = {};
  for (const f of s.fields) {
    if (f.type === 'secret') {
      const typed = String(body[f.name] ?? '').trim();
      if (body[`${f.name}__remover`]) continue;
      if (typed) next[f.name] = encrypt(typed);
      else if (current[f.name]) next[f.name] = current[f.name];
    } else if (f.type === 'checkboxes') {
      const allowed = f.options.map(([v]) => v);
      const picked = [].concat(body[f.name] ?? []).map(String).filter((v) => allowed.includes(v));
      next[f.name] = allowed.filter((v) => picked.includes(v)); // mantém a ordem de exibição
    } else if (f.type === 'select') {
      const v = String(body[f.name] ?? '');
      if (f.options.some(([o]) => o === v)) next[f.name] = v; // inclui '' ("Desativado"), que sobrepõe o .env
    } else if (f.type === 'number') {
      const n = Number(body[f.name]);
      if (body[f.name] !== '' && body[f.name] != null && Number.isFinite(n) && n > 0 && n < 65536) next[f.name] = n;
    } else {
      const v = String(body[f.name] ?? '').trim().slice(0, 500);
      if (v) next[f.name] = v;
    }
  }
  await db.setSetting(`integration:${id}`, next);
  await load();
  // Resumo para a auditoria: nunca inclui valores de segredos
  return Object.fromEntries(s.fields.map((f) => [f.name, f.type === 'secret' ? (next[f.name] ? 'definido' : 'vazio') : (next[f.name] ?? 'ambiente')]));
}

/** Situação de cada campo para a tela (segredos aparecem só como configurado/não). */
async function formState(id) {
  const s = byId[id]; const vals = await stored(id);
  return s.fields.map((f) => {
    const saved = vals[f.name];
    const effective = getPath(config, f.target);
    const envVal = getPath(config.envBaseline, f.target);
    if (f.type === 'secret') return { ...f, isSet: !!effective, fromEnv: !saved && !!envVal, savedSet: !!saved, unreadable: saved === null };
    return { ...f, value: saved ?? '', effective, fromEnv: (saved === undefined || saved === '') && envVal !== undefined && envVal !== '' && !(Array.isArray(envVal)) };
  });
}

module.exports = { SPEC, byId, load, save, formState, stored, encrypt, decrypt };
