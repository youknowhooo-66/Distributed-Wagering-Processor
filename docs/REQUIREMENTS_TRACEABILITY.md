# Rastreabilidade: Enunciado → Código → Teste

Revisada em 15/10/2026. Cada linha cita a exigência do enunciado (seção entre parênteses), onde ela está implementada e qual teste a comprova. Caminhos de teste relativos a `src/test/`.

Status: ✅ atendido e testado · ✅¹ atendido com interpretação documentada.

---

## Seção 2 — Autenticação

| Exigência | Implementação | Status |
|---|---|---|
| Não implementar autenticação artesanal; se não implementar IdP, documentar e deixar ponto de extensão | `NoopAuthGuard` + `ProviderIdentityPort` (`src/shared/application/ports/auth.guard.ts`); desenho OIDC (Keycloak/Zitadel) em `ARCHITECTURE.md` §15 | ✅ |
| Health aberto; fila é canal interno, mas identidade do provedor validada no domínio | `/health/*` sem guard; mensagens SQS passam pelo mesmo validador e pelas mesmas regras (titularidade da wallet, referências do mesmo provedor) | ✅ |

## Seção 4 — Stack

| Exigência | Implementação | Status |
|---|---|---|
| Bun 1.x, TypeScript estrito, NestJS, PostgreSQL, SQS via LocalStack, Docker Compose | `package.json`, `tsconfig.json` (`strict`, `noUncheckedIndexedAccess`), `docker-compose.yml` (PostgreSQL 16, LocalStack 3, migração one-shot, 3 réplicas) | ✅ |
| Migrations versionadas e reversíveis | 12 migrations com `down()`; `integration/invariants-resilience` (g) faz o ciclo down/up em banco descartável; CI roda `migration:down && migration:up` | ✅ |
| MikroORM (preferencial), escolha e mapeamento de `Money` justificados | `ARCHITECTURE.md` §2 e §5; colunas `NUMERIC(19,2)` + moeda separada, reidratadas como `Money` | ✅ |

## Seção 5 — Restrições invioláveis

| # | Restrição | Implementação | Evidência | Status |
|:-:|---|---|---|:-:|
| 1 | Sem `number`/`float`/`double` para dinheiro | `Money` sobre `decimal.js`, string decimal com 2 casas; `NUMERIC(19,2)` | `unit/money.spec.ts` | ✅ |
| 2 | Idempotência não pode depender de cache em memória | `UNIQUE (provider_id, idempotency_key)`, `UNIQUE (provider_id, external_transaction_id)`, inbox `(consumer_name, message_id)` | `concurrency/concurrent-bets` (50 idênticas → 1 débito), `integration/consumer-inbox-dedup` | ✅ |
| 3 | Não confiar só em SQS FIFO | Invariantes no banco; inbox persistente; consumer trata redelivery | `integration/invariants-resilience` (b) | ✅ |
| 4 | Não publicar evento antes do commit | Transactional outbox na mesma transação; publisher lê só linhas commitadas | `integration/invariants-resilience` (c), (h) | ✅ |
| 5 | Não sobrescrever nem excluir ledger | `trg_wallet_ledger_immutable` (UPDATE/DELETE) + `trg_wallet_ledger_no_truncate` | `integration/use-cases` (imutabilidade), `integration/delivery-hardening` (truncate) | ✅ |
| 6 | Sem lock global | `SELECT … FOR UPDATE` só na linha da wallet; advisory lock só por grupo da outbox | `concurrency/concurrent-bets` (wallets distintas em paralelo) | ✅ |
| 7 | Sem `read → calculate → update` sem controle | Lock por linha + `version` verificada no UPDATE + retry limitado | `integration/invariants-resilience` (f.2-real) | ✅ |
| 8 | Correto com múltiplas instâncias | Estado só no PostgreSQL; consumer/publisher/worker seguros entre réplicas | `concurrency/multiprocess-concurrency` (3 processos), `integration/messaging-ordering` (3 publishers) | ✅ |
| 9 | Unicidade, imutabilidade e não-negatividade **no schema** | UNIQUEs, `CHECK`s, `uq_wager_reference_reversal`, imutabilidade do ledger, `trg_wager_transaction_guard` (transação terminal imutável), pareamento saldo ↔ ledger (`trg_wallet_balance_has_ledger`, `trg_ledger_wallet_version`), coerência ledger ↔ transação | `integration/delivery-hardening` (guardas), `integration/reconciliation-three-way` | ✅ |

## Seção 6 — Modelo de domínio

