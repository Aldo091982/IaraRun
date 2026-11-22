'use strict';
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const envFile = process.env.ENV_FILE || path.join(root, '.env');
if (fs.existsSync(envFile) && !process.env.SKIP_ENV_FILE) process.loadEnvFile(envFile);

const env = process.env.APP_ENV || 'development'; // development | test | production
const config = {
  root,
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: Number(process.env.PORT || 3000),
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  dbFile: process.env.DB_FILE || path.join(root, 'storage', `${env}.sqlite`),
  privateDir: process.env.PRIVATE_STORAGE_DIR || path.join(root, 'storage', 'private', env),
  publicUploadDir: process.env.PUBLIC_UPLOAD_DIR || path.join(root, 'storage', 'public', env),
  sessionSecret: process.env.SESSION_SECRET || (env === 'production' ? null : 'dev-only-secret-change-me'),
  cnpj: {
    provider: process.env.CNPJ_PROVIDER || '', // '' (manual) | 'http'
    url: process.env.CNPJ_PROVIDER_URL || '', // ex.: https://fornecedor/v1/cnpj/{cnpj}
    token: process.env.CNPJ_PROVIDER_TOKEN || '',
    name: process.env.CNPJ_PROVIDER_NAME || 'Fornecedor configurado',
  },
  mp: {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
    webhookSecret: process.env.MP_WEBHOOK_SECRET || '',
    clientId: process.env.MP_CLIENT_ID || '',
    clientSecret: process.env.MP_CLIENT_SECRET || '',
    // Decisão de negócio pendente: 'undecided' | 'platform' | 'organizer'
    receiverModel: process.env.PAYMENT_RECEIVER_MODEL || 'undecided',
  },
  paypal: {
    clientId: process.env.PAYPAL_CLIENT_ID || '',
    clientSecret: process.env.PAYPAL_CLIENT_SECRET || '',
    webhookId: process.env.PAYPAL_WEBHOOK_ID || '',
    env: process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox',
    merchantId: process.env.PAYPAL_MERCHANT_ID || '',
  },
  picpay: {
    token: process.env.PICPAY_TOKEN || '',
    sellerToken: process.env.PICPAY_SELLER_TOKEN || '',
  },
  // Meios oferecidos ao atleta, na ordem de exibição
  paymentMethods: (process.env.PAYMENT_METHODS || 'mercadopago,paypal,picpay').split(',').map((s) => s.trim()).filter(Boolean),
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
  },
  mail: { from: process.env.MAIL_FROM || 'Plataforma <nao-responda@exemplo.com>' },
  analytics: { ga: process.env.GA_MEASUREMENT_ID || '', metaPixel: process.env.META_PIXEL_ID || '' },
};
if (!config.sessionSecret) throw new Error('SESSION_SECRET é obrigatório em produção');

// Modo efetivo de pagamento:
//  simulator          -> sem credenciais, fora de produção (DEMONSTRAÇÃO)
//  mp_test            -> credencial TEST- do Mercado Pago (sandbox)
//  mp_live            -> credencial de produção + modelo de recebimento decidido
//  blocked_undecided  -> credencial de produção, mas modelo de recebimento não decidido
//  disabled           -> produção sem credencial: eventos pagos não vendem
config.mp.mode = config.mp.accessToken
  ? (config.mp.accessToken.startsWith('TEST-') ? 'mp_test' : 'mp_live')
  : 'simulator';
if (config.isProd && config.mp.mode === 'simulator') config.mp.mode = 'disabled';
if (config.mp.mode === 'mp_live' && config.mp.receiverModel === 'undecided') config.mp.mode = 'blocked_undecided';
// Modo de cada meio adicional: simulator | test | live | blocked_undecided | disabled
function extraMode(hasCreds, isTest) {
  if (!hasCreds) return config.isProd ? 'disabled' : 'simulator';
  if (isTest) return 'test';
  return config.mp.receiverModel === 'undecided' ? 'blocked_undecided' : 'live';
}
config.paypal.mode = extraMode(!!(config.paypal.clientId && config.paypal.clientSecret), config.paypal.env === 'sandbox');
// PicPay não tem ambiente de testes público: credencial configurada é sempre produção
config.picpay.mode = extraMode(!!config.picpay.token, false);
// Login com Google: real com credenciais; simulador local fora de produção; desativado em produção sem credenciais
config.google.mode = config.google.clientId && config.google.clientSecret ? 'live' : (config.isProd ? 'disabled' : 'simulator');
config.mp.canCharge = ['simulator', 'mp_test', 'mp_live'].includes(config.mp.mode)
  || ['paypal', 'picpay'].some((k) => config.paymentMethods.includes(k) && ['simulator', 'test', 'live'].includes(config[k].mode));

module.exports = config;
