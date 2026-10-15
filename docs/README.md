# Documentação Técnica — Distributed Wagering Processor

Índice central de documentação e arquitetura do processador financeiro distribuído de apostas (Jungle Gaming).

---

## Ordem de Leitura Recomendada

1. [MANUAL.md](./MANUAL.md) — Manual breve (1-2 páginas): arquitetura em um diagrama, fluxo de aposta, conceitos-chave, glossário e comandos essenciais.
2. [ARCHITECTURE.md](../ARCHITECTURE.md) — Documento arquitetural detalhado: domínios, isolamento de concorrência, consistência eventual e garantias transacionais.
3. [adr/](./adr/) — Registro de Decisões Arquiteturais (ADRs):
   - [ADR-001: Lock Pessimista por Wallet (vs Otimista)](./adr/001-optimistic-locking-strategy.md)
   - [ADR-002: Publicação Assíncrona via Outbox Pattern para SQS FIFO](./adr/002-outbox-sqs-fifo-destination.md)
   - [ADR-003: Índice de Unicidade Parcial para Reversões](./adr/003-reversal-unique-index-semantics.md)
   - [ADR-004: Imutabilidade Estrita do Ledger Contábil](./adr/004-ledger-immutability-database-trigger.md)
   - [ADR-005: Publicação do Outbox em Ordem por Wallet](./adr/005-outbox-per-group-ordering.md)
   - [ADR-006: Pareamento Saldo ↔ Ledger e Imutabilidade de Transações no Schema](./adr/006-balance-ledger-pairing-in-schema.md)
4. [REQUIREMENTS_TRACEABILITY.md](./REQUIREMENTS_TRACEABILITY.md) — Rastreabilidade seção a seção do enunciado: exigência → código → teste.
5. [GAP_ANALYSIS.md](./GAP_ANALYSIS.md) — Análise do código contra o enunciado, situação final de cada gap e interpretações adotadas.
6. [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md) — Diário detalhado de implementação, correções P0/P1/P2 e mitigação de bugs.
7. [TEST_REPORT.md](./TEST_REPORT.md) — Execução das suítes (unidade, integração, concorrência, carga), smoke test com 3 instâncias e carga HTTP; evidências em [evidence/](./evidence/validation-2026-10-15.md).
8. [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md) — Avaliação auditável e honesta de prontidão operacional e bloqueios reais.
9. [OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md) — Procedimentos operacionais, healthchecks, métricas Prometheus reais e runbook de emergência.
10. [COMMIT_PLAN.md](./COMMIT_PLAN.md) — Plano estruturado de commits convencionais e organizacionais para entrega em branch.
