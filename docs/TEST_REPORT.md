# Relatório de Execução de Testes (Test Report)

Data da Execução: 12/10/2026 (tabela da seção 1; seções seguintes mantêm as medições de 11/10/2026)  
Ambiente de Execução:
- **Sistema Operacional**: macOS (Apple Silicon arm64)
- **Runtime**: Bun v1.4.2
- **Banco de Dados**: PostgreSQL 16-alpine (Docker Compose, porta 5433)
- **Serviço de Mensageria**: LocalStack 3 com Amazon SQS FIFO (Docker Compose, porta 4566)
- **Pool de Conexões**: 10 conexões por instância de pool MikroORM

---

## 1. Resumo das Suítes de Teste Automatizadas

> Por suíte: unitários 75, integração 71, concorrência 6, carga 4. Tempos de uma execução isolada por arquivo.
>
> **Pré-condição**: Os contêineres `app-1`, `app-2` e `app-3` devem estar parados antes de executar as suítes de integração e concorrência. Com os apps em execução, a fila SQS é consumida em paralelo, causando colisão de `MessageDeduplicationId` no DLQ FIFO e falha intermitente no teste de poison message.
> Comando de parada: `docker compose stop app-1 app-2 app-3`.

| Suíte | Arquivo | Testes | Sucesso | Falhas | Duração |
| :--- | :--- | :---: | :---: | :---: | :---: |
| Concorrência e reversão distribuída | `src/test/concurrency/concurrent-bets.spec.ts` | 5 | 5 | 0 | 902.00ms |
| 3 processos Bun na mesma wallet | `src/test/concurrency/multiprocess-concurrency.spec.ts` | 1 | 1 | 0 | 1123.00ms |
| Inicialização do AppModule completo | `src/test/integration/bootstrap.spec.ts` | 1 | 1 | 0 | 418.00ms |
| Deduplicação inbox multi-instância | `src/test/integration/consumer-inbox-dedup.spec.ts` | 1 | 1 | 0 | 344.00ms |
| Redrive seletivo da DLQ (filas FIFO dedicadas) | `src/test/integration/dlq-redrive.spec.ts` | 1 | 1 | 0 | 4.17s |
| Transações FAILED, outbox e métrica | `src/test/integration/failed-transaction.spec.ts` | 1 | 1 | 0 | 346.00ms |
| Endpoints HTTP (Nest real) | `src/test/integration/http-endpoints.spec.ts` | 14 | 14 | 0 | 460.00ms |
| Validação HTTP → 400 | `src/test/integration/http-validation.spec.ts` | 8 | 8 | 0 | 316.00ms |
| Invariantes e resiliência (crash, SIGTERM, DLQ, 503) | `src/test/integration/invariants-resilience.spec.ts` | 16 | 16 | 0 | 7.21s |
| Ordem FIFO, DLQ sem perda, ordem do outbox | `src/test/integration/messaging-ordering.spec.ts` | 5 | 5 | 0 | 644.00ms |
| Métricas Prometheus sob tráfego | `src/test/integration/metrics-traffic.spec.ts` | 1 | 1 | 0 | 309.00ms |
| Métricas de pendências e reconciliação atualizadas | `src/test/integration/metrics-wiring.spec.ts` | 2 | 2 | 0 | 382.00ms |
| Outbox com publishers concorrentes | `src/test/integration/outbox-publisher.spec.ts` | 1 | 1 | 0 | 228.00ms |
| Idempotência em PENDING_REFERENCE | `src/test/integration/pending-reference-idempotency.spec.ts` | 4 | 4 | 0 | 331.00ms |
| Corrida de reversões pendentes | `src/test/integration/pending-reference-reversal-race.spec.ts` | 1 | 1 | 0 | 404.00ms |
| Reconciliação em três vias | `src/test/integration/reconciliation-three-way.spec.ts` | 3 | 3 | 0 | 314.00ms |
| Retenção de outbox e inbox | `src/test/integration/retention.spec.ts` | 2 | 2 | 0 | 213.00ms |
| Consumer SQS (DLQ, inbox, ack) | `src/test/integration/sqs-consumer.spec.ts` | 2 | 2 | 0 | 293.00ms |
| Casos de uso core | `src/test/integration/use-cases.spec.ts` | 8 | 8 | 0 | 453.00ms |
| Carga: 50 BETs concorrentes | `src/test/load/load-50-bets.spec.ts` | 4 | 4 | 0 | 4.23s |
| Hash canônico SHA-256 | `src/test/unit/canonical-hash.spec.ts` | 2 | 2 | 0 | 8.00ms |
| Value object Money | `src/test/unit/money.spec.ts` | 15 | 15 | 0 | 6.00ms |
| Pré-carga do ambiente de teste | `src/test/unit/preload-check.spec.ts` | 1 | 1 | 0 | 3.00ms |
| Regras de referência e reversão | `src/test/unit/validate-reference.spec.ts` | 17 | 17 | 0 | 9.00ms |
| Validação de contrato HTTP/SQS | `src/test/unit/wager-payload.validator.spec.ts` | 19 | 19 | 0 | 5.00ms |
| Máquina de estados WagerTransaction | `src/test/unit/wager-transaction.spec.ts` | 13 | 13 | 0 | 5.00ms |
| Agregado Wallet | `src/test/unit/wallet.spec.ts` | 8 | 8 | 0 | 9.00ms |
| **Total** | **27 arquivos** | **156** | **156** | **0** | |

