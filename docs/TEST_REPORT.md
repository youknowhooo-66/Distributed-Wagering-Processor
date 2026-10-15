# Relatório de Execução de Testes

Última execução: **15/10/2026**, após as correções da revisão de entrega (`docs/GAP_ANALYSIS.md`).

## Ambiente desta execução

| Item | Valor |
|---|---|
| Máquina | VM Linux x86_64, 2 vCPU, 8 GB (workspace de validação) |
| Runtime | Bun 1.4.2 |
| PostgreSQL | 16.15, local (porta 5433, credenciais do `docker-compose.yml`) |
| SQS | **Emulador SQS (protocolo JSON da AWS) em vez do LocalStack** |
| Migrations | 12 aplicadas (`bun run migration:up`), inclusive ciclo `down`/`up` com dados |

> **Ressalva sobre o SQS:**
> - O registro do Docker Hub e o PyPI não estavam acessíveis neste ambiente, então não foi possível subir o LocalStack (`localstack/localstack:3`).
> - As suítes que usam fila rodaram contra um emulador mínimo do SQS. Ele implementa FIFO por grupo, deduplicação de 5 minutos, visibilidade, `ApproximateReceiveCount` e `RedrivePolicy`, mas fica **fora do repositório**.
> - O PostgreSQL é real.
> - A evidência oficial com LocalStack vem de duas fontes:
>   - o **CI** (`.github/workflows/ci.yml`: PostgreSQL + LocalStack em containers, e as 3 réplicas da imagem Docker);
>   - `bun run scripts/collect-evidence.ts` com a stack do Docker Compose no ar.
>
> Os dois devem ser executados antes da entrega final.

## 1. Suítes automatizadas

Comandos: `bun run typecheck` (0 erros), `bun run test:unit`, `bun run test:int`, `bun run test:e2e`, `bun run test:load`. Por suíte: unitários 116, integração 98, concorrência 6, carga 4. A suíte inteira num único processo (`bun run test`) também passa: 224 testes em 33 arquivos, ~28 s. Tempos de uma execução isolada por arquivo.

> **Pré-condição** com a stack completa no ar: `docker compose stop app-1 app-2 app-3` antes das suítes. Os consumers das réplicas disputariam as mensagens SQS usadas pelos testes.

