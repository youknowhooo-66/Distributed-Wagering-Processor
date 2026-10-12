# Plano de Commits (Commit Plan)

Data: 12/10/2026  
Status: **Executado na branch `feat/wagering-processor`**

---

## 1. Declaração de Integridade Histórica

O código foi desenvolvido fora do controle de versão (o repositório continha apenas o `README.md` inicial). A sequência abaixo é uma organização **por camada**, não uma cronologia de desenvolvimento. Por isso não há commits `fix:` separados para as correções P0/P1/P2: o estado anterior a elas nunca foi versionado, e esses commits descreveriam uma história que não existiu. As correções estão registradas no [IMPLEMENTATION_LOG.md](./IMPLEMENTATION_LOG.md).

Cada commit compila isoladamente (typecheck) e, a partir do commit 2, passa os testes unitários. Verificação: `git rebase --exec <verificação> main`.

---

## 2. Sequência de Commits

| # | Mensagem | Conteúdo |
| :-: | :--- | :--- |
| 1 | `chore: project tooling and repository hygiene` | `package.json`, `bun.lock`, `tsconfig*.json`, `nest-cli.json`, `bunfig.toml`, `.gitignore`, `.dockerignore` |
| 2 | `feat(domain): money, wallet and wager aggregates with ports` | `src/*/domain`, `src/shared/application/ports`, testes unitários de domínio |
| 3 | `feat(application): wagering and wallet use cases` | `src/*/application`, teste do validador de contrato |
| 4 | `feat(persistence): schema, migrations and MikroORM adapters` | `src/migrations`, `*/infrastructure/persistence`, `shared/infrastructure/database` |
| 5 | `feat(adapters): HTTP API, SQS consumer, outbox and workers` | HTTP, mensageria, workers, health, métricas, módulos, `main.ts` |
| 6 | `test: integration, concurrency and load suites` | `src/test/integration`, `src/test/concurrency`, `src/test/load` |
| 7 | `build: production image and 3-replica local stack` | `Dockerfile`, `docker-compose.yml`, `infra/localstack-init.sh` |
| 8 | `feat(ops): alert rules and DLQ redrive tool` | `infra/prometheus/`, `scripts/dlq-redrive.ts` |
| 9 | `ci: typecheck, tests, alert rules and image smoke test` | `.github/workflows/ci.yml`, `scripts/check-docs.ts`, `scripts/collect-evidence.ts` |
| 10 | `docs: architecture, ADRs, runbook and evidence` | `README.md`, `ARCHITECTURE.md`, `docs/` |

---

## 3. Integração

- Pull request de `feat/wagering-processor` para `main`; o workflow de CI roda em `pull_request`.
- Merge por **merge commit** (ou rebase), não squash, para preservar a sequência acima.
- Após o merge: proteger `main` exigindo os jobs `test` e `image` do CI.
