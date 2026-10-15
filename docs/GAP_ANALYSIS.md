# Gap Analysis — Estado do Código vs. Enunciado

- **Primeira análise:** 11/10/2026, estática.
- **Revisão de entrega:** 15/10/2026, com a suíte executada.
- **Fonte de verdade:** o enunciado do desafio. Onde a documentação divergia dele, valeu o enunciado.

## Veredito

Todos os gaps abertos em 11/10 estão fechados. A revisão de 15/10 encontrou e fechou mais nove (N01–N09). Nenhuma falha eliminatória da seção 14 ocorre, e cada exigência tem implementação e teste em `docs/REQUIREMENTS_TRACEABILITY.md`.

Resultado da execução de 15/10:
- 224 testes passando;
- typecheck limpo;
- build de produção com 3 instâncias validado.

Detalhes em `docs/TEST_REPORT.md`.

Pendências que não são de código (seção 4): rodar o CI e `scripts/collect-evidence.ts` com LocalStack, e refazer a carga HTTP no mesmo hardware da medição anterior.

| Área (seção 14) | Peso | Situação |
|---|---:|---|
| Correção financeira | 20 | `Money` exato, ledger imutável e encadeado por versão, saldo ↔ ledger garantido pelo banco, reversões, reconciliação em três vias sem correção silenciosa |
| Concorrência | 20 | Lock por wallet, `version`, retry limitado, cenário §8 entre 3 instâncias, corrida de criação de wallet → 409 |
| Idempotência | 15 | Header obrigatório, chave única por provedor, hash canônico, replay com saldo histórico, conflito em qualquer estado, inbox |
| Mensageria e falhas | 15 | Inbox, outbox ordenado por wallet, classificação de erros, DLQ sem perda, crash recovery, SIGTERM, PostgreSQL fora do ar → 503 |
| Modelagem e arquitetura | 10 | Regras da seção 7 em funções puras de domínio; use cases dependem só de portas; `failureCode` como erro de domínio |
| Testes | 10 | PostgreSQL real; regras testadas no código de produção; guardas do schema testadas; concorrência multi-processo |
| Observabilidade | 5 | Logs JSON com os 5 identificadores, `correlationId` propagado até os eventos, métricas mínimas completas, health checks |
| Documentação | 5 | README, ARCHITECTURE (decisões, trade-offs, limitações), 6 ADRs, rastreabilidade com o enunciado |

---

## 1. Gaps da análise de 11/10: situação final

| Gap | Descrição | Situação |
|---|---|---|
| G01 | Docs contradiziam o código sobre a estratégia de lock | ✅ `ARCHITECTURE.md` §3 e ADR-001 descrevem o lock pessimista por wallet. `docs/AUDIT_REPORT.md`, que ainda dizia "otimista", foi removido. A cópia duplicada `docs/ARCHITECTURE.md` também, ficando só a da raiz. |
| G02 | Matriz de rastreabilidade com rubrica inventada | ✅ Refeita seção a seção contra o enunciado |
| G03 | `TEST_REPORT.md` com arquivos inexistentes e contagens erradas | ✅ Regenerado a partir da execução de 15/10 |
| G04 | `Idempotency-Key` opcional | ✅ Obrigatório: `400 MISSING_IDEMPOTENCY_KEY` |
| G05 | Validação de entrada incompleta (500 em vez de 400) | ✅ Contrato único HTTP/SQS (`kind`, valor > 0, UUIDs, tamanhos). Também validados: `POST /wallets`, IDs de rota (`400 INVALID_ID`) e `limit`/cursor do ledger. Titularidade da wallet (`WALLET_PLAYER_MISMATCH`). |
| G06 | Logs sem campos estruturados | ✅ Todos os logs de aplicação são objetos com `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId`. `X-Correlation-Id` é gerado ou propagado até os eventos. |
| G07 | Métrica de divergência nunca incrementada | ✅ `wagering_reconciliation_discrepancies_total`, gauge e contador de pendências ligados. Novo `wagering_transactions_total{status}`. |
| G08 | Repositório sem higiene | ✅ `.gitignore` cobre `node_modules`, `dist`, snapshots descartáveis e `.DS_Store`. Snapshots descartáveis removidos. |
| G09 | Índice de reversão mais estrito que o enunciado | ✅¹ Interpretação mantida e documentada (ADR-003, `ARCHITECTURE.md` §9): evita devolver a mesma aposta duas vezes |
| G10 | Reversão cuja referência ainda aguarda era rejeitada | ✅ `checkReference` devolve `WAIT`. A cadeia ROLLBACK(REFUND) → REFUND(BET) → BET termina toda `PROCESSED` (teste em `delivery-hardening`). |
| G11 | Reenvio de transação em `PENDING_REFERENCE` | ✅ Hash validado também nesse estado. Reenvio idêntico sem a referência é replay: sem evento novo e sem consumir tentativa do worker. |
| G12 | Corrida na criação de wallet → 500 | ✅ `uq_wallets_player_currency` traduzido para 409 (10 criações simultâneas → 1×201 + 9×409) |
| G13 | Worker de pendências com várias wallets numa transação | ✅ Uma transação por pendência, wallet travada primeiro, e o worker reprograma quando a referência ainda aguarda |
| G14 | Erros permanentes tratados como transitórios no consumer | ✅ 4xx e erros de domínio vão direto à DLQ com `FailureReason`. O conflito de idempotência é logado. |
| G15 | Use case acoplado e duplicado | ✅ Um único fluxo `process()`. Portas `UnitOfWork`, repositórios e `WageringMetrics`. Regras da seção 7 em `src/wagering/domain/wager-rules.ts`. |
| G16 | Docker/Compose não comprovados | ✅ Imagem multi-stage sem root, serviço `migrate`, healthchecks. O healthcheck do LocalStack espera a última fila existir. O smoke test do CI sobe as 3 réplicas. |
| G17 | Alias duplicado em `FailureCode` | ✅ Removido |
| G18 | Replay de `FAILED` respondia 200 | ✅ `500` com `status: FAILED` e `failureCode` (terminal) |
| G19 | `limit` e cursor do ledger sem validação; cursor sujeito a relógio | ✅ `400 INVALID_LIMIT`/`INVALID_CURSOR`. Cursor por `wallet_version`, estável sob escrita concorrente e independente de relógio. |
| G20 | Worker ignorava `ENABLE_BACKGROUND_POLL` | ✅ |
| G21 | Worker do outbox duplicava a regra de backoff | ✅ `OutboxMessage.retryDelayMs` é a fonte única. O worker continua em SQL por desempenho (lock consultivo por grupo). |
| G22 | `reject()`/`fail()` com `new Date()` interno | ✅ Recebem o instante |
| G23 | `Error` genérico na criação sem referência | ✅ `MissingReferenceError` (erro de domínio) |
| G24 | Relatório de carga incompleto | ✅ `load:http` mede throughput, percentis, taxa de erro, conflitos, retries, outbox lag, backlog e drenagem |
| G25 | `version` obsoleto no compose | ✅ |

