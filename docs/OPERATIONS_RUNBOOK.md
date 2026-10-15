# Guia de Operações e Runbook de Produção (Operations Runbook)

Data: 11/10/2026  
Escopo: Distributed Wagering Processor

---

## 1. Inicialização e Comandos Operacionais

### 1.1 Inicialização de Infraestrutura
```bash
docker compose up -d --build --wait   # migrate (one-shot) -> app-1..3 só sobem após migração OK
docker compose ps
```

Encerramento: `docker compose stop app-1 app-2 app-3` deve terminar em poucos segundos com código de saída 0. Saída 137 indica SIGKILL por fim do prazo de encerramento: investigar o desligamento gracioso.

### 1.2 Migrações e Verificação de Schemas
```bash
# Aplicar migrações
bun run migration:up

# Reverter última migração (se necessário)
bun run migration:down

# Validar trigger de imutabilidade do ledger
docker exec jungle-postgres psql -U jungle -d wagering -c "SELECT tgname FROM pg_trigger WHERE tgname = 'trg_wallet_ledger_immutable';"

# Validar índice único estrito de reversão
docker exec jungle-postgres psql -U jungle -d wagering -c "\d wager_transactions"
```

---

## 2. Métricas Reais Expostas via Prometheus (`GET /metrics`)

Todas as métricas operacionais expostas utilizam o prefixo `wagering_`:

| Métrica Real | Tipo | Descrição |
| :--- | :---: | :--- |
| `wagering_transactions_processed_total{kind}` | Counter | Total de transações processadas com sucesso. |
| `wagering_transactions_rejected_total{kind, failure_code}` | Counter | Total de transações rejeitadas por regras de domínio. |
| `wagering_transactions_failed_total{kind}` | Counter | Transações que alcançaram falha irrecuperável (`FAILED`). |
| `wagering_idempotent_replays_total{kind}` | Counter | Total de repetições idempotentes atendidas. |
| `wagering_pending_references_resolved_total` | Counter | Total de transações fora de ordem resolvidas. |
| `wagering_reconciliation_discrepancies_total` | Counter | Total de divergências contábeis detectadas. |
| `wagering_optimistic_lock_conflicts_total` | Counter | Total de colisões de versão detectadas sob concorrência. |
| `wagering_retry_attempts_total{type}` | Counter | Retentativas executadas (`optimistic_lock`/`lock_timeout` no caso de uso; `lock_contention`/`sqs_transient_error` no consumer SQS). |
| `wagering_dlq_messages_total` | Counter | Mensagens encaminhadas para a Dead Letter Queue. |
| `wagering_transactions_total{kind,status}` | Counter | Transações por status resultante (`PROCESSED`, `REJECTED`, `PENDING_REFERENCE`, `FAILED`), sem replays. |
| `wagering_transaction_processing_duration_ms` | Histogram | Latência fim-a-fim da operação por tipo de aposta. |
| `wagering_outbox_pending_messages` | Gauge | Quantidade de mensagens pendentes na outbox. |
| `wagering_outbox_lag_seconds` | Gauge | Idade em segundos da mensagem não publicada mais antiga. |

---

## 3. Catálogo de Códigos de Falha (`FailureCode`)

Lista exata no enum `src/shared/domain/errors/failure-codes.ts`. A tabela completa, com status HTTP e ação esperada do provedor, está em `ARCHITECTURE.md` §11. Resumo para triagem:

- **Saldo:** `INSUFFICIENT_BALANCE` (BET sem saldo), `REVERSAL_INSUFFICIENT_BALANCE` (ROLLBACK de WIN/REFUND deixaria saldo negativo; escalar, não é erro do jogador).
- **Referência:** `REFERENCE_TIMEOUT` (não chegou em 10 tentativas), `REFERENCE_NOT_PROCESSED` (referência terminou `REJECTED`/`FAILED`), `REFERENCE_ALREADY_REVERSED`, `INVALID_REFERENCE_KIND`, `REVERSAL_AMOUNT_MISMATCH`, `CROSS_PROVIDER_REFERENCE`, `CROSS_PLAYER_REFERENCE`, `CROSS_WALLET_REFERENCE`, `CROSS_ROUND_REFERENCE`.
- **Contexto:** `CURRENCY_MISMATCH`, `WALLET_PLAYER_MISMATCH` (wallet de outro jogador).
- **Infraestrutura:** `PERMANENT_PROCESSING_ERROR` (transação `FAILED` pelo consumer; a mensagem está na DLQ com `FailureReason=MAX_*_RECEIVES`).

Para investigar uma transação: filtrar os logs por `correlationId` (header `X-Correlation-Id` devolvido ao provedor, ou `messageId` da fila). Todas as linhas daquela requisição, inclusive os eventos da outbox (`payload.correlationId`), carregam o mesmo valor.

