# Relatório de validação — v0.1.0 (17/11/2026)

`npm test`: **38 testes, 38 aprovados**. Todos rodam contra o app HTTP real (cookies, CSRF, uploads multipart), com banco e pastas temporários por arquivo de teste. Pagamentos passam pelo **simulador local**, que usa o mesmo pipeline de webhook assinado e consulta ao provedor do Mercado Pago. **Ainda não houve teste no sandbox real do Mercado Pago**: faltam credenciais `TEST-`.

| Critério (itens 19 e 21.11) | Teste |
|---|---|
| Organizador: página pública → conta → confirmação de e-mail → empresa e anexos → contatos e aceites → conclusão | `01` |
| Painel e pendências; verificação; recebimento em testes; criar, revisar e publicar | `01`, `02` (pendências) |
| Atleta encontra o evento, inscreve-se, paga e vê a confirmação com QR | `01` |
| Operador entrega o kit; segunda entrega bloqueada | `01`, `04` (entre pontos simultâneos) |
| Importar, revisar e publicar resultados; consulta do atleta e histórico | `01`, `04` |
| Retomada do cadastro e preservação de dados | `02` |
| CNPJ já cadastrado (solicitação de acesso), inválido, consulta indisponível, não encontrado | `02` |
| Acesso indevido a outra empresa, a documentos privados, a exportações e à API | `02` |
| Colaborador restrito a função e evento | `02` |
| Pendências bloqueiam publicação; evento gratuito sem integração financeira | `02` |
| Inscrições simultâneas (8 para 3 vagas), expiração de reserva, estoque insuficiente | `03` |
| Webhook com assinatura inválida, duplicado, fora de ordem, valor divergente | `03` |
| Pagamento recusado; pagamento tardio com e sem vaga; resolução da exceção com reembolso | `03` |
| Cancelamento com reembolso, liberação de vaga, conciliação e CSV financeiro | `03` |
| Questionário obrigatório com versão preservada; menor sem responsável; CPF duplicado; cupom de grupo; virada de lote | `03` |
| Estoque concorrente de extras; extra não gera inscrição; alteração paga recusada preserva a original | `03` |
| Importação inválida (relatório de erros, nada salvo); classificação, desempate, DNS; correção versionada; revisão | `04` |
| Preferências interrompem avisos; marketing sem consentimento não é enviado | `04` |
| Conteúdo do assistente fica em rascunho até a aprovação | `04` |
| Escolha entre Mercado Pago, PayPal e PicPay; PayPal simulado confirma a inscrição; meio desconhecido recusado | `06` |
| PayPal (API simulada nos testes): ordem em BRL com idempotência, captura no retorno, valor divergente vira exceção, webhook com assinatura recusada | `06` |
| PicPay (API simulada nos testes): CPF do comprador, callback sem token correto recusado, confirmação, reembolso só total | `06` |
| Entrar/criar conta com Google: aceite dos termos antes de criar, e-mail verificado, vínculo com conta existente, state de uso único e preso ao navegador, conferência de emissor, público, nonce e e-mail verificado | `07` |
| Todas as telas carregam para público, atleta, organizador e administração (dados demo) | `05` |

Sobre concorrência: as requisições simultâneas do teste `03` chegam ao servidor em paralelo. A garantia contra venda acima da capacidade vem da transação `BEGIN IMMEDIATE`, que serializa as escritas, e não da ordem de chegada.

## Não validado nesta versão
- Login real com Google (os testes simulam a resposta do Google).
- Mercado Pago, PayPal e PicPay reais (os testes usam respostas simuladas das APIs), consulta real de CNPJ e envio real de e-mail: as integrações não estão configuradas.
- Testes manuais de leitor de tela e de navegadores móveis antigos.
- Carga acima de uma instância.
