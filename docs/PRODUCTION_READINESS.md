# Avaliação de Prontidão para Produção (Production Readiness Assessment)

Data da Avaliação: 12/10/2026 — revisada em 15/10/2026 (revisão de entrega)  
Classificação Final: **Não Pronto para Produção — restam 2 bloqueios fora do escopo do desafio (autenticação e backup)**

---

## 1. Matriz de Avaliação por Dimensão

| Dimensão | Classificação | Evidência | Bloqueante para Produção? |
| :--- | :---: | :--- | :---: |
| **Segurança e Autenticação** | ❌ | `NoopAuthGuard` ativo (`../src/shared/application/ports/auth.guard.ts`). Não há validação de credenciais ou assinatura criptográfica de provedor. | **SIM (Bloqueio Crítico)** |
| **Consistência Contábil e Domínio** | ✅ | Ledger imutável (`trg_wallet_ledger_immutable`, sem `TRUNCATE`); saldo ↔ lançamento pareados por `wallet_version` e transação terminal imutável, impostos pelo PostgreSQL no commit (ADR-006); reconciliação em três vias para escritas privilegiadas; idempotência verificada inclusive em `PENDING_REFERENCE`. | NÃO |
| **Isolamento de Concorrência** | ✅ | Lock por linha da wallet (`SELECT ... FOR UPDATE`) com `version` como barreira, comprovado com 3 processos Bun independentes (`multiprocess-concurrency.spec.ts`). | NÃO |
| **Mensageria e Resiliência** | ✅ | Ordem por wallet no consumer e no outbox (ADR-005); DLQ sem perda de mensagem e com `FailureReason`; redrive seletivo testado (`bun run dlq:redrive`). | NÃO |
| **Desempenho e Latência** | ✅ | Hot wallet sem 503 até 200 apostas simultâneas; carga HTTP com 3 réplicas sem erros (`docs/TEST_REPORT.md` §3). Medição no Mac anterior às checagens extras por commit: refazer antes da entrega. | NÃO |
| **Observabilidade e Métricas** | ✅ | Logs JSON com `correlationId` propagado do header/mensagem até os eventos; métricas documentadas atualizadas pelo código (teste `metrics-wiring.spec.ts`); 8 regras de alerta em `infra/prometheus/alerts.yml`, validadas e testadas com `promtool` no CI. Dashboards Grafana não incluídos. | NÃO |
| **CI/CD e Automação de Build** | ⚠️ | Workflow `.github/workflows/ci.yml` (typecheck, suítes com PostgreSQL/LocalStack reais, ciclo de migrations, imagem + 3 réplicas + encerramento gracioso). Passos validados localmente; ainda não executado no GitHub. Sem pipeline de deploy (CD). | NÃO para CI; deploy fora de escopo |
| **Containerização de Produção** | ✅ | `Dockerfile` multi-stage, usuário não-root, `HEALTHCHECK`, dependências só de produção; migração one-shot no compose; encerramento com código 0 em `SIGTERM` como PID 1. | NÃO |
| **Backup e Disaster Recovery** | ❌ | Ausência de política de backup contínuo (WAL archiving / PITR) do banco de dados relacional. | **SIM (Bloqueio de Infra)** |
| **Retenção de Mensagens Outbox/Inbox** | ✅ | `RetentionWorker` com expurgo em lotes, índices dedicados e retenção mínima do inbox acima da janela de reentrega do SQS. | NÃO |

---

## 2. Lista Consolidada de Itens Bloqueantes para Produção (2 Bloqueios)

Resolvidos nas revisões de 12/10/2026: pipeline de CI, imagem Docker de produção, redrive da DLQ, retenção de outbox/inbox e alertas. Os dois itens restantes estão fora do escopo do desafio (a autenticação não é avaliada, conforme a seção 2 do enunciado; backup é responsabilidade da plataforma de banco), mas bloqueiam uma implantação real.

1. **Autenticação e Assinatura Criptográfica**:
   - Implementar validação de assinatura HMAC-SHA256 ou tokens JWT nos endpoints financeiros, substituindo `NoopAuthGuard`.
2. **Automação de Backup do Banco**:
   - Configurar rotinas de backup físico com arquivo WAL e Point-in-Time-Recovery (PITR) para o PostgreSQL.
