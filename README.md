# 🦧 Jungle Gaming — Distributed Wagering Processor

Serviço financeiro distribuído de alta performance para processamento de transações de apostas de múltiplos provedores de jogos, projetado para garantir **correção financeira**, **idempotência persistente**, **concorrência segura entre múltiplas instâncias** e **resiliência a falhas**.

---

## 🛠️ Stack Tecnológica

| Componente | Tecnologia | Detalhes |
|---|---|---|
| **Runtime / Package Manager** | [Bun](https://bun.sh) 1.x | Execução nativa ultrarrápida e test runner |
| **Linguagem** | TypeScript 5.x | Modo strict com tipagem rigorosa de domínio |
| **Framework** | NestJS 11 | Arquitetura modular Ports & Adapters (Hexagonal / DDD) |
| **Banco de Dados** | PostgreSQL 16 | ACID, CHECK constraints, índices parciais e locks |
| **ORM** | MikroORM 6 | Unit of Work explícito, lock por linha (`FOR UPDATE`) e coluna `version` |
| **Mensageria** | AWS SQS FIFO (LocalStack) | Content-based deduplication, message groups e DLQ |
| **Orquestração Local** | Docker Compose | Migração one-shot, 3 instâncias de app, PostgreSQL e LocalStack |
| **Log Estruturado** | Pino / nestjs-pino | Logs em JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`, sem valores nem payloads |

---

## ⚡ Pré-requisitos

- [Bun](https://bun.sh) >= 1.0.0
- [Docker](https://www.docker.com/) e Docker Compose

---

## 🚀 Como Executar

### 1. Clonar e Instalar Dependências

```bash
bun install
```

### 2. Subir Infraestrutura (PostgreSQL + LocalStack)

```bash
docker compose up -d postgres localstack
```

> **Nota:** As filas SQS FIFO (`wager-transactions.fifo`, `wager-transactions-dlq.fifo` e `wagering-events`) são provisionadas automaticamente pelo script `infra/localstack-init.sh` na inicialização do LocalStack.

### 3. Rodar as Migrations do Banco de Dados

```bash
bun run migration:up
```

### 4. Iniciar o Servidor em Desenvolvimento

```bash
bun run dev
```

A API estará disponível em `http://localhost:3000`.

### 5. Stack Completa em Containers (3 réplicas)

```bash
docker compose up -d --build --wait
```

O serviço `migrate` aplica as migrations e termina; só então `app-1`, `app-2` e `app-3` sobem (portas `3011`, `3012` e `3013`), cada uma com healthcheck em `/health/ready`. A imagem roda sem root e encerra com código 0 em `SIGTERM`.

> Ao rodar a suíte de testes com a stack completa no ar, pare as réplicas antes (`docker compose stop app-1 app-2 app-3`): os consumers delas disputariam as mensagens SQS usadas pelos testes.

---

## 🧪 Suíte de Testes

Os testes rodam contra PostgreSQL e LocalStack reais (pré-requisito: passos 2 e 3):

```bash
# Checagem de tipos (código de produção, testes e scripts)
bun run typecheck

# Todos os testes (224)
bun run test

# Unitários (116): Money, Wallet, WagerTransaction, regras BET/WIN/LOSS/REFUND/ROLLBACK, hash canônico, contratos
bun run test:unit

# Integração (98): atomicidade, idempotência, reversões, reconciliação, guardas do schema, SQS/DLQ, redrive, outbox, retenção, métricas, HTTP
bun run test:int

# Concorrência (6): 3 processos disputando a mesma wallet, 50 requisições paralelas
bun run test:e2e

# Carga (4)
bun run test:load
```

Operação: `bun run dlq:redrive --reason <FailureReason> [--execute]` reenvia mensagens selecionadas da DLQ (ver `docs/OPERATIONS_RUNBOOK.md`); o expurgo de outbox/inbox é automático (`OUTBOX_RETENTION_DAYS`, `INBOX_RETENTION_DAYS`); as regras de alerta estão em `infra/prometheus/alerts.yml`.

Carga HTTP contra as 3 réplicas: `bun run load:http` (throughput, p50/p95/p99, taxa de erro, conflitos de lock, outbox lag e tempo de drenagem; resultados em `docs/TEST_REPORT.md`).

Evidências completas (testes, schema, métricas, logs, ciclo de migrations, stack em containers): `bun run scripts/collect-evidence.ts` regenera `docs/evidence/` com a stack do Docker Compose no ar.

O workflow `.github/workflows/ci.yml` executa o typecheck, a verificação da documentação, os testes das regras de alerta (`promtool`), as suítes acima, o ciclo `migration:down`/`migration:up` e, num segundo job, a imagem Docker com 3 réplicas: smoke test entre réplicas e verificação de encerramento gracioso.

---

## 📖 Endpoints da API HTTP

### 1. Criar Wallet
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

**Resposta (201 Created):**
```json
{
  "id": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
  "balance": { "amount": "1000.00", "currency": "BRL" },
  "version": 1
}
```

### 2. Consultar Wallet
```bash
curl http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37
```

### 3. Submeter Aposta (BET)

O header `Idempotency-Key` é **obrigatório** (recomendado: `{providerId}:{externalTransactionId}`). `X-Correlation-Id` é opcional: se ausente, um UUID é gerado; em ambos os casos ele volta no header da resposta e acompanha logs e eventos.

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-101" \
  -H "X-Correlation-Id: req-42" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "tx-101",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

**Resposta (200 OK):**
```json
{
  "transactionId": "01a12447-4cb5-73ec-a408-b15076ea21af",
  "status": "PROCESSED",
  "balance": { "amount": "975.00", "currency": "BRL" },
  "idempotentReplay": false
}
```

**Payload fora do contrato (400 Bad Request):**
```json
{
  "statusCode": 400,
  "error": "INVALID_PAYLOAD",
  "message": ["money.amount must be greater than zero"]
}
```

**Regra de negócio violada (422, terminal):**
```json
{
  "transactionId": "01a12447-...",
  "status": "REJECTED",
  "balance": { "amount": "20.00", "currency": "BRL" },
  "idempotentReplay": false,
  "failureCode": "INSUFFICIENT_BALANCE"
}
```

Status por resultado: `200` aplicada · `202` aguardando referência (`PENDING_REFERENCE`) · `400` contrato/header · `404` wallet inexistente · `409` conflito de idempotência · `422` rejeitada por regra · `500` `FAILED` · `503` + `Retry-After` falha transitória (reenviar com a mesma chave). Replays repetem o status original com `idempotentReplay: true`. Códigos de falha e ação esperada do provedor: `ARCHITECTURE.md`, seções 11 e 12.

### Consultar Transação
```bash
curl http://localhost:3000/wagering/transactions/01a12447-4cb5-73ec-a408-b15076ea21af
curl http://localhost:3000/providers/provider-a/wagering/transactions/tx-101
```

### 4. Consultar Ledger com Paginação por Cursor
```bash
curl "http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/ledger?limit=10"
```

**Resposta:**
```json
{
  "entries": [
    {
      "id": "...",
      "direction": "DEBIT",
      "money": { "amount": "25.00", "currency": "BRL" },
      "balanceBefore": { "amount": "1000.00", "currency": "BRL" },
      "balanceAfter": { "amount": "975.00", "currency": "BRL" },
      "walletVersion": 2,
      "createdAt": "2026-10-10T05:20:00.000Z"
    }
  ],
  "nextCursor": "djE6Mg"
}
```

Do mais novo para o mais antigo. `limit` entre 1 e 200 (padrão 50); `cursor` é opaco e estável (baseado em `walletVersion`, sequência sem lacunas por wallet): as páginas não pulam nem repetem lançamentos enquanto novas movimentações chegam. Valores inválidos → `400 INVALID_LIMIT` / `INVALID_CURSOR`.

### 5. Reconciliação Financeira
```bash
curl -X POST http://localhost:3000/wallets/0192f291-27dd-7d3f-8071-5f8685deef37/reconciliation
```

**Resposta (200 OK):**
```json
{
  "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
  "storedBalance": { "amount": "975.00", "currency": "BRL" },
  "calculatedBalance": { "amount": "975.00", "currency": "BRL" },
  "difference": { "amount": "0.00", "currency": "BRL" },
  "consistent": true,
  "checkedEntries": 2,
  "transactionMismatches": 0
}
```

`consistent` exige saldo = soma do ledger **e** cada lançamento coerente com a transação que o originou (`transactionMismatches = 0`). O PostgreSQL já impede essas divergências no commit (`ARCHITECTURE.md`, seção 5); a reconciliação detecta as que vierem de escritas privilegiadas que desligam gatilhos. Divergência nunca é corrigida automaticamente: é logada, contada em `wagering_reconciliation_discrepancies_total` e devolvida com `consistent: false`.

### 6. Health Checks e Métricas (Abertos, sem autenticação)
```bash
curl http://localhost:3000/health/live    # processo vivo
curl http://localhost:3000/health/ready   # PostgreSQL e SQS alcançáveis (503 se não)
curl http://localhost:3000/metrics        # Prometheus
```

### 7. Fila SQS
Mensagens em `wager-transactions.fifo` usam o envelope do enunciado (`messageId`, `type`, `occurredAt`, `data` com `idempotencyKey`; `correlationId` opcional) e passam pelo **mesmo caso de uso** da API. Deduplicação persistente por `(consumerName, messageId)` na tabela `inbox_messages`, ack só após o commit, DLQ `wager-transactions-dlq.fifo` com o motivo em `FailureReason`.

---

## 📚 Documentação

- [`ARCHITECTURE.md`](ARCHITECTURE.md): decisões, trade-offs e limitações.
- [`docs/README.md`](docs/README.md): índice (ADRs, rastreabilidade com o enunciado, relatório de testes, runbook).
