# Matriz de Rastreabilidade Completa de Requisitos (Original Challenge Specs)

Data da Auditoria: 11/10/2026 — revisada em 12/10/2026  
Escopo: Distributed Wagering Processor (Jungle Gaming)

---

## 1. As 9 Restrições Invioláveis (Seção 5 do Desafio)

| # | Restrição Original do Enunciado | Solução de Engenharia | Evidência em Código | Evidência em Execução / Banco | Status |
| :-: | :--- | :--- | :--- | :--- | :-: |
| **1** | Múltiplas instâncias simultâneas da aplicação (≥2 réplicas) sem single point of failure ou dependência de afinidade de requisições. | Lock por linha da wallet (`SELECT ... FOR UPDATE`) no PostgreSQL, com `version` como barreira; nenhum estado em memória local. | `../src/wagering/application/use-cases/process-wager-transaction.use-case.ts:L179` | Teste multi-processo com 3 instâncias Bun concorrentes: `../src/test/concurrency/multiprocess-concurrency.spec.ts`. | ✅ VERIFICADO |
| **2** | PostgreSQL para persistência do estado e Amazon SQS FIFO para mensageria assíncrona. | PostgreSQL 16 + AWS SQS FIFO com deduplicação e grouping. | `../src/shared/infrastructure/database/mikro-orm.config.ts`, `../src/shared/infrastructure/messaging/sqs.client.ts` | Teste de integração do consumidor SQS e publisher SQS FIFO aprovados: `../src/test/integration/sqs-consumer.spec.ts`. | ✅ VERIFICADO |
| **3** | Precisão monetária arbitrária. Não utilizar tipos de ponto flutuante (`float`/`double`/`number`) para representação de valores monetários. | Objeto de valor `Money` baseado em `Decimal.js` com strings exatas e 2 casas decimais. | `../src/shared/domain/value-objects/money.ts:L15` | Colunas SQL `numeric(19,2)` em todas as tabelas financeiras (`wallets`, `wallet_ledger_entries`, `wager_transactions`). | ✅ VERIFICADO |
| **4** | O saldo da carteira nunca pode se tornar negativo em nenhuma circunstância. | Validação em memória no agregado `Wallet.debit()` e constraint de integridade no PostgreSQL. | `../src/wallet/domain/wallet.entity.ts:L99` | PostgreSQL: `chk_wallets_balance_non_negative CHECK (balance_amount >= 0)`. Teste concorrente de saldo aprovado. | ✅ VERIFICADO |
| **5** | O ledger financeiro é estritamente append-only. Nenhuma linha existente do ledger pode sofrer `UPDATE` ou `DELETE`. | Trigger de banco de dados nativa em PL/pgSQL bloqueando qualquer mutação em `wallet_ledger_entries`. | `../src/migrations/Migration20261011000001_ledger_immutability.ts:L6` | Teste em `../src/test/integration/use-cases.spec.ts:L248` aborta com exceção disparada pela trigger. | ✅ VERIFICADO |
| **6** | Garantia de idempotência estrita para todas as operações de aposta e transações financeiras. | Constraint de chave única em `idempotency_key` e validação de hash canônico SHA-256 em qualquer estado da transação existente, inclusive `PENDING_REFERENCE`. | `../src/wagering/application/use-cases/process-wager-transaction.use-case.ts:L187` | PostgreSQL: `uq_wager_provider_idempotency_key` (chave única por provedor; `../src/test/integration/provider-scoped-idempotency.spec.ts`). Teste de 50 requisições idênticas simultâneas gerando 1 único débito; `../src/test/integration/pending-reference-idempotency.spec.ts` (reenvio com valor/referência diferentes → 409, saldo inalterado). | ✅ VERIFICADO |
| **7** | Replay idempotente deve retornar o resultado da transação original, incluindo o saldo após o processamento original. | Persistência da coluna `balance_after numeric(19,2)` em cada transação via Migration 3. | `../src/wagering/application/use-cases/process-wager-transaction.use-case.ts:L192` | Teste de replay em `../src/test/integration/use-cases.spec.ts:L274` devolve saldo histórico mesmo após mutações subsequentes. | ✅ VERIFICADO |
| **8** | Mensageria assíncrona com garantia de ordenação por carteira e desduplicação de mensagens. | Envio via SQS FIFO com `MessageGroupId = walletId` e `MessageDeduplicationId = eventId`; publicação em ordem por wallet com lock consultivo por grupo (ADR-005); consumer não processa mensagens posteriores de um grupo cuja anterior falhou no lote. | `../src/wagering/infrastructure/messaging/outbox-publisher.worker.ts:L94`, `../src/wagering/infrastructure/messaging/sqs-wager.consumer.ts:L139` | Publicação e consumo reais via LocalStack; `../src/test/integration/messaging-ordering.spec.ts` (ordem com falha e com 3 publishers concorrentes). | ✅ VERIFICADO |
| **9** | Schema de banco relacional e migrações versionadas e reversíveis. | Migrações MikroORM estruturadas com scripts `up()` e `down()`. | `../src/migrations/` (10 migrações ativas) | Teste automatizado de reversibilidade executado via `bun run migration:down` e `bun run migration:up`. | ✅ VERIFICADO |

---

## 2. As 8 Áreas da Rubrica de Avaliação (com Pesos)

