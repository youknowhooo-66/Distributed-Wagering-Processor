# Relatório de Auditoria de Conformidade (Audit Report)

Data da Auditoria: 11/10/2026  
Escopo: Validação contra as 17 hipóteses de auditoria e resolução de divergências entre documentação e código real.

---

## 1. Veredito das 17 Hipóteses de Auditoria

| Hipótese | Descrição da Hipótese | Veredito | Evidência em Código / Execução |
| :---: | :--- | :---: | :--- |
| **H01** | Uso de floats ou números para operações financeiras. | **REFUTADA** | Objeto de valor `Money` baseado em `Decimal.js` (`../src/shared/domain/value-objects/money.ts`). Banco usa `numeric(19,2)`. |
| **H02** | Possibilidade de saldo negativo sob concorrência. | **REFUTADA** | Validação no agregado `Wallet.debit()` e constraint `chk_wallets_balance_non_negative`. |
| **H03** | Mutação não autorizada no ledger contábil. | **REFUTADA** | Trigger PL/pgSQL `trg_wallet_ledger_immutable` bloqueia `UPDATE` e `DELETE`. |
| **H04** | Falha de idempotência gerando débitos duplicados. | **REFUTADA** | Constraint `uq_wager_idempotency_key` e check de `payload_hash` SHA-256. |
| **H05** | Replay idempotente devolve saldo atual em vez de histórico. | **REFUTADA** | Coluna `balance_after numeric(19,2)` gravada em cada transação via Migration 3. |
| **H06** | Múltiplas reversões concorrentes na mesma aposta. | **REFUTADA** | Índice único parcial `uq_wager_reference_reversal` bloqueia colisões. |
| **H07** | REFUND/ROLLBACK adiantado causa falha silenciosa. | **REFUTADA** | Gravado como `PENDING_REFERENCE` e reprocessado pelo agendador de retry. |
| **H08** | Inconsistência matemática entre saldo e soma do ledger. | **REFUTADA** | Reconciliação executada e validada em 100% dos testes sem nenhuma discrepância. |
| **H09** | Dual-write em mensageria com perda de eventos. | **REFUTADA** | Transactional Outbox Pattern atômico na tabela `outbox_messages`. |
| **H10** | Eventos do outbox perdem a ordenação temporal por carteira. | **REFUTADA** | Publicação em SQS FIFO com `MessageGroupId: walletId`. |
| **H11** | Entidades de domínio contaminadas por decorators de ORM. | **REFUTADA** | Domínio puro DDD com construtores privados e fábricas estáticas. |
| **H12** | Deadlocks generalizados por locks de linha prolongados. | **REFUTADA** | Concorrência gerida via controle otimista com coluna `version`. |
| **H13** | Exceções de concorrência não mapeadas para HTTP 503 com Retry-After. | **REFUTADA** | Tratamento explícito no controller com header `Retry-After: 1`. |
| **H14** | Mensagens da outbox sofrem colisão entre múltiplos workers. | **REFUTADA** | Consulta utiliza `FOR UPDATE SKIP LOCKED`. |
| **H15** | Migrações irreversíveis ou com perda de dados. | **REFUTADA** | Todas as 4 migrações possuem métodos `up()` e `down()` estritamente testados. |
| **H16** | Métricas inexistentes ou sem prefixo padronizado. | **REFUTADA** | Coleta com prefixo `wagering_` e métricas registradas em `prom-client`. |
| **H17** | Fila DLQ ausente para mensagens com falha irrecuperável. | **REFUTADA** | Fila `wager-transactions-dlq.fifo` provisionada no LocalStack. |

---

## 2. Resolução de Divergências Encontradas

1. **Estratégia de Concorrência**:
   - *Divergência*: Documentos anteriores citavam `SELECT FOR UPDATE` para carteiras.
   - *Resolução*: O código real utiliza Bloqueio Otimista (`WalletMikroEntity.version`). O uso de `FOR UPDATE SKIP LOCKED` é exclusivo do `OutboxPublisherWorker`. A documentação foi corrigida no [ADR-001](./adr/001-optimistic-locking-strategy.md) e [ARCHITECTURE.md](./ARCHITECTURE.md).
2. **Destino da Mensageria do Outbox**:
   - *Divergência*: Menção a SNS nos documentos, enquanto o compose provisionava apenas SQS.
   - *Resolução*: O worker publica exclusivamente na fila **Amazon SQS FIFO** (`wagering-events.fifo`). A menção a SNS foi removida e a entrega ponta a ponta foi comprovada via teste.
3. **Escopo do Índice Único de Reversão**:
   - *Divergência*: Dúvida se o índice continha apenas `reference_transaction_id` ou também `kind`.
   - *Resolução*: A migration real define `(reference_transaction_id, kind) WHERE status = 'PROCESSED'`. A decisão semântica foi documentada no [ADR-003](./adr/003-reversal-unique-index-semantics.md).
