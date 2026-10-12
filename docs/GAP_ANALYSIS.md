# Gap Analysis — Estado do Código vs. Enunciado do Desafio

Data: 11/10/2026
Fonte de verdade: enunciado do desafio (contexto do projeto). Onde a documentação existente diverge do enunciado, vale o enunciado.

## Como ler este relatório

- Análise estática: li o código de `src/`, as migrations, `docker-compose.yml`, `Dockerfile` e os docs existentes.
- **Não executei** testes, build ou Docker. A máquina vinculada não tem `bun` nem `docker`. Os números de teste abaixo vêm da contagem de `it(...)` no código e da leitura de `docs/evidence/`.
- Itens marcados **[a validar]** são risco apontado pela leitura do código e ainda não reproduzido.
- Nenhum arquivo do código foi alterado. Nada foi commitado nem enviado ao GitHub.

---

## 1. Veredito geral

O núcleo financeiro está sólido e cobre os pontos eliminatórios do enunciado. Os gaps estão em validação de entrada, observabilidade, consistência da documentação, higiene do repositório e alguns detalhes de mensageria.

**Estimativa pela tabela da seção 14 (subjetiva, a banca decide): ~78/100.**

| Área | Peso | Estimado | Principal motivo do desconto |
|---|---:|---:|---|
| Correção financeira | 20 | 17 | índice de reversão mais estrito que o enunciado; validação de entrada incompleta (500 em vez de 400) |
| Concorrência | 20 | 18 | corrida na criação de wallet vira 500; worker de PENDING_REFERENCE processa várias wallets numa só transação |
| Idempotência | 15 | 13 | `Idempotency-Key` não é obrigatório; conflito não detectado para tx em `PENDING_REFERENCE` |
| Mensageria e falhas | 15 | 12 | erros permanentes tratados como transitórios; cadeia de reversões fora de ordem pode ser rejeitada cedo demais |
| Modelagem e arquitetura | 10 | 6 | use case acoplado a ORM, framework e métricas; ~200 linhas duplicadas; portas existem mas não são usadas |
| Testes | 10 | 8 | cobertura forte; faltam testes de unidade das regras por `kind` e das validações de borda |
| Observabilidade | 5 | 2 | logs sem campos estruturados; métrica de divergência de reconciliação nunca incrementada |
| Documentação | 5 | 2 | docs se contradizem sobre a estratégia de lock; matriz de rastreabilidade usa rubrica inventada |

---

## 2. Falhas eliminatórias (seção 14 do enunciado)

| Falha eliminatória | Situação | Evidência |
|---|---|---|
| `number` para dinheiro | Não ocorre | `Money` sobre `decimal.js`; colunas `NUMERIC(19,2)`; os únicos `Number(...)` são de contadores e métricas |
| Saldo negativo por race | Não ocorre | `SELECT ... FOR UPDATE` na wallet + `CHECK balance_amount >= 0` |
| Débito ou crédito duplicado | Não ocorre | `uq_wager_idempotency_key`, `uq_wager_provider_external`, `uq_ledger_transaction` |
| Idempotência só em memória | Não ocorre | Persistida em `wager_transactions` e `inbox_messages` |
| Correto só com uma instância | Não ocorre | Lock no banco; teste com 3 processos |
| Evento publicado antes do commit | Não ocorre | Outbox gravado na mesma transação SQL |
| Ausência de ledger auditável | Não ocorre | `wallet_ledger_entries` + trigger de imutabilidade |
| Testes que trocam PostgreSQL e SQS por mocks | Não ocorre | Testes usam Postgres e LocalStack reais |

---

## 3. Restrições invioláveis (seção 5)

| # | Restrição | Situação |
|---|---|---|
| 1 | Sem `number`/float para dinheiro | Atendida |
| 2 | Sem cache em memória como idempotência | Atendida |
| 3 | Não confiar só em SQS FIFO | Atendida (o banco garante as invariantes) |
| 4 | Não publicar antes do commit | Atendida |
| 5 | Não sobrescrever nem excluir ledger | Atendida (trigger `trg_wallet_ledger_immutable`) |
| 6 | Sem lock global | Atendida (lock por linha da wallet) |
| 7 | Sem `read → calculate → update` sem controle | Atendida |
| 8 | Correta com múltiplas instâncias | Atendida (teste com 3 processos) |
| 9 | Unicidade, imutabilidade e não-negatividade no schema | Atendida (UNIQUEs, CHECKs, índice parcial, trigger) |

