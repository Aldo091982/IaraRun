# Plano e situação dos requisitos

Legenda: ✅ entregue na v1 · 🟡 parcial (o que falta está descrito) · ⏭ próxima etapa · ⛔ depende de contrato ou decisão externa

## Ordem executada (item 18)

| # | Etapa da primeira versão | Situação |
|---|---|---|
| 1 | Autenticação, perfis, isolamento e permissões | ✅ |
| 2 | Página de organizadores e cadastro autônomo com retomada | ✅ |
| 3 | Painel inicial, checklist e criação guiada de eventos | ✅ |
| 4 | Catálogo e páginas públicas | ✅ |
| 5 | Inscrições com lotes, vagas, estoque e kits | ✅ |
| 6 | Mercado Pago em ambiente de testes | 🟡 Código da integração real pronto (Checkout Pro, webhooks assinados, consulta e reembolso). Foi validado ponta a ponta apenas com o simulador local, pois não havia credenciais `TEST-` disponíveis. Falta rodar no sandbox real. |
| 6b | PayPal e PicPay como meios adicionais | 🟡 Código pronto (PayPal Orders v2 com captura, webhook verificado pelo PayPal e reembolso parcial; PicPay e-commerce com callback autenticado e reembolso só total). Validado com simulador local e respostas simuladas das APIs. Falta rodar com credenciais reais. |
| 7 | Painéis do atleta e do organizador e financeiro básico | ✅ |
| 8 | Entrega de kits por QR Code | ✅ |
| 9 | Importação, revisão e publicação de resultados | ✅ |

## Decisões de negócio pendentes (bloqueiam transações reais)

1. **Modelo de recebimento** (`PAYMENT_RECEIVER_MODEL`): a plataforma recebe e repassa, ou cada organizador recebe na própria conta Mercado Pago (OAuth). Enquanto estiver indefinido, credenciais de produção ficam bloqueadas (`blocked_undecided`).
2. **Condições comerciais**: taxa de serviço, taxa para eventos gratuitos e planos para múltiplos eventos. A plataforma vem sem valores (taxa padrão 0%), que a administração configura em Parâmetros.
3. **Textos legais**: Termos de Uso, Política de Privacidade e Termos do Organizador são modelos e precisam de revisão jurídica. As versões estão em `src/lib/core.js` (`LEGAL`).

## Configurações externas pendentes

- Credenciais Mercado Pago (teste e produção), `MP_WEBHOOK_SECRET`, `MP_COLLECTOR_ID`.
- Google: ID do cliente OAuth (`GOOGLE_CLIENT_ID`/`SECRET`) e tela de consentimento publicada no Google Cloud.
- PayPal: conta empresarial, app REST (`PAYPAL_CLIENT_ID`/`SECRET`, sandbox e produção) e webhook cadastrado (`PAYPAL_WEBHOOK_ID`).
- PicPay: contrato de lojista e-commerce (`PICPAY_TOKEN`, `PICPAY_SELLER_TOKEN`). Confirmar com o PicPay se a conta usa esta API ou a versão mais nova do checkout. Para o modelo "organizador": app OAuth (`MP_CLIENT_ID`/`SECRET`) e implementação da troca de código.
- Fornecedor autorizado de consulta de CNPJ (`CNPJ_PROVIDER_*`). Adapte o mapeamento em `cnpjProvider.normalize()`.
- Provedor de e-mail transacional (SMTP/API). Hoje as mensagens vão para a tabela `outbox`. O envio real exige um *worker* lendo a `outbox`.
- Domínio com HTTPS, backups e armazenamento privado com criptografia.

## Situação por seção

### 2. Perfis e permissões
- ✅ Atleta, organizador (responsável), colaborador com funções (eventos, inscritos/atendimento, financeiro, kits/check-in, cronometragem, comunicação) restritas por evento, e administrador.
- ✅ Isolamento nas rotas, consultas (`eventForOrg`), exportações, arquivos (documentos fora da pasta pública, servidos só à administração) e API (chave por organização).
- ✅ Uma conta com vários perfis. A troca de perfil fica no menu.
- ✅ Auditoria (`audit_log`) de login, cadastro, decisões, exportações, consulta de documentos, publicação, reembolsos, kits, resultados e API.

### 3. Portal público
- ✅ Busca e filtros: data, cidade, estado, modalidade, distância e eventos passados.
- ✅ Página do evento: capa, descrição, organizador, data/hora/fuso, endereço, percurso, regulamento, lotes, kits, retirada e contatos.
- ✅ Situações: rascunho privado, abertas, em breve, encerradas, esgotado, cancelado e concluído.
- ✅ Compartilhar (Web Share, cópia do link, WhatsApp), favoritar, `.ics` por evento e agenda pessoal `.ics` com alarme de 1 dia.
- 🟡 Alertas de abertura de inscrições e de mudança de lote: as preferências existem, mas falta o agendador que dispara os avisos (⏭).