| Exigência | Implementação | Evidência | Status |
|---|---|---|:-:|
| Construtor privado + `create`/`from`/`rehydrate`; `rehydrate` não revalida | Todas as entidades e `Money` | `unit/wallet.spec.ts`, `unit/wager-transaction.spec.ts` | ✅ |
| `Money` imutável; escala 2; rejeita NaN, Infinity, notação científica, vazio, > 2 casas, negativo na entrada; erro em moedas diferentes | `src/shared/domain/value-objects/money.ts` | `unit/money.spec.ts` | ✅ |
| Multi-moeda com conflito testado | Wallet por `playerId + currency`; `CurrencyMismatchError`; `CURRENCY_MISMATCH` | `unit/money.spec.ts`, `unit/wager-rules.spec.ts`, `unit/wallet.spec.ts` | ✅ |
| Wallet: única por `playerId + currency`; saldo ≥ 0; toda alteração tem lançamento e vice-versa; sem lost update; `version` = 1 na criação e só sobe com saldo | Agregado `Wallet`; `uq_wallets_player_currency`; `CHECK`; `wallet_version` + gatilhos (ADR-006) | `unit/wallet.spec.ts`, `integration/delivery-hardening` (corrida de criação → 1×201 + 409s; saldo sem lançamento recusado; versão sem saldo recusada) | ✅ |
| `WagerTransaction`: estados e transições explícitos; terminais imutáveis; OPENING interno; mesma chave + payload diferente = conflito | Entidade + `trg_wager_transaction_guard`; validador rejeita OPENING | `unit/wager-transaction.spec.ts`, `integration/delivery-hardening`, `integration/pending-reference-idempotency` | ✅ |
| `WalletLedgerEntry` sem campos mutáveis; `isBalanced()` na factory; no máximo um lançamento por wallet por transação; LOSS/REJECTED sem lançamento | Entidade imutável; `uq_ledger_transaction`; `settle()` | `unit/wallet.spec.ts`, `unit/wager-rules.spec.ts` | ✅ |
| Inbox, alteração financeira, ledger e outbox na mesma transação SQL | `ProcessWagerTransactionUseCase.process` dentro de `UnitOfWork.transactional` | `integration/invariants-resilience` (a.0), `integration/sqs-consumer` | ✅ |

## Seção 7 — Regras de negócio

| Regra | Implementação (`src/wagering/domain/wager-rules.ts`) | Evidência | Status |
|---|---|---|:-:|
| BET debita; rejeita sem saldo | `settle` → `INSUFFICIENT_BALANCE` | `unit/wager-rules.spec.ts` | ✅ |
| WIN credita; LOSS não move saldo nem gera lançamento | `settle` | `unit/wager-rules.spec.ts`, `integration/use-cases` | ✅ |
| REFUND só de BET `PROCESSED`, uma vez | `checkReference` + `uq_wager_reference_reversal` | `unit/wager-rules.spec.ts`, `concurrency/concurrent-bets` (P0.2) | ✅ |
| ROLLBACK inverte BET/WIN/REFUND `PROCESSED`, uma vez | `checkReference` + `settle` (direção inversa) | `unit/wager-rules.spec.ts`, `integration/invariants-resilience` (a.1–a.3) | ✅ |
| 1. REFUND/ROLLBACK exigem referência | Validador + `MissingReferenceError` + `chk_wager_reference_required` | `unit/wager-rules.spec.ts`, `integration/http-validation` | ✅ |
| 2. Mesmo provider, player, wallet, moeda e rodada | `checkReference` (`CROSS_*`, `CURRENCY_MISMATCH`) | `unit/wager-rules.spec.ts` | ✅ |
| 3. Tipos referenciáveis | `INVALID_REFERENCE_KIND` | `unit/wager-rules.spec.ts` | ✅ |
| 4. Não reverter duas vezes pelo mesmo tipo | Mais estrito: uma reversão por referência, qualquer tipo (ADR-003) | `integration/invariants-resilience` (a.1, a.2) | ✅¹ |
| 5. Valor igual ao da referência | `REVERSAL_AMOUNT_MISMATCH` | `unit/wager-rules.spec.ts` | ✅ |
| 6. REJECTED não altera saldo nem gera ledger | `recordRejection` não toca a wallet | `unit/wager-rules.spec.ts`, `integration/delivery-hardening` | ✅ |
| 7. Repetição devolve o resultado original com o saldo da época | `balance_after` persistido | `integration/use-cases` (P0.3) | ✅ |
| 8. Referência ausente → `PENDING_REFERENCE` | `awaitReference`; também quando a referência existe mas aguarda | `concurrency/concurrent-bets`, `integration/delivery-hardening` (cadeia ROLLBACK→REFUND→BET) | ✅ |
| 9. Reversão que zeraria abaixo de 0: rejeitada com código distinto | `REVERSAL_INSUFFICIENT_BALANCE` | `unit/wager-rules.spec.ts`, `integration/http-endpoints` | ✅ |
| 7.1 Worker com backoff, limite e `REJECTED` + evento | `RetryPendingReferencesUseCase` (10 tentativas, `min(2^n s, 300 s)`) | `integration/invariants-resilience` (d), `integration/use-cases` (P0.4) | ✅ |
| 7.2 Taxonomia de `failureCode` documentada | `failure-codes.ts`; `ARCHITECTURE.md` §11 com ação do provedor | — | ✅ |

