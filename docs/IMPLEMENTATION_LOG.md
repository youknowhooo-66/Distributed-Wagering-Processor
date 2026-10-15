# Diário de Implementação e Correções (Implementation Log)

Data: 11/10/2026  
Escopo: Construção incremental e correções P0/P1/P2

---

## 1. Fases de Construção do Projeto

### Fase 1: Fundação do Domínio e Modelagem DDD
- Criação dos Value Objects `Money` (usando `Decimal.js`) e `Identifier` (UUID v7).
- Implementação dos agregados puros `Wallet`, `WalletLedgerEntry`, e `WagerTransaction`.
- Criação da máquina de estados para transações e validação estrita de referências em memória.

### Fase 2: Persistência e Infraestrutura Relacional
- Configuração do PostgreSQL 16 com MikroORM.
- Criação da migração inicial `Migration20260101000001_initial_schema.ts`.
- Mapeamento de entidades de infraestrutura (`WalletMikroEntity`, `WagerTransactionMikroEntity`, etc.) mantendo o domínio livre de decorators de ORM.

### Fase 3: Casos de Uso Transacionais e Concorrência
- Implementação do `ProcessWagerTransactionUseCase` com idempotência por hash canônico.
- Implementação do loop de retry otimista baseado em `WalletMikroEntity.version`.
- Implementação do `ReconcileWalletUseCase` para verificação contínua de integridade de saldo.

### Fase 4: Mensageria Assíncrona e Outbox Worker
- Provisionamento das filas SQS FIFO (`wager-transactions.fifo`, `wagering-events.fifo` e DLQ) via script `infra/localstack-init.sh`.
- Implementação do `SqsWagerConsumer` com deduplicação de mensagens via tabela `inbox_messages`.
- Implementação do `OutboxPublisherWorker` com leitura atômica via `SELECT ... FOR UPDATE SKIP LOCKED`.

---

## 2. Correções Realizadas (Plano P0 / P1 / P2)

### P0.1: Imutabilidade do Ledger Contábil no Banco
- **Problema**: A proteção de imutabilidade de `wallet_ledger_entries` dependia exclusivamente do código da aplicação, permitindo mutações via SQL direto.
- **Causa**: Ausência de constraints ou triggers ativas no PostgreSQL.
- **Correção**: Criação da migração reversível `Migration20261011000001_ledger_immutability.ts`, instalando uma trigger PL/pgSQL `trg_wallet_ledger_immutable` que aborta comandos `UPDATE` e `DELETE`.
- **Evidência**: Teste direto em `../src/test/integration/use-cases.spec.ts:L279` comprova que comandos `UPDATE` disparam exceção no banco.

### P0.2: Concorrência Destrutiva em Reversões Múltiplas
- **Problema**: Dois estornos (`REFUND` ou `ROLLBACK`) enviados em paralelo para a mesma aposta conseguiam passar simultaneamente se executados no mesmo milissegundo antes do commit.
- **Causa**: O índice anterior em `wager_transactions` não garantia unicidade estrita sob concorrência.
- **Correção**: Criação da migração reversível `Migration20261011000002_reversal_unique_index.ts`, aplicando o índice único parcial `uq_wager_reference_reversal` em `(reference_transaction_id, kind) WHERE status = 'PROCESSED'`.
- **Evidência**: Teste concorrente em `../src/test/concurrency/concurrent-bets.spec.ts:L245` aprovado.

### P0.3: Saldo Histórico no Replay Idempotente
- **Problema**: Quando o cliente repetia uma transação antiga, o sistema retornava o saldo atual da carteira em vez do saldo que resultou daquela transação específica.
- **Causa**: A tabela `wager_transactions` não armazenava a fotografia do saldo no instante do processamento.
- **Correção**: Criação da migração reversível `Migration20261011000003_wager_balance_after.ts`, adicionando a coluna `balance_after numeric(19,2)`. Atualização do `ProcessWagerTransactionUseCase` para gravar e devolver `balance_after`.
- **Evidência**: Teste em `../src/test/integration/use-cases.spec.ts:L306` aprovado para `BET`, `LOSS` e transações rejeitadas.

### P1.1: Alinhamento de Parâmetros e Placeholders no Outbox Worker
- **Problema**: O `OutboxPublisherWorker` utilizava placeholders de estilo `$1` que causavam falha de execução (`code 42P02`) no driver Knex do MikroORM.
- **Causa**: Mistura de sintaxe nativa do PostgreSQL com a camada de abstração do driver.
- **Correção**: Ajuste das consultas em `../src/wagering/infrastructure/messaging/outbox-publisher.worker.ts` para placeholders `?`.
- **Evidência**: Execução ponta a ponta comprovando 50 mensagens despachadas com sucesso e consumidas da fila SQS FIFO.

### P1.2: Cabeçalho HTTP `Retry-After` em 503 Service Unavailable
- **Problema**: Ao exceder o limite de retentativas otimistas, a exceção `ServiceUnavailableException` não anexava o cabeçalho padrão `Retry-After`.
- **Causa**: Ausência de interceptação/tratamento específico no controller HTTP.
- **Correção**: Adição de bloco de captura em `../src/wagering/infrastructure/http/wagering.controller.ts:L72`, emitindo explicitamente `Retry-After: 1`.