### 4–5. Página de organizadores e cadastro autônomo
- ✅ Benefícios, funcionalidades, etapas, requisitos, diferença entre conta, verificação e recebimento, e condições configuráveis.
- ✅ Assistente em 4 etapas: progresso, etapa atual, Voltar/Avançar/Salvar e continuar depois, rascunho salvo no servidor e bloqueio de pulo de etapas.
- ✅ CNPJ com validação dos dígitos verificadores e botão Buscar. Trata inválido, não encontrado, indisponível e já cadastrado. Sem fornecedor, o cadastro é manual e identificado como pendente.
- ✅ Empresa já cadastrada: em vez de vincular, gera solicitação de acesso, com aviso ao responsável e decisão do responsável ou da administração.
- ✅ Logomarca com prévia e orientação. Documento do responsável e comprovante de vínculo, com tipo validado pela assinatura do arquivo e tamanho limitado. Ficam em armazenamento privado e cada consulta é registrada. A interface distingue "Enviado" de "Verificado".
- ✅ Contatos, dados públicos e internos, aceites versionados (usuário, versão e data) e marketing separado e opcional.
- ✅ Situações: cadastro em andamento, e-mail pendente, verificação pendente, ativo, correção solicitada e suspenso.

### 6. Primeiro acesso e evento guiado
- ✅ Checklist de 8 tarefas com progresso e links.
- ✅ Assistente de 9 etapas com rascunho retomável e lista de pendências com links de correção.
- ✅ Evento pago exige recebimento configurado. Evento gratuito dispensa. Os requisitos de ativação são configuráveis.

### 7. Atleta
- ✅ Cadastro, login, recuperação de acesso, perfil, menor com responsável, painel, comprovante, QR, solicitações, histórico, certificados e preferências.
- ✅ Só validação local de CPF. Não há verificação documental externa.

### 8. Inscrições e vagas
- ✅ Modalidade, kit, camiseta, participantes (até 10 por pedido), revisão e aceite do regulamento com versão e data.
- ✅ Limites por evento, modalidade e lote. Virada de lote por período ou quantidade. Reserva temporária com expiração configurável, em transação serializada.
- ✅ Cupons (percentual ou valor, limite de usos, mínimo de inscrições para grupo).
- ✅ Duplicidade por CPF configurável. Troca de modalidade e camiseta (grátis ou paga), transferência e cancelamento sob aprovação, todos respeitando o prazo.
- ✅ Confirmação só após validação no servidor. Fluxo próprio para eventos gratuitos.
- 🟡 Inscrição em equipe: nome de equipe por participante e cupom de grupo. O cadastro estruturado de equipes e assessorias fica para depois (⏭).
- ⏭ Fila virtual. Ela não promete vaga.

### 9. Mercado Pago
- ✅ Checkout Pro com `external_reference` = código do pedido, `X-Idempotency-Key`, expiração igual à da reserva e boleto excluído.
- ✅ Webhook com validação HMAC do `x-signature` (manifesto `id;request-id;ts`), deduplicação, consulta do pagamento no provedor, verificação de valor, moeda e beneficiário, tolerância a ordem invertida e tratamento de recusado, pendente, aprovado e reembolsado.
- ✅ Pagamento tardio: confirma se houver vaga, senão abre exceção para o organizador reembolsar ou confirmar acima do limite.
- ✅ Reembolso total ou parcial com permissão financeira. Conciliação. Registros de webhook sem dados pessoais. Credenciais só em variáveis de ambiente.
- ⏭ Conexão OAuth da conta do organizador, que depende da decisão sobre o modelo de recebimento. Parcelamento, repasse e split não são prometidos.

### 10–11. Painel do organizador e financeiro
- ✅ Criar, editar, publicar, encerrar, reabrir, concluir, cancelar (com aviso aos inscritos) e duplicar sem dados de venda.
- ✅ Inscritos com filtros e CSV (inclui respostas do questionário; CPF mascarado na tela; exportação auditada). Solicitações. Indicadores com horário de cálculo.
- ✅ Equipe, comunicação, kits, resultados, suporte e orientações curtas nas telas.
- ✅ Por evento: bruto, descontos, taxas, reembolsos e líquido, com previsto e confirmado separados. Conciliação e CSV. Taxa configurável e escolha de quem paga.
- 🟡 Relatórios por período e por situação do pagamento: hoje só por evento e na conciliação. Valor "disponível no provedor" e repasses dependem do modelo de recebimento (⛔).
- ⏭ Planos para múltiplos eventos.