---

## 4. Procedimentos Operacionais de Emergência

### 4.1 Inspeção e Redrive da Dead Letter Queue (DLQ)
Toda mensagem na DLQ traz o atributo `FailureReason`, que indica se faz sentido reprocessar:

| `FailureReason` | Significado | Reprocessar? |
| :--- | :--- | :--- |
| `MALFORMED_JSON`, `INVALID_CONTRACT` | Payload fora do contrato | Não — corrigir na origem e reenviar nova mensagem |
| `HTTP_404` | Wallet inexistente | Sim, após criar a wallet |
| `HTTP_409`, `IDEMPOTENCY_CONFLICT` | Colisão de ID externo ou mesma chave com payload diferente | Não — investigar o provedor |
| `MAX_TRANSIENT_RECEIVES`, `MAX_CONTENTION_RECEIVES` | Falhas temporárias repetidas; a transação foi gravada como `FAILED` (terminal) e o evento `WagerTransactionFailed` foi publicado | Não — um reenvio só devolveria o resultado `FAILED`; o provedor reenvia como nova transação |

Redrive com a ferramenta do projeto (dry-run por padrão; só move os motivos indicados e só apaga da DLQ depois que a fila principal confirmou):

```bash
bun run dlq:redrive --reason HTTP_404            # lista o que seria movido
bun run dlq:redrive --reason HTTP_404 --execute  # move de volta para wager-transactions.fifo
```

Em filas FIFO, uma mensagem ignorada segura as seguintes do mesmo grupo nesta execução; a ferramenta lista esses grupos ao final.

Procedimento manual equivalente (LocalStack):

```bash
# Inspecionar mensagens na DLQ (com o motivo)
docker exec jungle-localstack awslocal sqs receive-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --max-number-of-messages 10 --message-attribute-names FailureReason

# Redrive manual: republicar na fila principal após correção
docker exec jungle-localstack awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-body '{"messageId":"...","type":"ProcessWager",...}' \
  --message-group-id "UUID_DA_CARTEIRA" \
  --message-deduplication-id "UUID_DO_EVENTO"

# Deletar mensagem da DLQ após envio
docker exec jungle-localstack awslocal sqs delete-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions-dlq.fifo \
  --receipt-handle "RECEIPT_HANDLE"
```

### 4.2 Retenção de Outbox e Inbox

O `RetentionWorker` roda a cada `RETENTION_INTERVAL_MS` (padrão 1 h) e remove em lotes de 1000 linhas:
- `outbox_messages` publicadas há mais de `OUTBOX_RETENTION_DAYS` (padrão 7);
- `inbox_messages` processadas há mais de `INBOX_RETENTION_DAYS` (padrão 30). Valores abaixo de 15 são recusados na inicialização: o inbox precisa sobreviver à retenção máxima do SQS (14 dias) para deduplicar reentregas.

Mensagens não publicadas e registros não processados nunca são removidos.

### 4.3 Alertas

As regras estão em `infra/prometheus/alerts.yml` (job de scrape `wagering`). Primeira ação por alerta:

| Alerta | Severidade | Primeira ação |
| :--- | :---: | :--- |
| `WageringReconciliationDiscrepancy` | critical | Rodar `POST /wallets/:id/reconciliation` nas wallets afetadas; ver `transactionMismatches` e o log `RECONCILIATION_DISCREPANCY` |
| `WageringOutboxLagHigh` | critical | Verificar conectividade com o SQS e o log `Failed to publish outbox message` (seção 4.4) |
| `WageringInstanceDown` | critical | `docker compose ps` / estado do pod; `/health/ready` |
| `WageringDlqMessages` | warning | Inspecionar `FailureReason` (seção 4.1) |
| `WageringTransactionsFailed` | warning | Correlacionar com `MAX_*_RECEIVES` na DLQ e com a causa do erro transitório |
| `WageringConcurrencyExhausted` | warning | Hot wallet ou `lock_timeout` curto demais; ver `wagering_retry_attempts_total{type}` |
| `WageringPendingReferencesHigh` | warning | Provedor enviando reversões sem a transação original; checar `REFERENCE_TIMEOUT` |
| `WageringLatencyP95High` | warning | Contenção no PostgreSQL (locks, conexões) |

### 4.4 Diagnóstico de Mensagens Presas na Outbox
```sql
SELECT id, aggregate_id, event_type, attempts, next_attempt_at, occurred_at
FROM outbox_messages
WHERE published_at IS NULL
ORDER BY occurred_at ASC
LIMIT 20;
```
Se `next_attempt_at` estiver no futuro e `attempts > 5`, verificar conectividade com o endpoint SQS LocalStack/AWS.
