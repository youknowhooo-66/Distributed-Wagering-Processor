# Validação de 15/10/2026 (revisão de entrega)

Execução feita num workspace Linux (2 vCPU, 8 GB) para validar as correções desta revisão. O ambiente está descrito em `docs/TEST_REPORT.md`:
- PostgreSQL 16.15 real;
- SQS por emulador do protocolo JSON da AWS, porque o Docker Hub e o PyPI estavam bloqueados e não foi possível subir o LocalStack.

A evidência com LocalStack e Docker Compose é regenerada por `bun run scripts/collect-evidence.ts` e pelo CI.

## Suítes

```
bun run typecheck   -> 0 erros
bun run test:unit   -> 128 pass, 0 fail (10 arquivos)
bun run test:int    -> 106 pass, 0 fail (22 arquivos)
bun run test:e2e    ->   6 pass, 0 fail (2 arquivos)
bun run test:load   ->   4 pass, 0 fail (1 arquivo)
total               -> 244 pass, 0 fail (35 arquivos)
bun test (puro)     -> 244 pass, 0 fail (sem --timeout, suíte inteira num único processo)
```

Migrations: as 12 aplicadas; as duas novas revertidas e reaplicadas (`migration:down` ×2, `migration:up`) sobre o banco já populado pelos testes, com backfill de `wallet_version` sem erro.

## Smoke test: build de produção, 3 instâncias

`bun run build` e três processos `bun dist/main.js` (portas 3011, 3012, 3013; `NODE_ENV=production`; consumer, publisher e workers ligados) sobre o mesmo PostgreSQL e a mesma fila.

```
OK   wallet created on app-1
OK   two concurrent 80.00 bets on different instances -> 200,422
OK   loser rejected with INSUFFICIENT_BALANCE
OK   SQS message consumed and processed
OK   reconciliation consistent: 25.00, 3 entries
OK   events published: WagerTransactionProcessed, WalletBalanceChanged, WagerTransactionRejected
```

1. Wallet criada em `app-1`.
2. Duas apostas de 80,00 disparadas ao mesmo tempo em `app-2` e `app-3`. A wallet tinha saldo 100,00.
3. Uma mensagem WIN de 5,00 é enviada à fila `wager-transactions.fifo` e é consumida por uma das instâncias.
4. Reconciliação via `app-2`.
5. Leitura da fila `wagering-events.fifo`.
6. `SIGTERM` nas três instâncias: todas encerraram, com o log abaixo.

## Logs estruturados (amostra, uma linha por evento)

```
{"level":30,"time":1792043195125,"pid":3778,"hostname":"vm","req":{"id":"smoke-corr-2","method":"POST","url":"/wagering/transactions","headers":{"idempotency-key":"smoke:smoke-404975d6-eebd-4cd6-92c9-cd5ea6ae4599"}},"context":"ProcessWagerTransactionUseCase","msg":"wager transaction processed","durationMs":30,"correlationId":"smoke-corr-2","transactionId":"01a13e19-1adc-73fc-8538-1b40e5cfc787","walletId":"01a13e19-1aab-705d-ba8f-a1d87b47d5cf","providerId":"smoke","externalTransactionId":"smoke-404975d6-eebd-4cd6-92c9-cd5ea6ae4599","kind":"BET","status":"PROCESSED","idempotentReplay":false}
{"level":30,"time":1792043195244,"pid":3778,"hostname":"vm","context":"ProcessWagerTransactionUseCase","msg":"wager transaction processed","durationMs":34,"correlationId":"msg-smoke-sqs-9caf9613-fc5a-4abf-9670-24da238618fb","messageId":"msg-smoke-sqs-9caf9613-fc5a-4abf-9670-24da238618fb","transactionId":"01a13e19-1b57-77ec-b698-a2e7c86b60ee","walletId":"01a13e19-1aab-705d-ba8f-a1d87b47d5cf","providerId":"smoke","externalTransactionId":"smoke-sqs-9caf9613-fc5a-4abf-9670-24da238618fb","kind":"WIN","status":"PROCESSED","idempotentReplay":false}
{"level":40,"time":1792043195160,"pid":3780,"hostname":"vm","req":{"id":"smoke-corr-3","method":"POST","url":"/wagering/transactions","headers":{"idempotency-key":"smoke:smoke-259e3db3-5944-42b5-a7c0-8b93a739eb16"}},"context":"ProcessWagerTransactionUseCase","msg":"wager transaction rejected","durationMs":68,"correlationId":"smoke-corr-3","transactionId":"01a13e19-1afb-74b5-881e-f1c42b0355d5","walletId":"01a13e19-1aab-705d-ba8f-a1d87b47d5cf","providerId":"smoke","externalTransactionId":"smoke-259e3db3-5944-42b5-a7c0-8b93a739eb16","kind":"BET","status":"REJECTED","failureCode":"INSUFFICIENT_BALANCE","idempotentReplay":false}
{"level":30,"time":1792043196845,"pid":3776,"hostname":"vm","msg":"shutdown signal received: closing application","signal":"SIGTERM"}
{"level":30,"time":1792043196847,"pid":3776,"hostname":"vm","context":"SqsWagerConsumer","msg":"shutting down SQS consumer: finishing in-flight messages","inFlight":0}
```

Cada linha traz `correlationId` (do header `X-Correlation-Id` ou do `messageId` da mensagem), `messageId` quando veio da fila, `transactionId`, `walletId` e `providerId`, sem valores nem saldos.

## Carga HTTP contra as 3 instâncias

```
$ bun run load:http --vus 32 --seconds 15
$ bun run scripts/load-http.ts --vus "32" --seconds "15"
targets=http://localhost:3011,http://localhost:3012,http://localhost:3013 vus=32 seconds=15

| Cenário | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Erros | Conflitos de lock | Retries | Outbox lag máx (s) | Outbox pendente máx | Drenagem (s) |
|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| distributed | 2253 | 148.3 | 196 | 497 | 566 | 698 | 0.00% | 0 | 0 | 0 | 8.33 | 1276 | 1.8 |
| hot | 1809 | 118.9 | 241 | 545 | 714 | 1188 | 0.00% | 0 | 0 | 0 | 0.75 | 199 | 0.6 |
```

Varredura do banco após a carga:

| Verificação | Resultado |
|---|---|
| wallets com saldo negativo | 0 |
| quebras da cadeia `balance_before`/`balance_after` entre versões consecutivas | 0 |
| mensagens do outbox não publicadas | 0 |
| wallets com saldo ≠ soma do ledger | 4, todas as wallets corrompidas de propósito por `metrics-wiring` (gatilhos desligados para simular escrita privilegiada; saldo 51,00 × ledger 50,00) |
