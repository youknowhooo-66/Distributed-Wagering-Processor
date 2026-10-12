# Manual Breve do Desenvolvedor & Operador

O **Distributed Wagering Processor** é um motor transacional financeiro de alta precisão para processamento de apostas (iGaming). Ele processa débitos e créditos com precisão decimal arbitrária, garante imutabilidade contábil (ledger de lançamento único), previne saldo negativo concorrente e suporta resiliência a mensageria fora de ordem.

---

## 1. Como Subir e Executar

### 1.1 Pré-requisitos
- Docker & Docker Compose
- Bun `>= 1.1.0`

### 1.2 Comandos Essenciais
```bash
# 1. Iniciar infraestrutura local (PostgreSQL 16 + LocalStack 3)
docker compose up -d --wait postgres localstack

# 2. Executar migrações do banco
bun run migration:up

# 3. Executar suíte completa de testes (162 testes: 75 unit + 77 integração + 6 concorrência + 4 carga)
# Os scripts de teste definem ENABLE_BACKGROUND_POLL=false automaticamente
bun run typecheck    # tipos de produção, testes e scripts
bun run test:unit    # 75 testes — domínio puro e validação de contrato, sem I/O
bun run test:int     # 77 testes — PostgreSQL + LocalStack SQS reais
bun run test:e2e     # 6 testes  — paralelismo real multi-processo
bun run test:load    # 4 testes  — 50 BETs concorrentes, invariantes de saldo

# 4. Iniciar aplicação em modo desenvolvimento
# ENABLE_BACKGROUND_POLL=true é o padrão — o consumer SQS inicia automaticamente
bun run dev
```

### Variáveis de Ambiente Críticas

| Variável | Padrão | Descrição |
|---|---|---|
| `ENABLE_BACKGROUND_POLL` | `true` | Liga/desliga o consumer SQS em background. **Deve ser `true` em produção** (configurado no `docker-compose.yml`). Testes automatizados definem como `false` para evitar loops de polling. |
| `DATABASE_URL` | — | URL de conexão PostgreSQL 16. |
| `SQS_ENDPOINT` | — | Endpoint do SQS (LocalStack em dev: `http://localhost:4566`). |

Copie `.env.example` para `.env` e ajuste os valores para o seu ambiente.

---

## 2. Arquitetura em um Diagrama

```mermaid
flowchart TD
    Client([Game Provider / Client]) -->|POST /wagering/transactions| HTTP[Wagering Controller]
    SQS_Consumer[SQS Consumer FIFO] -->|Consume| UC[ProcessWagerTransactionUseCase]
    HTTP -->|Execute| UC

    subgraph Core Transacional [PostgreSQL 16 Transaction]
        UC -->|1. Idempotency Check| WagerRepo[(wager_transactions)]
        UC -->|2. Check Balance & Version| WalletRepo[(wallets)]
        UC -->|3. Append Immutably| LedgerRepo[(wallet_ledger_entries)]
        UC -->|4. Trigger Enforces No UPDATE/DELETE| LedgerTrig{{trg_prevent_ledger_mutation}}
        UC -->|5. Enqueue Outbox Event| OutboxRepo[(outbox_messages)]
    end

    subgraph Assíncrono [Messaging Workers]
        OutboxWorker[OutboxPublisherWorker] -->|POLL lock por wallet| OutboxRepo
        OutboxWorker -->|Publish Event| SQS_FIFO[AWS SQS: wagering-events.fifo]
        RetryWorker[RetryPendingReferencesWorker] -->|Resolve PENDING_REFERENCE| WagerRepo
    end
```

---

## 3. Fluxo de Execução de uma Aposta (`BET`)

1. **Idempotency & Deduplicação**:
   - O cliente envia `Idempotency-Key` e corpo JSON com `providerId` e `externalTransactionId`.
   - O processador calcula o hash canônico SHA-256 (`payload_hash`).
   - Se já existe registro no banco com a mesma chave:
     - Se o payload é idêntico: retorna resposta original gravada com saldo histórico (`balance_after`).
     - Se o payload difere: retorna HTTP 409 (`IdempotencyConflictError`).
2. **Mutação Otimista & Ledger**:
   - Carrega o agregado `Wallet` e valida moeda e saldo.
   - Aplica débito no domínio e incrementa `version`.
   - Grava entrada no `wallet_ledger_entries` com `direction: DEBIT`, calculando `balance_before` e `balance_after`.
   - Se duas requisições concorrentes tentarem atualizar a mesma versão de `Wallet`, o PostgreSQL/MikroORM dispara `OptimisticLockError`. O use-case aplica retentativas com jitter exponencial (até 6 tentativas). Se esgotar, retorna HTTP 503 com cabeçalho `Retry-After: 1`.
3. **Outbox Pattern**:
   - Cria evento de domínio `WalletBalanceChanged` persistido na tabela `outbox_messages` dentro da mesma transação ACID.
   - `OutboxPublisherWorker` publica em `wagering-events.fifo` no SQS em ordem por wallet: um publisher por wallet de cada vez (lock consultivo), parando na primeira mensagem com falha.

---

## 4. Conceitos-Chave e Glossário

| Termo | Definição |
| :--- | :--- |
| **Ledger de Lançamento Único** | Registro contábil onde toda mutação de saldo gera uma linha imutável com `balance_before` e `balance_after`. O saldo da carteira é matematicamente igual à soma algébrica do ledger. |
| **Lock por Linha (`FOR UPDATE`)** | Mecanismo de concorrência adotado: a linha da wallet é travada no início da transação, serializando operações da mesma wallet. A coluna `version` permanece como barreira adicional. |
| **Idempotency-Key** | Identificador único da intenção do cliente, prevenindo cobranças duplicadas em caso de retransmissão de rede. |
| **Transactional Outbox** | Padrão onde eventos são gravados na mesma transação atômica do banco de dados antes de serem despachados ao broker. |
| **PENDING_REFERENCE** | Estado de transação para reversões (`REFUND`/`ROLLBACK`) que chegaram à fila antes da aposta original (`BET`). |

---

## 5. Onde Mexer no Código

- **Regras de Negócio e Domínio Puro**:
  - `src/wallet/domain/`: Agregados `Wallet` e `WalletLedgerEntry`. Não adicionar dependências de framework aqui.
  - `src/wagering/domain/`: Agregado `WagerTransaction` e cálculo de referências.
  - `src/shared/domain/value-objects/`: Objeto de valor monetário `Money` (usando `Decimal.js`).
- **Casos de Uso**:
  - `src/wagering/application/use-cases/process-wager-transaction.use-case.ts`: Orquestração transacional de apostas.
  - `src/wallet/application/use-cases/reconcile-wallet.use-case.ts`: Auditoria e checagem matemática de saldos.
- **Persistência e Migrações**:
  - `src/migrations/`: Migrações versionadas MikroORM com scripts `up()` e `down()`.
