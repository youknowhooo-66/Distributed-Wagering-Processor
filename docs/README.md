# Documentação Técnica — Distributed Wagering Processor

Índice central de documentação e arquitetura do processador financeiro distribuído de apostas (Jungle Gaming).

---

## Ordem de Leitura Recomendada

1. [MANUAL.md](./MANUAL.md) — Manual breve (1-2 páginas): arquitetura em um diagrama, fluxo de aposta, conceitos-chave, glossário e comandos essenciais.
2. [ARCHITECTURE.md](./ARCHITECTURE.md) — Documento arquitetural detalhado: domínios, isolamento de concorrência, consistência eventual e garantias transacionais.
3. [adr/](./adr/) — Registro de Decisões Arquiteturais (ADRs):
   - [ADR-001: Lock Pessimista por Wallet (vs Otimista)](./adr/001-optimistic-locking-strategy.md)
   - [ADR-002: Publicação Assíncrona via Outbox Pattern para SQS FIFO](./adr/002-outbox-sqs-fifo-destination.md)
   - [ADR-003: Índice de Unicidade Parcial para Reversões](./adr/003-reversal-unique-index-semantics.md)
   - [ADR-004: Imutabilidade Estrita do Ledger Contábil](./adr/004-ledger-immutability-database-trigger.md)
   - [ADR-005: Publicação do Outbox em Ordem por Wallet](./adr/005-outbox-per-group-ordering.md)
4. [REQUIREMENTS_TRACEABILITY.md](./REQUIREMENTS_TRACEABILITY.md) — Matriz completa de rastreabilidade (9 restrições invioláveis, 8 áreas da rubrica, 8 falhas eliminatórias e regras de negócio).
5. [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md) — Diário detalhado de implementação, correções P0/P1/P2 e mitigação de bugs.
6. [AUDIT_REPORT.md](./AUDIT_REPORT.md) — Relatório de auditoria de conformidade com as 17 hipóteses iniciais e vereditos baseados no código-fonte real.
7. [TEST_REPORT.md](./TEST_REPORT.md) — Relatório de execução das suítes de testes unitários, integração, concorrência e carga.
8. [PRODUCTION_READINESS.md](./PRODUCTION_READINESS.md) — Avaliação auditável e honesta de prontidão operacional e bloqueios reais.
9. [OPERATIONS_RUNBOOK.md](./OPERATIONS_RUNBOOK.md) — Procedimentos operacionais, healthchecks, métricas Prometheus reais e runbook de emergência.
10. [COMMIT_PLAN.md](./COMMIT_PLAN.md) — Plano estruturado de commits convencionais e organizacionais para entrega em branch.