### 12. Kits
- ✅ Estoque por tamanho ligado às reservas. QR com token aleatório, sem dados pessoais. Busca por QR, nº, nome ou CPF. Registro de operador, ponto e horário. Duplicidade bloqueada por restrição única. Retirada por terceiro. Tela pensada para celular. Check-in de presença separado da entrega.
- Não há promessa de funcionamento offline.

### 13. Resultados
- ✅ CSV com modelo e prévia com relatório de erros antes de salvar. Vínculo com inscrição, número, modalidade e categoria. Tempos bruto e líquido, ritmo. DNS, DNF e DSQ. Classificação geral, por sexo e por categoria com critério e desempate configuráveis. Versões preliminar e oficial com histórico e correção que gera nova versão. Revisão pelo atleta com prazo e resposta.
- 🟡 Elegibilidade por regulamento: categorias por idade e sexo. Regras mais específicas ficam para depois (⏭).
- ⏭ Integração de cronometragem por API (o caminho está descrito em `/api/docs`).

### 14. Histórico e certificados (adiantado da etapa seguinte)
- ✅ Histórico oficial, recordes por distância, gráfico de evolução do ritmo, certificado de conclusão ou participação, registros pessoais identificados como não oficiais e controle de exibição pública.
- ⏭ Medalhas e conquistas.

### 15–16. Equipes e comunicação
- 🟡 Ver item 8. ⏭ Cadastro de assessorias, vínculo de atletas e acompanhamento.
- ✅ E-mail (caixa de saída) para confirmação, pendência, kit, alteração, cancelamento e resultados. Preferências por categoria. Marketing só com consentimento.
- ✅ Google Analytics carregado só com consentimento. ⏭ Meta Pixel, WhatsApp oficial e campanhas segmentadas (nenhuma campanha real é enviada).

### 17. Administração e qualidade
- ✅ Usuários, organizadores (análise de documentos e decisão registrada), eventos, exceções, suporte, parâmetros, integrações e auditoria.
- ✅ pt-BR, R$, datas brasileiras, fuso por evento, navegação por teclado, foco visível, rótulos e erros junto aos campos, tema claro e escuro, layout responsivo e estados de vazio, pendência e erro.
- ✅ Proteção contra CSRF, senhas com scrypt, limite de tentativas de login, cabeçalhos de segurança, mitigação de injeção de fórmulas em CSV e dados demo identificados.
- 🟡 Ainda não houve auditoria de acessibilidade com ferramentas (axe ou leitor de tela).

### 21. Complementos
| Item | Situação |
|---|---|
| 21.1 Questionário | ✅ Texto, seleção e confirmação. Obrigatoriedade por modalidade, finalidade exibida, versão preservada e exportação restrita. |
| 21.2 Produtos extras | ✅ No carrinho e depois da inscrição, com estoque concorrente, retirada registrada e reembolso. Não geram inscrição. |
| 21.3 Menu de serviços | ✅ Alterações com prazo e taxa. As pagas só valem após confirmação, e a inscrição original é preservada. |
| 21.4 Conversão | 🟡 Funil básico por evento (iniciados, concluídos, pendentes e abandonados, com definições). ⏭ Recuperação de carrinho e projeções. |
| 21.5 Análise de público | ⏭ |
| 21.6 API | 🟡 v1 somente leitura, com escopo por organização, paginação, limite e auditoria. ⏭ Webhooks de saída assinados. |
| 21.7 Check-in ampliado | ✅ Interface web móvel, pontos de retirada e busca ampliada com mascaramento. Duplicidade bloqueada entre pontos. |
| 21.8 Assistente de IA | 🟡 Versão extrativa: só reaproveita trechos do regulamento e não inventa nada. Sinaliza o que falta e mantém tudo em rascunho até aprovação. ⏭ Modelo de linguagem com as mesmas regras. |
| 21.9 Seguro | ⛔ Depende de parceiro contratado. Nada é exibido. |
| 21.10 Boleto | Decisão tomada: excluído do checkout, pela compensação incompatível com a reserva temporária. |

## Limitações conhecidas
- SQLite com instância única. Para alta concorrência ou várias instâncias, migrar para PostgreSQL.
- O limite de tentativas de login e da API fica em memória e zera ao reiniciar.
- Sem worker de e-mail e sem agendador de lembretes.
- Imagens enviadas não são redimensionadas.
