# Largada — plataforma de eventos esportivos

Divulgação e gestão de eventos esportivos: cadastro autônomo do organizador, criação guiada de eventos, inscrições com lotes, vagas e estoque, pagamentos via Mercado Pago, entrega de kits por QR Code e resultados. Há áreas para atletas, organizadores, colaboradores e administração.

> O nome "Largada" e a identidade visual são próprios e provisórios. Para trocar o nome, use `APP_NAME`.

## Arquitetura

| Decisão | Motivo |
|---|---|
| Node.js 22 + Express 5, HTML renderizado no servidor | Sem etapa de build. Funciona em celulares simples e sem JavaScript, que só acrescenta melhorias. |
| PostgreSQL (driver `pg`) com migrações versionadas e transacionais (`src/db.js`) | As escritas críticas (vagas, estoque, pagamentos) rodam em transação com trava consultiva (`pg_advisory_xact_lock`), o que impede venda acima da capacidade mesmo com várias instâncias do app. Em desenvolvimento, um PostgreSQL local sobe sozinho (`scripts/pg-local.js`), sem instalar nada. |
| Regras de negócio em `src/lib/*` e rotas finas em `src/routes/*` | Os testes exercitam as mesmas funções que as telas. |
| Provedores de pagamento atrás de uma interface (`src/lib/payments.js`): Mercado Pago, PayPal e PicPay | O simulador local e os provedores reais passam pelo mesmo pipeline: webhook assinado → consulta do pagamento → validação de valor, moeda, pedido e beneficiário → confirmação idempotente. |

Estrutura: `src/app.js` (middlewares: sessão, CSRF, perfil em uso), `src/routes/` (auth, public, onboarding, organizer, eventWizard, operations, checkout, athlete, admin, api, webhooks, dev), `src/lib/` (domínio), `src/views/layout.js` (componentes acessíveis), `public/` (CSS/JS), `scripts/` (migração e dados de demonstração), `test/` (testes de ponta a ponta), `templates/` (modelo de importação de resultados).

## Executar

Requisitos: Node.js 22.13 ou superior. Em desenvolvimento, nada mais: sem `DATABASE_URL`, o app baixa (no `npm install`) e sobe sozinho um PostgreSQL 17 local, na porta 54329, com dados em `storage/pg/`. Para usar um PostgreSQL próprio, defina `DATABASE_URL`.

Comandos do banco local: `npm run db:start`, `npm run db:stop` e `npm run db:status`.

```bash
npm install
cp .env.example .env        # ajuste se quiser; sem .env roda em desenvolvimento com simulador
npm run migrate             # cria/atualiza o banco do ambiente (plataforma_development)
npm run seed                # dados FICTÍCIOS de demonstração (bloqueado em produção)
npm start                   # http://localhost:3000
npm test                    # 47 testes de ponta a ponta, cada arquivo em um banco PostgreSQL temporário
```

Contas de demonstração (senha `demo12345`, somente fora de produção):

| Conta | Uso |
|---|---|
| `admin@demo.invalid` | Administração. Selecione o perfil "Administração" no menu. |
| `organizador@demo.invalid` | Responsável pela organizadora [DEMO], já ativa e com recebimento de testes. |
| `operador@demo.invalid` | Colaborador com permissão apenas de entrega de kits. |
| `atleta@demo.invalid` | Atleta com resultado oficial e certificado no evento passado. |

Fora de produção:
- Os e-mails ficam em `/dev/caixa-de-saida`, incluindo os links de confirmação e de recuperação de senha.
- "Continuar com o Google" abre um simulador local (sem credenciais do Google), onde você digita o e-mail da conta.
- O pagamento abre `/dev/pagamento-simulado/<pedido>`, com aprovar Pix/cartão, recusar, deixar pendente, valor divergente e reenvio de webhook duplicado. Uma faixa no topo de cada página identifica o ambiente e o modo de pagamento.

## Integrações pela tela

Em **Administração › Integrações** configuram-se Mercado Pago, PayPal, PicPay, meios de pagamento oferecidos, e-mail (SMTP), SMS/WhatsApp (Twilio), login com Google, consulta de CNPJ e medição. Senhas e chaves ficam criptografadas no banco (AES-256-GCM), nunca voltam para a tela e as mudanças valem na hora. E-mail e SMS/WhatsApp têm botão de teste. **Administração › Mensagens** mostra a situação de cada envio (sem o conteúdo). O arquivo `.env` continua valendo como padrão quando o campo da tela está vazio.

## Ambientes

`APP_ENV` = `development` | `test` | `production`. Cada ambiente tem seu próprio banco e sua própria pasta de arquivos.

| Modo de pagamento (calculado) | Quando |
|---|---|
| `simulator` | Sem `MP_ACCESS_TOKEN` e fora de produção. É DEMONSTRAÇÃO e não cobra nada. |
| `mp_test` | Credencial `TEST-…` (sandbox do Mercado Pago). |
| `mp_live` | Credencial de produção e `PAYMENT_RECEIVER_MODEL` decidido. |
| `blocked_undecided` | Credencial de produção, mas modelo de recebimento não decidido: nenhuma cobrança. |
| `disabled` | Produção sem credencial. Eventos gratuitos funcionam normalmente. |

O simulador e as rotas `/dev/*` não são montados em produção.

## Implantação (produção)

1. Defina `APP_ENV=production`, `SESSION_SECRET` (aleatório e longo), `BASE_URL` com HTTPS e `DATABASE_URL` do PostgreSQL (versão 13 ou superior, com a extensão `citext`, disponível nos serviços gerenciados comuns; crie o banco antes). Use `DATABASE_SSL=1` se o provedor exigir SSL. Os cookies ficam `Secure` e o `trust proxy` fica ativo.
2. Coloque o app atrás de um proxy HTTPS (Nginx, Caddy ou o balanceador da nuvem). Use processo supervisionado (systemd/PM2). Pode rodar mais de uma instância: o controle de vagas vale entre instâncias.
3. Faça backup do PostgreSQL (o serviço gerenciado costuma oferecer) e mantenha os arquivos privados em disco persistente com backup. `PRIVATE_STORAGE_DIR` deve ficar fora de qualquer pasta servida e ter backup criptografado.
4. Pagamentos (defina `PAYMENT_RECEIVER_MODEL` e escolha os meios em `PAYMENT_METHODS`):
   - Mercado Pago: credenciais de produção, `MP_WEBHOOK_SECRET` e notificação em `https://SEU_DOMINIO/webhooks/mercadopago` (tópico *Pagamentos*).
   - PayPal: `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=live` e um webhook em `https://SEU_DOMINIO/webhooks/paypal` com os eventos `CHECKOUT.ORDER.APPROVED` e `PAYMENT.CAPTURE.*`; copie o ID dele para `PAYPAL_WEBHOOK_ID`.
   - PicPay: `PICPAY_TOKEN` e `PICPAY_SELLER_TOKEN`. O callback é `https://SEU_DOMINIO/webhooks/picpay`.
5. Rode `npm run migrate` a cada versão, antes de `npm start`.
6. Login com Google: crie um ID do cliente OAuth (aplicativo da Web) no Google Cloud, autorize `https://SEU_DOMINIO/entrar/google/retorno` e preencha `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET`. Sem elas, em produção o botão do Google não aparece.
7. Pendências externas antes de abrir ao público: ver `docs/PLANO.md` › "Configurações externas pendentes".

Documentação: [docs/PLANO.md](docs/PLANO.md) traz o plano e a situação de cada requisito. [docs/VALIDACAO.md](docs/VALIDACAO.md) traz o relatório de testes.