| Área da Rubrica | Peso | Requisito do Desafio | Implementação / Evidência | Status |
| :--- | :-: | :--- | :--- | :-: |
| **1. Arquitetura e DDD** | 20% | Separação em camadas (Domínio, Aplicação, Infraestrutura). Domínio puro sem decorators de framework/ORM. | Agregados puros `Wallet`, `WagerTransaction`, `WalletLedgerEntry` com construtores privados e fábricas; casos de uso dependem só de portas (`UnitOfWork`, repositórios), com erros do banco traduzidos por SQLSTATE no adaptador. | ✅ VERIFICADO |
| **2. Concorrência e Transações** | 20% | Múltiplas transações simultâneas sem inconsistência, sem deadlocks e sem perda de atualizações. | Lock por linha da wallet com ordem única de aquisição, `lock_timeout`, `version` como barreira, retries com jitter e 503 com `Retry-After: 1`. | ✅ VERIFICADO |
| **3. Idempotência e Hash** | 15% | Deduplicação por chave, detecção de colisões de payload divergente (409) e replay com saldo histórico. | Constraint única no banco, SHA-256 canônico, gravação de `balance_after`. | ✅ VERIFICADO |
| **4. Contabilidade (Ledger)** | 15% | Registro imutável de transações com saldo anterior e posterior, reconciliação matemática. | Tabela `wallet_ledger_entries` com trigger de imutabilidade e reconciliação em três vias (saldo × ledger × transações) em `ReconcileWalletUseCase`. | ✅ VERIFICADO |
| **5. Mensageria Distribuída** | 10% | Consumo e publicação ordenados via SQS FIFO, Transactional Outbox Pattern e Inbox Pattern. | Fila `wagering-events.fifo` com `MessageGroupId: walletId` e desduplicação via `inbox_messages`. | ✅ VERIFICADO |
| **6. Observabilidade** | 10% | Métricas Prometheus expostas via `/metrics` (contadores, latência, gauges de outbox e fila). | Endpoint `/metrics` via `prom-client`, alimentado pela porta `WageringMetrics`; todas as métricas documentadas são atualizadas (teste `../src/test/integration/metrics-wiring.spec.ts`); 8 regras de alerta em `../infra/prometheus/alerts.yml` testadas com `promtool`. | ✅ VERIFICADO |
| **7. Resiliência e Falhas** | 5% | Dead Letter Queue para mensagens venenosas, tratamento de erros temporários vs definitivos. | Fila `wager-transactions-dlq.fifo` com `FailureReason`; erros permanentes direto para a DLQ; mensagem só sai da fila principal após a DLQ confirmar; redrive seletivo (`bun run dlq:redrive`) e retenção de outbox/inbox testados. | ✅ VERIFICADO |
| **8. Testabilidade** | 5% | Testes unitários, integração, concorrência multi-processo e testes de carga. | 75 unitários, 77 integração, 6 concorrência, 4 carga (total: 162 testes em 29 arquivos); carga HTTP com p50/p95/p99 em `bun run load:http`; typecheck cobre produção, testes e scripts; workflow de CI em `.github/workflows/ci.yml`. | ✅ VERIFICADO |

---

## 3. As 8 Falhas Eliminatórias (Seção 14 do Desafio)

| # | Falha Eliminatória Original | Status no Projeto | Evidência de Prevenção |
| :-: | :--- | :---: | :--- |
| **FE-01** | **Saldo negativo permitido sob concorrência** | **NÃO OCORRE** | Constraint de banco `chk_wallets_balance_non_negative` + validação em `Wallet.debit()`. |
| **FE-02** | **Drift contábil entre carteira e ledger** | **NÃO OCORRE** | Ledger × transações imposto pelo PostgreSQL no commit (gatilhos diferidos) e verificado pela reconciliação em três vias; recusa e detecção cobertas em `../src/test/integration/reconciliation-three-way.spec.ts`. |
| **FE-03** | **Débito duplo por falha de idempotência** | **NÃO OCORRE** | Chave única por provedor `uq_wager_provider_idempotency_key` no PostgreSQL. Teste com 50 envios simultâneos resulta em 1 débito. |
| **FE-04** | **Mutação ou deleção de registro do ledger** | **NÃO OCORRE** | Abortado com erro PL/pgSQL pela trigger `trg_wallet_ledger_immutable`. |
| **FE-05** | **Uso de ponto flutuante para dinheiro** | **NÃO OCORRE** | Uso exclusivo de `Money` com `Decimal.js` e tipo `numeric(19,2)`. |
| **FE-06** | **Publicação de evento antes do commit da transação** | **NÃO OCORRE** | Transactional Outbox Pattern: evento gravado no PostgreSQL na mesma transação antes do envio. |
| **FE-07** | **Solução que funciona corretamente somente em instância única** | **NÃO OCORRE** | Concorrência comprovada com 3 processos Bun independentes disputando a mesma carteira. |
| **FE-08** | **Testes substituindo PostgreSQL e SQS por mocks** | **NÃO OCORRE** | PostgreSQL 16 é sempre real. SQS é real (LocalStack 3), exceto onde uma falha precisa ser injetada de forma determinística: as respostas do cliente SQS são roteirizadas nos testes de ordem/DLQ de `../src/test/integration/messaging-ordering.spec.ts` e no `(e.2)` de `invariants-resilience.spec.ts`. |