## Seção 8 — Concorrência

| Exigência | Evidência | Status |
|---|---|:-:|
| Cenário obrigatório: 100,00; duas apostas de 80,00 simultâneas → 1 `PROCESSED`, 1 `REJECTED`, saldo 20,00, 1 débito | `concurrency/concurrent-bets` (MANDATORY SCENARIO); repetido entre 3 instâncias no smoke test (`docs/evidence/validation-2026-10-15.md`) | ✅ |
| Múltiplos workers na mesma wallet; wallets distintas em paralelo; ≥ 3 instâncias | `concurrency/concurrent-bets`, `concurrency/multiprocess-concurrency` | ✅ |
| Estratégia justificada | Lock pessimista por wallet + `version` + retry limitado (`ARCHITECTURE.md` §3, ADR-001) | ✅ |

## Seção 9 — API HTTP

| Exigência | Implementação | Evidência | Status |
|---|---|---|:-:|
| `POST /wallets` com OPENING na mesma transação; duplicada = conflito | `OpenWalletUseCase`; 409 também na corrida | `integration/use-cases`, `integration/delivery-hardening` | ✅ |
| Consultas: wallet, ledger com cursor estável e opaco, transação por id e por `(provider, externalId)` | Cursor por `wallet_version` | `integration/http-endpoints`, `integration/delivery-hardening` (páginas estáveis com escrita concorrente) | ✅ |
| `Idempotency-Key` obrigatório e fonte da verdade | 400 `MISSING_IDEMPOTENCY_KEY` | `integration/delivery-hardening` | ✅ |
| `payloadHash` = SHA-256 de JSON canônico do subconjunto de negócio, documentado | `canonical-hash.ts`; `ARCHITECTURE.md` §6 | `unit/canonical-hash.spec.ts` | ✅ |
| Replay idêntico → mesma resposta + `idempotentReplay: true`; payload diferente → conflito | — | `integration/use-cases`, `integration/pending-reference-idempotency`, `integration/delivery-hardening` | ✅ |
| Status distinguem payload inválido, conflito, regra de negócio, aceite pendente, falha transitória — de forma consistente | 400 / 409 / 422 / 202 / 503 (+ 500 para `FAILED`); `ARCHITECTURE.md` §12 | `integration/http-endpoints`, `integration/invariants-resilience` (f.1, f.2), `integration/database-unavailable` | ✅ |
| Reconciliação sem correção silenciosa: log, métrica e sinalização | `ReconcileWalletUseCase` | `integration/metrics-wiring`, `integration/reconciliation-three-way` | ✅ |
| `/health/live` e `/health/ready` (PostgreSQL e SQS) sem autenticação | `HealthController` | `integration/http-endpoints` | ✅ |

## Seção 10 — Processamento por SQS

| Exigência | Evidência | Status |
|---|---|:-:|
| Mesmo use case da entrada HTTP | `SqsWagerConsumer` → `ProcessWagerTransactionUseCase.execute` | ✅ |
| Inbox persistente por `(consumerName, messageId)` | `integration/consumer-inbox-dedup` | ✅ |
| Ack só após commit; redelivery sem duplicar | `integration/invariants-resilience` (b: processo morto após commit e antes do ack) | ✅ |
| Negócio (terminal), transitório (backoff), permanente (DLQ); limite antes da DLQ | `integration/invariants-resilience` (e, e.2), `integration/messaging-ordering` | ✅ |
| SIGTERM conclui em andamento ou devolve visibilidade | `integration/invariants-resilience` (i) | ✅ |

## Seção 11 — Transactional Outbox