| Suíte | Arquivo | Testes | Sucesso | Falhas | Duração |
| :--- | :--- | :---: | :---: | :---: | :---: |
| Cenário §8, 50 idênticas, reversões concorrentes, wallets distintas | `src/test/concurrency/concurrent-bets.spec.ts` | 5 | 5 | 0 | 966.00ms |
| 3 processos na mesma wallet | `src/test/concurrency/multiprocess-concurrency.spec.ts` | 1 | 1 | 0 | 2.21s |
| Inicialização do AppModule completo | `src/test/integration/bootstrap.spec.ts` | 1 | 1 | 0 | 955.00ms |
| Inbox: duas réplicas, mesma mensagem | `src/test/integration/consumer-inbox-dedup.spec.ts` | 1 | 1 | 0 | 1078.00ms |
| PostgreSQL indisponível → 503 | `src/test/integration/database-unavailable.spec.ts` | 2 | 2 | 0 | 512.00ms |
| Contrato HTTP, cadeias fora de ordem, inbox em espera, guardas do schema | `src/test/integration/delivery-hardening.spec.ts` | 18 | 18 | 0 | 1.67s |
| Redrive seletivo da DLQ | `src/test/integration/dlq-redrive.spec.ts` | 1 | 1 | 0 | 4.27s |
| FAILED, outbox e métrica | `src/test/integration/failed-transaction.spec.ts` | 1 | 1 | 0 | 885.00ms |
| Endpoints HTTP (Nest real) | `src/test/integration/http-endpoints.spec.ts` | 14 | 14 | 0 | 1239.00ms |
| Validação HTTP → 400 | `src/test/integration/http-validation.spec.ts` | 8 | 8 | 0 | 825.00ms |
| Atomicidade, crash, reinício, DLQ, 503, SIGTERM, migrations | `src/test/integration/invariants-resilience.spec.ts` | 16 | 16 | 0 | 8.12s |
| Ordem FIFO, DLQ sem perda, ordem do outbox | `src/test/integration/messaging-ordering.spec.ts` | 5 | 5 | 0 | 1033.00ms |
| Métricas sob tráfego | `src/test/integration/metrics-traffic.spec.ts` | 1 | 1 | 0 | 895.00ms |
| Métricas de pendências, reconciliação e status | `src/test/integration/metrics-wiring.spec.ts` | 3 | 3 | 0 | 1133.00ms |
| Publishers concorrentes | `src/test/integration/outbox-publisher.spec.ts` | 1 | 1 | 0 | 708.00ms |
| Idempotência em PENDING_REFERENCE | `src/test/integration/pending-reference-idempotency.spec.ts` | 4 | 4 | 0 | 765.00ms |
| Corrida de reversões pendentes | `src/test/integration/pending-reference-reversal-race.spec.ts` | 1 | 1 | 0 | 966.00ms |
| Idempotência por provedor | `src/test/integration/provider-scoped-idempotency.spec.ts` | 2 | 2 | 0 | 529.00ms |
| Reconciliação e gatilhos ledger ↔ transação | `src/test/integration/reconciliation-three-way.spec.ts` | 5 | 5 | 0 | 595.00ms |
| Retenção de outbox e inbox | `src/test/integration/retention.spec.ts` | 2 | 2 | 0 | 401.00ms |
| Consumer SQS (DLQ, inbox, ack) | `src/test/integration/sqs-consumer.spec.ts` | 2 | 2 | 0 | 658.00ms |
| Casos de uso core | `src/test/integration/use-cases.spec.ts` | 8 | 8 | 0 | 916.00ms |
| UUID em maiúsculas | `src/test/integration/uuid-case.spec.ts` | 2 | 2 | 0 | 589.00ms |
| Carga no processo (50/100/200 apostas, 30 rodadas) | `src/test/load/load-50-bets.spec.ts` | 4 | 4 | 0 | 11.50s |
| Hash canônico SHA-256 | `src/test/unit/canonical-hash.spec.ts` | 2 | 2 | 0 | 119.00ms |
| Cursor/limit do ledger e contrato de POST /wallets | `src/test/unit/ledger-cursor.spec.ts` | 14 | 14 | 0 | 107.00ms |
| Value object Money | `src/test/unit/money.spec.ts` | 15 | 15 | 0 | 112.00ms |
| OutboxMessage: backoff, vencimento e envelope | `src/test/unit/outbox-message.spec.ts` | 3 | 3 | 0 | 118.00ms |
| Pré-carga do ambiente de teste | `src/test/unit/preload-check.spec.ts` | 1 | 1 | 0 | 100.00ms |
| Validação de contrato HTTP/SQS | `src/test/unit/wager-payload.validator.spec.ts` | 19 | 19 | 0 | 116.00ms |
| Regras BET/WIN/LOSS/REFUND/ROLLBACK (código de produção) | `src/test/unit/wager-rules.spec.ts` | 37 | 37 | 0 | 120.00ms |
| Máquina de estados WagerTransaction | `src/test/unit/wager-transaction.spec.ts` | 13 | 13 | 0 | 133.00ms |
| Agregado Wallet e cadeia de versões | `src/test/unit/wallet.spec.ts` | 12 | 12 | 0 | 119.00ms |
| **Total** | **33 arquivos** | **224** | **224** | **0** | |

Novos nesta revisão:
- `unit/wager-rules.spec.ts` substitui `validate-reference.spec.ts`, que testava uma **cópia** da regra e não o código de produção.
- `unit/ledger-cursor.spec.ts`.
- `unit/outbox-message.spec.ts`.
- Casos em `unit/wallet.spec.ts`.
- `integration/delivery-hardening.spec.ts`.
- `integration/database-unavailable.spec.ts`.
- O contador por status em `integration/metrics-wiring.spec.ts`.

## 2. Smoke test com 3 instâncias (build de produção)

- **Montagem:** `bun run build`, três processos `bun dist/main.js` (portas 3011–3013, `NODE_ENV=production`, workers ligados) sobre o mesmo PostgreSQL e o emulador de SQS.
- **Roteiro e saídas:** `docs/evidence/validation-2026-10-15.md`.

Resultados:
- O cenário da seção 8 foi executado **entre instâncias diferentes**: duas apostas de 80,00 em `app-2` e `app-3` ao mesmo tempo resultam em uma 200 e uma 422 `INSUFFICIENT_BALANCE`.
- Mensagem SQS consumida e processada.
- Reconciliação consistente.
- Eventos publicados na fila de eventos.
- `SIGTERM` encerra as três instâncias de forma limpa.

