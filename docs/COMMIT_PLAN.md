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

---

## 4. Revisão de Entrega (15/10/2026)

Commits locais na mesma branch, sobre `e590d35`, sem push (o push e o merge são decisão do responsável). Cada commit passa no typecheck e nos testes unitários.

| # | Mensagem | Conteúdo |
| :-: | :--- | :--- |
| 1 | `perf(persistence): lock_timeout as a connection setting, DB_POOL_MAX and failures-only access log` | Alterações que estavam pendentes no working tree (config do MikroORM, unidade de trabalho, `app.module.ts`, docs) |
| 2 | `refactor(domain): section 7 rules as pure domain functions` | `wager-rules.ts`, caso de uso e worker de pendências, `FailureCode`, testes de unidade das regras |
| 3 | `feat(http): mandatory Idempotency-Key, correlation id, structured logs and 503 for unavailable database` | Controllers, filtro de exceções, consumer, workers, métricas por status |
| 4 | `feat(schema): balance-ledger pairing by wallet version and immutable wager transactions` | Migrations `…15000001` e `…15000002`, `walletVersion` no ledger, cursor estável, validação e corrida de `POST /wallets` |
| 5 | `test: delivery hardening suite` | `integration/delivery-hardening.spec.ts` |
| 6 | `chore(ops): load test reports conflicts and outbox lag; LocalStack healthcheck waits for queues` | `scripts/load-http.ts`, `docker-compose.yml` |
| 7 | `docs: delivery review` | `README.md`, `ARCHITECTURE.md`, `docs/` |

### Auditoria de avaliador (mesma data)

| # | Mensagem | Conteúdo |
| :-: | :--- | :--- |
| 8 | `fix(persistence): exact decimal comparison for money columns` | `ExactDecimalType` e mapeamentos |
| 9 | `fix(domain): balance limit, WIN to BET reference, reserved internal provider, OPENING event` | Regras, caso de uso, validador, abertura de wallet |
| 10 | `fix(http): uniform error envelope and SQS message contract` | Filtro global, códigos 404/409, consumer |
| 11 | `test: evaluator edge cases; plain bun test` | `integration/evaluator-edge-cases.spec.ts`, preload |
| 12 | `docs: evaluator audit` | Documentação, `.env.example` |