---

## 4. Gaps por prioridade

### P0 — Corrigir antes da entrega

**G01. Documentação contradiz o código sobre concorrência.**
- O código usa lock pessimista por linha (`LockMode.PESSIMISTIC_WRITE`). O ADR-001 descreve isso corretamente.
- `ARCHITECTURE.md` (raiz e `docs/`, idênticos), `AUDIT_REPORT.md`, `TEST_REPORT.md`, `COMMIT_PLAN.md` e `docs/README.md` ainda descrevem lock otimista, com retry e 503 sob contenção.
- O enunciado exige que a estratégia seja justificada em `ARCHITECTURE.md`. Hoje o documento principal justifica a estratégia errada.
- Ação: reescrever a seção 3 do `ARCHITECTURE.md` com o lock pessimista. Citar `version` e o `CHECK` como barreiras adicionais. Alinhar os demais docs.

**G02. `REQUIREMENTS_TRACEABILITY.md` não usa a rubrica do enunciado.**
- Os pesos listados (20/20/15/15/10/10/5/5) e as áreas não são os da seção 14.
- As "9 restrições" e as "8 falhas eliminatórias" têm textos diferentes dos do enunciado.
- Ação: refazer a matriz com as seções 5, 6, 7, 8, 9, 10, 11, 12, 13 e 14 do enunciado. Este relatório serve de base.

**G03. `TEST_REPORT.md` cita testes inexistentes e números que não batem.**
- Cita `http-e2e.spec.ts` e `sqs-consumer-dedup.spec.ts`, que não existem. Os arquivos reais são `http-endpoints.spec.ts` e `consumer-inbox-dedup.spec.ts`.
- Contagem real de `it(...)`: unit 56, integration 45, concurrency 6, load 4. O relatório informa 44 de integração e 1 de carga.
- Ação: regenerar o relatório a partir de uma execução real e corrigir os nomes.

**G04. `Idempotency-Key` não é obrigatório.**
- O enunciado diz que o header é obrigatório e é a fonte da verdade.
- O controller usa `idempotencyKeyHeader || providerId:externalTransactionId`. O `if (!idempotencyKey)` seguinte é código morto.
- Ação: sem header, responder 400. Opcional: validar que a key coincide com o padrão recomendado ou registrar a divergência.

**G05. Validação de entrada incompleta, gerando 500 onde deveria ser 400.**
- Não há `ValidationPipe` nem DTOs. `class-validator` está instalado e não é usado.
- `kind` inválido não é validado e chega ao `CHECK chk_wager_kind`, que resulta em 500. **[a validar]**
- BET de `0.00` viola `chk_ledger_amount_positive`, também 500. **[a validar]**
- `walletId` ou `playerId` que não sejam UUID geram erro de cast no Postgres. **[a validar]**
- O enunciado pede distinguir payload inválido (400) de falha transitória (503).
- `playerId` do payload não é comparado com o `playerId` da wallet.
- Ação: validar tudo na borda (HTTP e SQS) com 400 / descarte terminal.