---

## Revisão de Prontidão — 12/10/2026

### P0-A: Aplicação não inicializava
- **Problema**: `NestFactory.create(AppModule)` falhava na injeção de dependências; 6 de 9 arquivos da suíte de integração encerravam com código 1 sem executar nenhum teste.
- **Causa**: o construtor de `SqsWagerConsumer` tinha parâmetros opcionais `string`, emitidos como `String` em `design:paramtypes`. O `dist/` em uso era anterior a essa mudança.
- **Correção**: construtor apenas com dependências injetáveis.
- **Evidência**: `../src/test/integration/bootstrap.spec.ts` sobe o AppModule completo com `abortOnError: false`.

### P0-B: Reenvio de `PENDING_REFERENCE` com payload diferente movimentava outro valor
- **Problema**: um REFUND de 10,00 pendente, reenviado com a mesma `Idempotency-Key`, valor 500,00 e a referência correta, foi processado e creditou 500,00.
- **Causa**: o hash do payload só era conferido para transações fora de `PENDING_REFERENCE`, e o crédito usava o valor do comando reenviado.
- **Correção**: hash conferido em qualquer estado; valor e referência sempre lidos da transação persistida.
- **Evidência**: `../src/test/integration/pending-reference-idempotency.spec.ts`.

### P0-C: Imagem Docker
- **Problema**: o build instalava apenas dependências de produção antes de `nest build` (CLI é devDependency); o compose não aplicava migrations; as URLs de fila apontavam para `localhost` dentro do container; sob Bun, o MikroORM procurava migrations em `src/`.
- **Correção**: Dockerfile multi-stage não-root com `HEALTHCHECK`, serviço `migrate` one-shot, URLs explícitas, `preferTs` condicionado à extensão do arquivo de configuração, nome de projeto fixo no compose.

### P1: Mensageria e validação
- Consumer: mensagem só sai da fila principal depois que a DLQ confirma; mensagens posteriores de um grupo cuja anterior falhou no lote voltam à fila; erros de domínio e 4xx vão direto à DLQ com `FailureReason`; limites de 5 (transitório) e 10 (contenção) recebimentos; `maxReceiveCount` do redrive 15.
- Outbox: coluna gerada `message_group_id` e lock consultivo por grupo (ADR-005).
- Validador de contrato compartilhado entre HTTP (400 `INVALID_PAYLOAD`) e SQS.
- **Evidência**: `../src/test/integration/messaging-ordering.spec.ts`, `../src/test/integration/http-validation.spec.ts`, `../src/test/unit/wager-payload.validator.spec.ts`; cada teste falha quando a correção correspondente é desativada.

### P2: Arquitetura, reconciliação, CI e operação
- Porta `UnitOfWork` com adaptador `MikroOrmUnitOfWork`; erros do PostgreSQL traduzidos por SQLSTATE (`23505`, `55P03`, `40P01`, `40001`); fluxo único no `ProcessWagerTransactionUseCase`.
- `RetryPendingReferencesUseCase`: uma transação por pendência, wallet travada antes de reler a pendência.
- Reconciliação em três vias (`transactionMismatches`).
- Encerramento: como PID 1 no container o processo ignorava o sinal re-emitido pelo Nest e terminava por SIGKILL (exit 137 após 10 s); agora encerra com `process.exit(0)` após `app.close()`.
- Testes: `(f.2-real)` causava deadlock entre a própria conexão e o `FOR UPDATE`; o teste de queda entre commit e ack passava sem que o processo filho processasse a mensagem — agora verifica `SIGKILL` e o commit; testes do worker de pendências passam a verificar as próprias transações, não o contador global.
- CI: `.github/workflows/ci.yml`; snapshots `.snapshot-disposable_*` deixam de ser gerados em `src/migrations`.

### Ajustes finais (12/10/2026)
- **Métricas mortas**: `wagering_pending_references_current`, `wagering_pending_references_resolved_total` e `wagering_reconciliation_discrepancies_total` eram expostas e documentadas, mas nunca atualizadas. Agora são alimentadas pela porta `WageringMetrics` (adaptador Prometheus), que também remove o último import de `infrastructure/` da camada de aplicação. **Evidência**: `../src/test/integration/metrics-wiring.spec.ts`.
- **Retenção**: `RetentionWorker` + `PurgeProcessedMessagesUseCase`, com expurgo em lotes, índices dedicados (`Migration20261012000002_retention_indexes.ts`) e retenção mínima do inbox de 15 dias. **Evidência**: `../src/test/integration/retention.spec.ts`.
- **Redrive da DLQ**: `bun run dlq:redrive` (dry-run por padrão, filtro por `FailureReason`, exclusão da DLQ só após o reenvio). A tabela do runbook indicava reprocessar `MAX_*_RECEIVES`, o que apenas devolveria o `FAILED` já registrado; corrigida. **Evidência**: `../src/test/integration/dlq-redrive.spec.ts` (filas FIFO dedicadas no LocalStack).
- **Alertas**: `infra/prometheus/alerts.yml` (8 regras) e `alerts.test.yml`, executados com `promtool` no CI.
- **Workers**: `PendingReferenceWorker` passa a respeitar `ENABLE_BACKGROUND_POLL`, como os demais (antes rodava durante os testes).
- **Tipagem**: 35 erros de tipagem estrita nos testes e 15 nos scripts corrigidos; `bun run typecheck` cobre produção, testes e scripts.