## 2. Encontrados na revisão de 15/10

| # | Achado | Correção | Teste |
|---|---|---|---|
| N01 | `validate-reference.spec.ts` testava uma **cópia** da regra escrita no próprio teste, não o código de produção | Regras extraídas para o domínio; `wager-rules.spec.ts` testa o código real; arquivo antigo removido | `unit/wager-rules.spec.ts` (37 casos) |
| N02 | O schema não impedia saldo alterado sem lançamento, lançamento sem movimentação nem versão alterada sem saldo (seção 6 + restrição 9) | `wallet_version` + gatilhos diferidos (ADR-006) | `integration/delivery-hardening` |
| N03 | O schema permitia alterar ou apagar transação terminal e alterar colunas de negócio | `trg_wager_transaction_guard`; `TRUNCATE` bloqueado em transações e ledger | `integration/delivery-hardening` |
| N04 | A wallet podia ser debitada com `playerId` de outro jogador | `WALLET_PLAYER_MISMATCH` (422, auditável) | `unit/wager-rules.spec.ts`, `integration/delivery-hardening` |
| N05 | PostgreSQL inalcançável respondia 500, sem distinguir falha transitória | `InfrastructureUnavailableError` → 503 + `Retry-After` | `integration/database-unavailable` |
| N06 | `POST /wallets` sem validação (500 com corpo inválido) e IDs de rota não-UUID → 500 | Validação → 400 | `integration/delivery-hardening` |
| N07 | Mensagem SQS que terminava em `PENDING_REFERENCE` não era registrada na inbox | Inbox gravada também no caminho `PENDING_REFERENCE` | `integration/delivery-hardening` |
| N08 | Eventos sempre com `correlationId = transactionId`; sem `causationId` | `correlationId` do chamador; `causationId` = `messageId` da fila | `integration/delivery-hardening` |
| N09 | Taxonomia documentada com códigos inexistentes (`EXTERNAL_TRANSACTION_EXISTS`) e sem `REVERSAL_INSUFFICIENT_BALANCE` | Tabela refeita com a ação esperada do provedor (`ARCHITECTURE.md` §11) | — |

## 3. Interpretações adotadas (documentadas)

- **Uma reversão por referência, de qualquer tipo** (ADR-003): mais estrito que "duas vezes pelo mesmo tipo".
- **`FAILED` responde 500 em replay**: é terminal e não deve ser reenviado; 503 fica reservado ao que pode ser retentado.
- **Uma movimentação por wallet por transação SQL**: exigida pelos gatilhos de pareamento; é o desenho de todos os fluxos.
- **Timeout de referência**: 10 tentativas (≈ 20 min). Justificativa em `ARCHITECTURE.md` §9.

## 4. Pendências fora do código

1. **CI no PR:** valida tudo com LocalStack real e com a imagem Docker em 3 réplicas. O workspace de 15/10 não tinha acesso ao Docker Hub.
2. **Evidência oficial:** `bun run scripts/collect-evidence.ts` com a stack do Compose no ar, para regenerar `docs/evidence/` no mesmo Mac da medição anterior.
3. **Carga no mesmo hardware:** `bun run load:http` no mesmo hardware de 12/10, para medir o custo das duas checagens extras por commit e da linha de log por transação.
