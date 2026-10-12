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

> Por suíte: unitários 75, integração 73, concorrência 6, carga 4. Tempos de uma execução isolada por arquivo.
>
> **Pré-condição**: Os contêineres `app-1`, `app-2` e `app-3` devem estar parados antes de executar as suítes de integração e concorrência. Com os apps em execução, a fila SQS é consumida em paralelo, causando colisão de `MessageDeduplicationId` no DLQ FIFO e falha intermitente no teste de poison message.
> Comando de parada: `docker compose stop app-1 app-2 app-3`.

| Suíte | Arquivo | Testes | Sucesso | Falhas | Duração |
| :--- | :--- | :---: | :---: | :---: | :---: |
| Concorrência e reversão distribuída | `src/test/concurrency/concurrent-bets.spec.ts` | 5 | 5 | 0 | 790.00ms |
| 3 processos Bun na mesma wallet | `src/test/concurrency/multiprocess-concurrency.spec.ts` | 1 | 1 | 0 | 808.00ms |
| Inicialização do AppModule completo | `src/test/integration/bootstrap.spec.ts` | 1 | 1 | 0 | 403.00ms |
| Deduplicação inbox multi-instância | `src/test/integration/consumer-inbox-dedup.spec.ts` | 1 | 1 | 0 | 335.00ms |
| Redrive seletivo da DLQ (filas FIFO dedicadas) | `src/test/integration/dlq-redrive.spec.ts` | 1 | 1 | 0 | 4.19s |
| Transações FAILED, outbox e métrica | `src/test/integration/failed-transaction.spec.ts` | 1 | 1 | 0 | 418.00ms |
| Endpoints HTTP (Nest real) | `src/test/integration/http-endpoints.spec.ts` | 14 | 14 | 0 | 457.00ms |
| Validação HTTP → 400 | `src/test/integration/http-validation.spec.ts` | 8 | 8 | 0 | 304.00ms |
| Invariantes e resiliência (crash, SIGTERM, DLQ, 503) | `src/test/integration/invariants-resilience.spec.ts` | 16 | 16 | 0 | 8.03s |
| Ordem FIFO, DLQ sem perda, ordem do outbox | `src/test/integration/messaging-ordering.spec.ts` | 5 | 5 | 0 | 601.00ms |
| Métricas Prometheus sob tráfego | `src/test/integration/metrics-traffic.spec.ts` | 1 | 1 | 0 | 328.00ms |
| Métricas de pendências e reconciliação atualizadas | `src/test/integration/metrics-wiring.spec.ts` | 2 | 2 | 0 | 365.00ms |
| Outbox com publishers concorrentes | `src/test/integration/outbox-publisher.spec.ts` | 1 | 1 | 0 | 236.00ms |
| Idempotência em PENDING_REFERENCE | `src/test/integration/pending-reference-idempotency.spec.ts` | 4 | 4 | 0 | 337.00ms |
| Corrida de reversões pendentes | `src/test/integration/pending-reference-reversal-race.spec.ts` | 1 | 1 | 0 | 364.00ms |
| Reconciliação em três vias | `src/test/integration/reconciliation-three-way.spec.ts` | 3 | 3 | 0 | 307.00ms |
| Retenção de outbox e inbox | `src/test/integration/retention.spec.ts` | 2 | 2 | 0 | 198.00ms |
| Consumer SQS (DLQ, inbox, ack) | `src/test/integration/sqs-consumer.spec.ts` | 2 | 2 | 0 | 308.00ms |
| Casos de uso core | `src/test/integration/use-cases.spec.ts` | 8 | 8 | 0 | 415.00ms |
| UUID em maiúsculas (referência e replay) | `src/test/integration/uuid-case.spec.ts` | 2 | 2 | 0 | 208.00ms |
| Carga: 50 BETs concorrentes | `src/test/load/load-50-bets.spec.ts` | 4 | 4 | 0 | 3.21s |
| Hash canônico SHA-256 | `src/test/unit/canonical-hash.spec.ts` | 2 | 2 | 0 | 7.00ms |
| Value object Money | `src/test/unit/money.spec.ts` | 15 | 15 | 0 | 6.00ms |
| Pré-carga do ambiente de teste | `src/test/unit/preload-check.spec.ts` | 1 | 1 | 0 | 3.00ms |
| Regras de referência e reversão | `src/test/unit/validate-reference.spec.ts` | 17 | 17 | 0 | 9.00ms |
| Validação de contrato HTTP/SQS | `src/test/unit/wager-payload.validator.spec.ts` | 19 | 19 | 0 | 5.00ms |
| Máquina de estados WagerTransaction | `src/test/unit/wager-transaction.spec.ts` | 13 | 13 | 0 | 5.00ms |
| Agregado Wallet | `src/test/unit/wallet.spec.ts` | 8 | 8 | 0 | 9.00ms |
| **Total** | **28 arquivos** | **158** | **158** | **0** | |