| Exigência | Evidência | Status |
|---|---|:-:|
| Transação, saldo, ledger, inbox e evento atômicos | `integration/invariants-resilience` (a.0) | ✅ |
| Publishers concorrentes sem perder nem duplicar indefinidamente | `integration/outbox-publisher`, `integration/messaging-ordering` | ✅ |
| Commit → processo morre → outra instância publica → duplicata segura (`MessageDeduplicationId = eventId`) | `integration/invariants-resilience` (c) | ✅ |
| Eventos mínimos: `WagerTransactionProcessed` (inclusive LOSS), `Rejected`, `WalletBalanceChanged` só com mudança de saldo, `PendingReference` | `integration/invariants-resilience` (h) | ✅ |
| Envelope em classe abstrata com subclasse por evento; `eventType`/`version` no tipo; `data` com `MoneyProps` | `src/shared/domain/events/integration-event.ts`, `src/wagering/domain/events/` | ✅ |

## Seção 12 — Observabilidade

| Exigência | Implementação | Evidência | Status |
|---|---|---|:-:|
| Logs JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, sem dados sensíveis | Pino; logs como objetos com identificadores; `X-Correlation-Id` gerado/propagado até os eventos | `integration/delivery-hardening` (propagação), amostras em `docs/evidence/validation-2026-10-15.md` | ✅ |
| Métricas: por status, duplicatas, retries, DLQ, conflitos de lock, outbox lag, latência | `wagering_transactions_total{status}` e demais (`ARCHITECTURE.md` §14) | `integration/metrics-traffic`, `integration/metrics-wiring` | ✅ |
| Health checks separados | `/health/live`, `/health/ready` | `integration/http-endpoints` | ✅ |

## Seção 13 — Testes obrigatórios

| Exigência | Arquivo |
|---|---|
| Unidade: Money (escala, entradas inválidas) | `unit/money.spec.ts` |
| Unidade: invariantes da Wallet | `unit/wallet.spec.ts` |
| Unidade: regras BET, WIN, LOSS, REFUND, ROLLBACK | `unit/wager-rules.spec.ts` (código de produção, sem cópia da regra) |
| Unidade: conflito de moeda | `unit/money.spec.ts`, `unit/wager-rules.spec.ts` |
| Unidade: idempotency key com payload divergente | `unit/canonical-hash.spec.ts`; integração em `integration/use-cases` |
| Integração: migrations e constraints | `integration/invariants-resilience` (g), `integration/delivery-hardening`, `integration/reconciliation-three-way` |
| Integração: atomicidade wallet/ledger/inbox/outbox | `integration/invariants-resilience` (a.0) |
| Integração: inbox e redelivery | `integration/consumer-inbox-dedup`, `integration/sqs-consumer` |
| Integração: publishers concorrentes | `integration/outbox-publisher`, `integration/messaging-ordering` |
| Integração: retry e DLQ | `integration/invariants-resilience` (e, e.2), `integration/dlq-redrive` |
| Integração: recuperação após reinicialização | `integration/invariants-resilience` (c) |
| Concorrência 1–8 (50 em paralelo, cenário §8, wallets distintas, ≥ 3 processos, morte após commit, dois publishers, reversão antes da referência, reinício) | `concurrency/concurrent-bets`, `concurrency/multiprocess-concurrency`, `integration/invariants-resilience` (b, c), `integration/outbox-publisher` |
| Invariante final `wallet.balance == saldo reconstruído pelo ledger` | Verificado pela reconciliação nos testes **e** imposto pelo PostgreSQL em todo commit (ADR-006) |

## Seção 14 — Falhas eliminatórias

| Falha | Situação |
|---|---|
| `number` para dinheiro | Não ocorre (`Money`/`decimal.js`, `NUMERIC(19,2)`) |
| Saldo negativo por race | Não ocorre (lock por wallet + `CHECK`; cenário §8 testado com 3 instâncias) |
| Débito ou crédito duplicado | Não ocorre (UNIQUEs de idempotência, inbox, `uq_ledger_transaction`, `uq_wager_reference_reversal`) |
| Idempotência só em memória | Não ocorre (persistida) |
| Correta só com uma instância | Não ocorre (testes com 3 processos) |
| Evento antes do commit | Não ocorre (outbox) |
| Ledger não auditável | Não ocorre (imutável, encadeado por versão, coerente com transações) |
| Testes que trocam PostgreSQL e SQS por mocks | Não ocorre (PostgreSQL e LocalStack reais; ver ressalva de ambiente no `TEST_REPORT.md`) |

Diferencial opcional atendido: teste de carga (`bun run test:load` no processo; `bun run load:http` contra as 3 réplicas, com throughput, percentis, taxa de erro, conflitos e outbox lag).