### UUID e desempenho (12/10/2026)
- **UUID em maiúsculas**: o PostgreSQL devolve UUIDs em minúsculas e as checagens de referência comparam texto. Um REFUND com `playerId` em maiúsculas era rejeitado como `CROSS_PLAYER_REFERENCE`, e a mesma requisição em caixa diferente virava 409 em vez de replay. Correção: normalização na entrada do caso de uso (HTTP, SQS e worker). **Evidência**: `../src/test/integration/uuid-case.spec.ts` (falhava antes da correção).
- **Idas ao banco com o lock da wallet**: de 10 para 6 por aposta — sem `SELECT` antes de inserir transação e eventos do outbox (identity map), eventos inseridos num único `INSERT`. Carga HTTP com 3 réplicas: p99 de 183 → ~124 ms (distribuído) e 419 → ~343 ms (hot wallet); vazão +43% e +27%. Detalhes em [TEST_REPORT.md](./TEST_REPORT.md), seção 2.
- **Evidência de carga**: a tabela de `load-summary.md` estava vazia (o teste deixara de imprimir conflitos e retentativas); o teste volta a medi-los pelos contadores Prometheus.

### Refinamento após comparação com outra solução (12/10/2026)
- **Idempotência por provedor**: `UNIQUE (provider_id, idempotency_key)`; antes, um provedor bloqueava a chave de outro. **Evidência**: `../src/test/integration/provider-scoped-idempotency.spec.ts` (falhava antes).
- **Ledger × transações imposto pelo banco**: gatilhos de restrição diferidos recusam no commit um lançamento divergente da transação e uma transação processada sem lançamento — a classe do bug P0-B deixa de poder ser gravada. Custo medido: 5–8% no p99 do teste de carga no processo (A/B com os gatilhos ligados e desligados).
- **Índice ausente**: `wager_transactions.wallet_id` não tinha índice; a reconciliação varria a tabela inteira com consulta paralela e esgotou a memória compartilhada do container (erro `53100`) sob testes concorrentes. Com o índice e o filtro por wallet: 0,1 ms. Postgres no compose com `shm_size: 256mb`.
- **Publisher do outbox**: grupos publicados em paralelo (ordem preservada dentro do grupo) e novo ciclo imediato enquanto houver trabalho; drenagem ~1,7× mais rápida. Na máquina local, com todos os serviços na mesma CPU, a drenagem contínua disputa CPU com as requisições durante carga máxima; em produção, publisher e API podem rodar em réplicas separadas.

---

## Revisão de Entrega (15/10/2026)

Revisão contra o enunciado com a suíte executada (detalhes e motivos em `docs/GAP_ANALYSIS.md`, seção 2).

- **Domínio:** regras da seção 7 extraídas para `src/wagering/domain/wager-rules.ts` (`checkReference`, `settle`, `checkWalletOwnership`); o teste de unidade que validava uma cópia da regra foi substituído por testes do código real.
- **Referências fora de ordem:** reversão cuja referência existe mas ainda aguarda passa a aguardar também (cadeias ROLLBACK → REFUND → BET resolvem); reenvio idêntico de transação em espera é replay sem efeito colateral; mensagem SQS em espera é registrada na inbox.
- **Titularidade:** `WALLET_PLAYER_MISMATCH` quando a wallet não pertence ao `playerId`.
- **Schema:** `wallet_version` nos lançamentos e gatilhos diferidos que pareiam saldo e ledger; guarda de `wager_transactions` (terminal imutável, colunas de negócio imutáveis, sem DELETE); `TRUNCATE` bloqueado (ADR-006).
- **HTTP:** `Idempotency-Key` obrigatório; `X-Correlation-Id` gerado/propagado até os eventos; `POST /wallets` validado e corrida → 409; IDs de rota, `limit` e cursor validados (400); cursor do ledger por `wallet_version`; `FAILED` → 500; PostgreSQL inalcançável → 503 + `Retry-After`.
- **Observabilidade:** todos os logs de aplicação estruturados com os identificadores exigidos; contador `wagering_transactions_total{status}`.
- **Operação:** healthcheck do LocalStack espera as filas; `load:http` mede conflitos, retries, outbox lag e drenagem.
- **Documentação:** rastreabilidade refeita contra o enunciado; `ARCHITECTURE.md` único (a cópia em `docs/` e o `AUDIT_REPORT.md` desatualizados foram removidos); taxonomia de falhas com a ação esperada do provedor.