---

## 2. Carga HTTP com 3 Réplicas (latência percebida pelo cliente)

**Como ler:** p99 é o tempo abaixo do qual ficam 99% das respostas — o 1% mais lento que um provedor enxerga. A média esconde esse 1%; em pagamentos, é ele que estoura timeouts do provedor e gera reenvios. O p50 é o caso típico.

Comando: `bun run load:http` (stack em `docker compose up -d --wait`). 64 usuários virtuais em loop fechado, 20 s por cenário, requisições distribuídas entre `app-1..3`, sem balanceador na frente. Ambiente: MacBook Air M4 (16 GB), Docker Desktop, gerador na mesma máquina. Os números variam entre máquinas e não são comparáveis diretamente com medições feitas em outro hardware.

| Cenário | Versão | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erros |
| :--- | :--- | ---: | ---: | ---: | ---: | :---: |
| distributed (uma wallet por usuário) | antes | 1292 | 35 | 135 | 183 | 0 |
| distributed | **depois** | **1820–1872** | **25–26** | **89–92** | **119–128** | 0 |
| hot wallet (todos na mesma wallet) | antes | 397 | 132 | 369 | 419 | 0 |
| hot wallet | **depois** | **492–516** | **103–108** | **260–296** | **337–348** | 0 |

**O que mudou:** a aposta caiu de 13 para 9 comandos SQL e, **com o lock da wallet seguro, de 10 para 6 idas ao banco**: o repositório deixou de fazer um `SELECT` antes de inserir a transação e cada evento do outbox (a existência vem do identity map da unidade de trabalho), e os dois eventos passaram a sair num único `INSERT`. Na hot wallet o teto é `1 / tempo de lock`; encurtar o lock é a alavanca que não adiciona complexidade.

## 3. Testes de Carga e Limites de Concorrência (no processo)

### 3.1 Repetição de Carga: 50 Apostas Simultâneas (5 Rodadas na Mesma Carteira)

Cenário: 50 requisições paralelas com `idempotencyKey` distintos enviadas a uma única carteira.
Metodologia: Medição de percentis p50, p95 e p99 via `performance.now()` e verificação contábil de integridade após cada ciclo.

| Rodada | Total Enviado | `PROCESSED` | `503 Service Unavailable` | p50 | p95 | p99 | Invariante Contábil |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **1** | 50 | 44 | 6 | 386.0 ms | 633.0 ms | 636.0 ms | `consistent: true` (drift 0.00 BRL) |
| **2** | 50 | 50 | 0 | 260.2 ms | 450.1 ms | 553.0 ms | `consistent: true` (drift 0.00 BRL) |
| **3** | 50 | 50 | 0 | 173.2 ms | 474.1 ms | 511.7 ms | `consistent: true` (drift 0.00 BRL) |
| **4** | 50 | 50 | 0 | 173.1 ms | 344.5 ms | 427.1 ms | `consistent: true` (drift 0.00 BRL) |
| **5** | 50 | 50 | 0 | 192.5 ms | 379.0 ms | 483.5 ms | `consistent: true` (drift 0.00 BRL) |

### 3.2 Escalação Concorrente e Ponto de Quebra (100 e 200 Requisições)

Cenário: Incremento da rajada de concorrência em uma única carteira para identificar o ponto de contenção do bloqueio otimista (`MAX_RETRIES = 6`).

| Lote Concorrente | `PROCESSED` | `503 Service Unavailable` | p50 | p95 | p99 | Consistência Contábil |
| :-: | :-: | :-: | :-: | :-: | :-: | :-: |
| **100 apostas** | 81 (81%) | 19 (19%) | 625.4 ms | 794.7 ms | 816.0 ms | `consistent: true` (drift 0.00 BRL) |
| **200 apostas** | 107 (53.5%) | 93 (46.5%) | 884.7 ms | 965.0 ms | 987.4 ms | `consistent: true` (drift 0.00 BRL) |

**Análise**:
Sob 100 requisições simultâneas em um único registro de carteira, a taxa de sucesso é de 81%. Em 200 requisições simultâneas, ocorrem 503 com `Retry-After: 1` para 46.5% das requisições devido ao esgotamento das 6 tentativas com jitter exponencial. Em nenhum caso ocorreu saldo negativo ou drift entre o saldo da carteira e a soma do ledger.