**G06. Logs não são estruturados com os campos exigidos.**
- O enunciado pede JSON com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`.
- O código usa `Logger` do Nest com strings livres. O `pino-http` só registra a requisição.
- Em desenvolvimento, `pino-pretty` troca o formato.
- Ação: logar objetos (`logger.log({ msg, correlationId, ... })`) nos use cases, no consumer e nos workers. Propagar `x-correlation-id`.

**G07. Divergência de reconciliação não é contabilizada em métrica.**
- O enunciado diz que divergências devem ser logadas, contabilizadas em métrica e sinalizadas na resposta.
- `reconciliationDiscrepancies` existe em `metrics.controller.ts`, mas `ReconcileWalletUseCase` nunca o incrementa.
- Também nunca são atualizados: `pendingReferencesGauge` e `pendingReferencesResolved`.
- Ação: incrementar os contadores e atualizar o gauge de pendências.

**G08. Repositório sem higiene para o commit final.**
- Não existe `.gitignore`. `node_modules/`, `dist/` e `.DS_Store` aparecem como não rastreados.
- Há 13 arquivos `src/migrations/.snapshot-disposable_*.json` gerados por testes. Devem ser removidos e ignorados.
- `ARCHITECTURE.md` existe duplicado na raiz e em `docs/`.
- `docs/COMMIT_PLAN.md` afirma que não havia Git, mas já existe o commit `c2eb70a first commit`.
- `docs/evidence/` tem ~30 logs de rodadas de carga. Manter só o consolidado.

### P1 — Importante

**G09. Índice de unicidade de reversão mais estrito que o enunciado.**
- Regra 4: "uma referência não pode ser revertida duas vezes pelo **mesmo tipo** de operação".
- A migration `...0004` criou `UNIQUE (reference_transaction_id) WHERE PROCESSED AND kind IN (REFUND, ROLLBACK)`. Uma BET passa a aceitar no máximo **uma** reversão de qualquer tipo.
- É uma interpretação defensável, porque evita devolver a mesma aposta duas vezes. O enunciado permite interpretações desde que documentadas.
- O ADR-003 e o `AUDIT_REPORT` ainda descrevem o índice `(reference_transaction_id, kind)`.
- Ação: manter e documentar a interpretação no ADR-003 e no `ARCHITECTURE.md`, ou voltar ao índice por `kind`.

**G10. Cadeia de reversões fora de ordem pode ser rejeitada cedo demais.**
- `validateReference` devolve `REFERENCE_NOT_PROCESSED` (terminal) quando a referência existe mas está `PENDING_REFERENCE`.
- Exemplo: ROLLBACK chega quando o REFUND ainda aguarda a BET. Esse ROLLBACK é rejeitado, embora fosse válido minutos depois.
- Ação: se a referência estiver `PENDING` ou `PENDING_REFERENCE`, manter o item em `PENDING_REFERENCE`. Rejeitar só se a referência for terminal e não `PROCESSED`.

**G11. Reenvio de transação em `PENDING_REFERENCE`.**
- O replay com a mesma key reprocessa a transação em vez de devolver o resultado.
- A checagem de payload divergente é ignorada nesse estado.
- Cada reenvio incrementa `retryCount` e emite novo `WagerTransactionPendingReference`.
- Ação: validar o hash também nesse estado. Só reprocessar se a referência tiver chegado.

**G12. Criação concorrente de wallet vira 500.**
- `OpenWalletUseCase` faz check-then-insert e devolve 409 só no caminho sequencial.
- Duas requisições simultâneas violam `uq_wallets_player_currency` e retornam 500. **[a validar]**
- Ação: capturar o código `23505` e responder 409.

**G13. `RetryPendingReferencesUseCase` processa até 20 transações, de wallets diferentes, numa única transação SQL.**
- Dois workers com ordens de lock diferentes podem gerar deadlock. **[a validar]**
- Um erro SQL dentro do `try/catch` deixa a transação do Postgres abortada, e as consultas seguintes falham.
- Ação: uma transação por item, reaproveitando o fluxo normal com lock da wallet.

**G14. Consumer SQS trata erros permanentes como transitórios.**
- `NotFoundException` (wallet inexistente) e `BadRequestException` (OPENING) são `HttpException`, não `DomainError`. Passam por 5 retries com backoff antes da DLQ.
- Ação: classificar como permanente e enviar direto à DLQ.
- `IdempotencyConflictError` é confirmada (ack) sem registro, métrica ou log estruturado. Registrar.
- O `payloadHash` do inbox é gravado e nunca comparado. Mesmo `messageId` com payload diferente passa sem alerta.

**G15. Arquitetura: boundaries parcialmente quebrados.**
- `ProcessWagerTransactionUseCase` (769 linhas) depende de `EntityManager`, repositórios concretos, exceções HTTP do Nest e `prom-client`.
- `executeWithinTransaction` duplica ~200 linhas de `executeTransactional` e já divergiu: não grava inbox e não emite métricas.
- As portas `WalletRepositoryPort` e `WagerTransactionRepositoryPort` existem, mas os use cases não as usam.
- A regra por `kind` (BET/WIN/LOSS/REFUND/ROLLBACK) e `validateReference` ficam no use case, não no domínio.
- Ação: extrair um serviço de domínio ou método no agregado, unificar os dois métodos e injetar portas.

**G16. Dockerfile e Compose: execução em containers não comprovada.**
- O estágio de build roda `bun install --production` e depois `bun run build` (`nest build`). `@nestjs/cli` e `typescript` são devDependencies. **[a validar]**
- O estágio final usa `bun:1-slim` e `CMD bun run start:prod`, que executa `node dist/main`. A imagem slim pode não ter `node`. **[a validar]**
- Os serviços `app-1..3` não executam migrations. Sem o passo manual de `migration:up`, as tabelas não existem.
- A evidência `docker-compose-ps-running.log` mostra os containers com "Up 5 seconds", sem prova de que permaneceram saudáveis.
- Ação: validar `docker compose up --build` do zero. Adicionar serviço ou entrypoint de migration e healthcheck nos apps.

### P2 — Polimento

- **G17.** `FailureCode.REVERSAL_WOULD_CAUSE_NEGATIVE_BALANCE` é alias do mesmo valor de `REVERSAL_INSUFFICIENT_BALANCE`. Remover o alias ou documentar.
- **G18.** Replay de transação `FAILED` via HTTP devolve 200. Definir o status HTTP para `FAILED` (por exemplo 500 ou 503 com `failureCode`).
- **G19.** Ledger: `limit` inválido (`NaN`, negativo, enorme) e cursor inválido não geram 400. O cursor é ignorado sem aviso. `createdAt` vem do relógio da aplicação, e há risco de skew entre instâncias na ordenação.
- **G20.** `PendingReferenceWorker` ignora `ENABLE_BACKGROUND_POLL=false`. Pode interferir nos testes.
- **G21.** `OutboxMessage.markPublished/scheduleRetry/isDue` existem, mas o worker usa `knex` cru e duplica a regra de backoff. O worker mantém a transação e os locks abertos durante as chamadas ao SQS.
- **G22.** `WagerTransaction.reject()` e `fail()` usam `new Date()` interno. Passar `at` como nas outras transições.
- **G23.** `WagerTransaction.create` lança `Error` genérico quando falta a referência. Usar erro de domínio.
- **G24.** Teste de carga (`bun run test:load`): `docs/evidence/load-2026-10-11.md` não traz throughput, taxa de erro nem outbox lag, que o enunciado pede registrar. Parte dos números antigos vem da época do lock otimista.
- **G25.** `docker-compose.yml` usa `version: "3.9"` (obsoleto). Falta o campo `region` nas filas e uma nota de portas (3011–3013).

---

## 5. Regras de negócio (seção 7)

| Regra | Situação |
|---|---|
| BET debita, 1 lançamento `DEBIT`, rejeita saldo insuficiente | Atendida |
| WIN credita, 1 lançamento `CREDIT` | Atendida |
| LOSS sem saldo e sem ledger, mas com evento `Processed` | Atendida |
| REFUND só referencia BET `PROCESSED`, uma vez | Atendida (mais estrita, ver G09) |
| ROLLBACK referencia BET, WIN ou REFUND, valor igual, uma vez | Atendida (mais estrita, ver G09) |
| REFUND/ROLLBACK exigem `referenceExternalTransactionId` | Atendida (CHECK no schema + domínio) |
| Referência do mesmo provider, player, wallet, moeda e rodada | Atendida (`CROSS_*`, `CURRENCY_MISMATCH`) |
| REJECTED não altera saldo nem gera ledger | Atendida |
| Replay devolve o resultado original com o saldo da época | Atendida (`balance_after`) |
| Referência ausente vira `PENDING_REFERENCE` | Atendida (com a ressalva do G10) |
| Reversão que zeraria o saldo é rejeitada com código próprio | Atendida (`REVERSAL_INSUFFICIENT_BALANCE`) |
| Worker com backoff, limite e `REJECTED` com `REFERENCE_TIMEOUT` + evento | Atendida (10 tentativas, backoff 2^n s com teto de 300 s) |
| Taxonomia de `failureCode` documentada | Atendida (`ARCHITECTURE.md` seção 11) |

## 6. Domínio (seção 6)

| Item | Situação |
|---|---|
| `Money` imutável, string decimal, escala 2, rejeição de NaN/Infinity/notação científica/>2 casas/negativos | Atendido |
| `Money` sem dependência de ORM ou Nest | Atendido |
| Construtor privado + `create`/`from`/`rehydrate` | Atendido |
| `Wallet`: uma por `playerId+currency`, saldo ≥ 0, `version` começa em 1 e só sobe quando o saldo muda | Atendido |
| `WalletLedgerEntry` imutável com `isBalanced()` validado na factory | Atendido |
| `WagerTransaction` com máquina de estados e terminais | Atendido |
| `InboxMessage` / `OutboxMessage` | Atendido (ver G21) |
| `IntegrationEvent` abstrata com subclasses e `version` | Atendido (`WagerTransactionFailed` é extra) |
| OPENING interno, na mesma transação, com `CREDIT` | Atendido |

## 7. Concorrência, API, mensageria e outbox

| Item | Situação |
|---|---|
| Cenário obrigatório (100,00; duas apostas de 80,00) | Testado em `concurrent-bets.spec.ts` |
| Mesma aposta 50 vezes em paralelo | Testado |
| Wallets distintas em paralelo | Testado |
| ≥ 3 processos simultâneos | Testado (`multiprocess-concurrency.spec.ts`) |
| Worker morto após commit e antes do ack | Testado (`invariants-resilience.spec.ts`, item b) |
| Dois publishers na mesma outbox | Testado (`outbox-publisher.spec.ts`) |
| ROLLBACK/REFUND antes da referência | Testado |
| Reinício com consistência final | Testado (item c) |
| SIGTERM com mensagem em andamento | Testado (item i) |
| Status HTTP: 200 / 202 / 400 / 409 / 422 / 503 | Mapeados e testados (ver G04, G05, G12, G18) |
| Todos os endpoints do enunciado (wallets, ledger com cursor, consulta de transações, reconciliação, health) | Presentes |
| Filas `.fifo` + DLQ, inbox, ack após commit, redrive `maxReceiveCount=5` | Atendido |
| Outbox: `FOR UPDATE SKIP LOCKED`, `MessageGroupId=walletId`, `MessageDeduplicationId=eventId` | Atendido |
| Eventos mínimos (`Processed`, `Rejected`, `WalletBalanceChanged`, `PendingReference`) | Atendido |
| Autenticação: `NoopAuthGuard` + `ProviderIdentityPort` + desenho documentado | Aceito pelo enunciado |
| Migrations versionadas e reversíveis | Atendido (5 migrations com `down()` e teste de ciclo) |

---

## 8. Plano para chegar a 100%

Ordem sugerida. Nada disso foi aplicado.

1. **Documentação (G01, G02, G03, G09, G24):** corrigir `ARCHITECTURE.md`, refazer a matriz de rastreabilidade, regenerar o `TEST_REPORT.md` com execução real, atualizar o ADR-003 e completar o relatório de carga.
2. **Validação de borda (G04, G05, G12, G14):** `Idempotency-Key` obrigatório, DTO com validação (`kind`, valores positivos, UUIDs, `playerId` da wallet), 409 em corrida de criação de wallet, erros permanentes direto para a DLQ.
3. **Observabilidade (G06, G07):** logs JSON com os campos exigidos; incrementar `reconciliationDiscrepancies` e o gauge de pendências.
4. **Corretude de borda (G10, G11, G13):** manter reversões encadeadas em `PENDING_REFERENCE`, validar hash nesse estado, uma transação por item no worker.
5. **Arquitetura (G15, G21):** unificar `execute*`, injetar portas, mover regras por `kind` para o domínio, usar `OutboxMessage` no worker.
6. **Infra (G16, G20, G25):** validar `docker compose up --build` do zero, migrations no startup, healthchecks.
7. **Higiene do repositório (G08):** criar `.gitignore`, apagar snapshots `disposable`, remover a duplicata de `ARCHITECTURE.md`, enxugar `docs/evidence/`.
8. **Testes novos:** unidade das regras por `kind`, validações de borda (400), corrida de criação de wallet, reversão encadeada fora de ordem, métrica de reconciliação.
9. **Verificação final:** rodar `bun run test`, `test:int`, `test:e2e`, `test:load` e `docker compose up --build`. Só então fechar os commits organizados.
