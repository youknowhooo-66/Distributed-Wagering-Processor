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
| **Log Estruturado** | Pino / nestjs-pino | Logs em JSON com correlationId e sem dados sensíveis |

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

# Todos os testes (162)
bun run test

# Unitários (75): Money, Wallet, WagerTransaction, hash canônico, validação de contrato
bun run test:unit

# Integração (77): atomicidade, idempotência, reversões, reconciliação, SQS/DLQ, redrive, outbox, retenção, métricas, HTTP
bun run test:int

# Concorrência (6): 3 processos disputando a mesma wallet, 50 requisições paralelas
bun run test:e2e

# Carga (4)
bun run test:load
```

Operação: `bun run dlq:redrive --reason <FailureReason> [--execute]` reenvia mensagens selecionadas da DLQ (ver `docs/OPERATIONS_RUNBOOK.md`); o expurgo de outbox/inbox é automático (`OUTBOX_RETENTION_DAYS`, `INBOX_RETENTION_DAYS`); as regras de alerta estão em `infra/prometheus/alerts.yml`.

Carga HTTP contra as 3 réplicas: `bun run load:http` (resultados e leitura do p99 em `docs/TEST_REPORT.md`).

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
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-101" \
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
      "createdAt": "2026-10-10T05:20:00.000Z"
    }
  ],
  "nextCursor": "MjAyNi0xMC0xMFQwNToyMDowMC4wMDBafDAxYTEyNDQ3..."
}
```

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

`consistent` exige saldo = soma do ledger **e** cada lançamento coerente com a transação que o originou (`transactionMismatches = 0`).

### 6. Health Checks (Abertos, sem autenticação)
```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```