---

## 2. Testes de Carga e Limites de Concorrência

### 2.1 Repetição de Carga: 50 Apostas Simultâneas (5 Rodadas na Mesma Carteira)

Cenário: 50 requisições paralelas com `idempotencyKey` distintos enviadas a uma única carteira.
Metodologia: Medição de percentis p50, p95 e p99 via `performance.now()` e verificação contábil de integridade após cada ciclo.

| Rodada | Total Enviado | `PROCESSED` | `503 Service Unavailable` | p50 | p95 | p99 | Invariante Contábil |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **1** | 50 | 44 | 6 | 386.0 ms | 633.0 ms | 636.0 ms | `consistent: true` (drift 0.00 BRL) |
| **2** | 50 | 50 | 0 | 260.2 ms | 450.1 ms | 553.0 ms | `consistent: true` (drift 0.00 BRL) |
| **3** | 50 | 50 | 0 | 173.2 ms | 474.1 ms | 511.7 ms | `consistent: true` (drift 0.00 BRL) |
| **4** | 50 | 50 | 0 | 173.1 ms | 344.5 ms | 427.1 ms | `consistent: true` (drift 0.00 BRL) |
| **5** | 50 | 50 | 0 | 192.5 ms | 379.0 ms | 483.5 ms | `consistent: true` (drift 0.00 BRL) |

### 2.2 Escalação Concorrente e Ponto de Quebra (100 e 200 Requisições)

Cenário: Incremento da rajada de concorrência em uma única carteira para identificar o ponto de contenção do bloqueio otimista (`MAX_RETRIES = 6`).

| Lote Concorrente | `PROCESSED` | `503 Service Unavailable` | p50 | p95 | p99 | Consistência Contábil |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **100 apostas** | 81 (81%) | 19 (19%) | 625.4 ms | 794.7 ms | 816.0 ms | `consistent: true` (drift 0.00 BRL) |
| **200 apostas** | 107 (53.5%) | 93 (46.5%) | 884.7 ms | 965.0 ms | 987.4 ms | `consistent: true` (drift 0.00 BRL) |

**Análise**:
Sob 100 requisições simultâneas em um único registro de carteira, a taxa de sucesso é de 81%. Em 200 requisições simultâneas, ocorrem 503 com `Retry-After: 1` para 46.5% das requisições devido ao esgotamento das 6 tentativas com jitter exponencial. Em nenhum caso ocorreu saldo negativo ou drift entre o saldo da carteira e a soma do ledger.