## 3. Carga HTTP com 3 réplicas

`bun run load:http`: usuários virtuais em loop fechado, requisições distribuídas entre as réplicas, sem balanceador. O script mede, por cenário:
- throughput;
- p50/p95/p99;
- taxa de erro;
- conflitos de lock e retries (delta das métricas das réplicas);
- maior outbox lag e backlog durante a carga;
- tempo para o outbox esvaziar depois.

**Como ler:** p99 é o tempo abaixo do qual ficam 99% das respostas, ou seja, o 1% mais lento que um provedor enxerga. Em pagamentos é ele que estoura timeouts do provedor e gera reenvios.

### 3.1 Esta revisão (15/10/2026): VM de 2 vCPU, 32 usuários, 15 s por cenário

As 3 réplicas, o PostgreSQL, o emulador de SQS e o gerador de carga dividem os mesmos 2 vCPU. O teto é a CPU da máquina, não o desenho.

| Cenário | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Conflitos de lock | Retries | Outbox lag máx (s) | Outbox pendente máx | Drenagem (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| distributed (uma wallet por usuário) | 2253 | 148.3 | 196 | 497 | 566 | 698 | 0.00% | 0 | 0 | 8.33 | 1276 | 1.8 |
| hot (todos na mesma wallet) | 1809 | 118.9 | 241 | 545 | 714 | 1188 | 0.00% | 0 | 0 | 0.75 | 199 | 0.6 |

Depois da carga, numa varredura global do banco:
- nenhuma wallet com saldo negativo;
- nenhuma quebra na cadeia `balance_before`/`balance_after`;
- outbox vazio;
- o saldo de toda wallet igual à soma do ledger.

As únicas exceções são as wallets que os testes corrompem de propósito com gatilhos desligados.

### 3.2 Medição anterior (12/10/2026): MacBook Air M4, Docker Compose, 64 usuários, 20 s

| Cenário | req/s | p50 (ms) | p95 (ms) | p99 (ms) | Erros |
| :--- | ---: | ---: | ---: | ---: | :---: |
| distributed | 1820–1872 | 25–26 | 89–92 | 119–128 | 0 |
| hot wallet | 492–516 | 103–108 | 260–296 | 337–348 | 0 |

- **Hardware:** as duas medições usaram hardware diferente e não são comparáveis entre si.
- **Código:** a de 12/10 é anterior a esta revisão. A revisão acrescenta duas checagens indexadas por commit (pareamento saldo ↔ ledger) e uma linha de log por transação.
- **Pendente:** refazer a medição no mesmo Mac para isolar o custo das mudanças (`bun run load:http`).

**Leitura:**
- Na hot wallet, o teto é `1 / tempo de lock` da linha.
- No cenário distribuído, o lag do outbox cresce enquanto a geração de eventos supera a publicação. Ele volta a zero em menos de 2 s após a carga, sem perda: o publisher drena em lotes por grupo, com até 8 grupos em paralelo por instância.

## 4. Carga no processo (`bun run test:load`)

Caso de uso direto, sem HTTP, PostgreSQL real, uma wallet.

| Cenário | Enviadas | `PROCESSED` | 503 | p50 | p95 | p99 | Conflitos de lock |
|---|---:|---:|---:|---:|---:|---:|---:|
| 50 apostas simultâneas | 50 | 50 | 0 | 345 ms | 536 ms | 554 ms | 0 |
| 30 rodadas × 50 apostas | 1500 | 1500 | 0 | — | — | — | — |
| 100 apostas simultâneas | 100 | 100 | 0 | 270 ms | 507 ms | — | — |
| 200 apostas simultâneas | 200 | 200 | 0 | 492 ms | 951 ms | — | — |

Com o lock pessimista por wallet (ADR-001), a contenção vira fila no PostgreSQL em vez de retries na aplicação: nenhuma aposta válida recebe 503. Em todas as rodadas a reconciliação termina com `consistent: true`.

## 5. Invariante final

Todos os testes que movimentam saldo terminam reconciliando a wallet: `wallet.balance` igual ao saldo reconstruído pelo ledger. Desde a migration `…15000002`, o PostgreSQL também **recusa no commit** qualquer escrita que quebre esse invariante (ADR-006). A reconciliação continua cobrindo escritas privilegiadas com gatilhos desligados, e os testes `metrics-wiring` e `reconciliation-three-way` simulam exatamente isso.
