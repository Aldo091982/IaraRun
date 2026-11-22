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
  // Interface de rede: 127.0.0.1 quando há proxy ou túnel na frente (padrão: todas)
  host: process.env.HOST || '0.0.0.0',
  baseUrl: (process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  db: {
    // postgres://usuario:senha@host:5432/banco — padrão: PostgreSQL local de desenvolvimento (npm run db:start)
    url: process.env.DATABASE_URL || `postgres://postgres:postgres@127.0.0.1:54329/plataforma_${env}`,
    ssl: process.env.DATABASE_SSL === '1',
    // Cria o banco se não existir (padrão fora de produção; em produção o banco é criado antes)
    createDatabase: process.env.DB_CREATE ? process.env.DB_CREATE === '1' : env !== 'production',
    poolSize: Number(process.env.DB_POOL_SIZE || 10),
  },
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
    collectorId: process.env.MP_COLLECTOR_ID || '',
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
  mail: {
    from: process.env.MAIL_FROM || 'Plataforma <nao-responda@exemplo.com>',
    // Servidor SMTP (vazio = mensagens ficam só na caixa de saída)
    smtpHost: process.env.SMTP_HOST || '',
    smtpPort: Number(process.env.SMTP_PORT || 587),
    smtpSecure: process.env.SMTP_SECURE || 'starttls', // starttls | tls | none
    smtpUser: process.env.SMTP_USER || '',
    smtpPass: process.env.SMTP_PASS || '',
  },
  // SMS e WhatsApp (Twilio)
  messaging: {
    provider: process.env.MESSAGING_PROVIDER || '', // '' | 'twilio'
    twilioSid: process.env.TWILIO_ACCOUNT_SID || '',
    twilioToken: process.env.TWILIO_AUTH_TOKEN || '',
    smsFrom: process.env.TWILIO_SMS_FROM || '',
    whatsappFrom: process.env.TWILIO_WHATSAPP_FROM || '',
  },
  analytics: { ga: process.env.GA_MEASUREMENT_ID || '', metaPixel: process.env.META_PIXEL_ID || '' },
};
if (!config.sessionSecret) throw new Error('SESSION_SECRET é obrigatório em produção');
if (config.isProd && !process.env.DATABASE_URL) throw new Error('DATABASE_URL é obrigatório em produção');

// Valores vindos do ambiente (.env). As integrações salvas pela administração têm prioridade
// sobre eles; um campo deixado vazio na tela volta a usar o valor do ambiente.
const INTEGRATION_SECTIONS = ['mp', 'paypal', 'picpay', 'google', 'cnpj', 'mail', 'messaging', 'analytics'];
config.envBaseline = JSON.parse(JSON.stringify(Object.fromEntries(INTEGRATION_SECTIONS.map((k) => [k, config[k]]).concat([['paymentMethods', config.paymentMethods]]))));

/**
 * Calcula os modos efetivos a partir das credenciais atuais. Chamado na inicialização
 * e sempre que a administração salva uma integração.
 *
 * Mercado Pago:
 *  simulator          -> sem credenciais, fora de produção (DEMONSTRAÇÃO)
 *  mp_test            -> credencial TEST- do Mercado Pago (sandbox)
 *  mp_live            -> credencial de produção + modelo de recebimento decidido
 *  blocked_undecided  -> credencial de produção, mas modelo de recebimento não decidido
 *  disabled           -> produção sem credencial: eventos pagos não vendem
 */
function recompute() {
  config.mp.mode = config.mp.accessToken
    ? (config.mp.accessToken.startsWith('TEST-') ? 'mp_test' : 'mp_live')
    : 'simulator';
  if (config.isProd && config.mp.mode === 'simulator') config.mp.mode = 'disabled';
  if (config.mp.mode === 'mp_live' && config.mp.receiverModel === 'undecided') config.mp.mode = 'blocked_undecided';
  // Modo de cada meio adicional: simulator | test | live | blocked_undecided | disabled
  const extraMode = (hasCreds, isTest) => {
    if (!hasCreds) return config.isProd ? 'disabled' : 'simulator';
    if (isTest) return 'test';
    return config.mp.receiverModel === 'undecided' ? 'blocked_undecided' : 'live';
  };
  config.paypal.mode = extraMode(!!(config.paypal.clientId && config.paypal.clientSecret), config.paypal.env !== 'live');
  // PicPay não tem ambiente de testes público: credencial configurada é sempre produção
  config.picpay.mode = extraMode(!!config.picpay.token, false);
  // Login com Google: real com credenciais; simulador local fora de produção; desativado em produção sem credenciais
  config.google.mode = config.google.clientId && config.google.clientSecret ? 'live' : (config.isProd ? 'disabled' : 'simulator');
  config.mail.mode = config.mail.smtpHost ? 'smtp' : 'local';
  config.messaging.mode = config.messaging.provider === 'twilio' && config.messaging.twilioSid && config.messaging.twilioToken ? 'twilio' : 'off';
  config.mp.canCharge = ['simulator', 'mp_test', 'mp_live'].includes(config.mp.mode)
    || ['paypal', 'picpay'].some((k) => config.paymentMethods.includes(k) && ['simulator', 'test', 'live'].includes(config[k].mode));
}
config.recompute = recompute;
config.INTEGRATION_SECTIONS = INTEGRATION_SECTIONS;
recompute();

module.exports = config;
