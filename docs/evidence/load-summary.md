# Load Test Execution Summary — 10 Consecutive Runs (50 Concurrent Bets Each)

Timestamp Inicial (UTC): 2026-10-12T05:34:33.361Z  
Total de Rodadas: 10  
Apostas por Rodada: 50 simultâneas disputando a mesma carteira  
Invariante: Zero saldo negativo, ledger 100% equilibrado e reconciliado em todas as rodadas.

| # | Data/Hora (UTC) | Total | PROCESSED | 503 | p50 (ms) | p95 (ms) | p99 (ms) | Lock Conflicts | Retries | Causa dos 503 | Log |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **#1** | 2026-10-12T05:34:33.361Z | 50 | 50 | 0 | 153.27 | 238.66 | 245.78 | 0 | 0 | Nenhuma (100% processado) | `run-01-2026-10-12T05-34-33-361Z.log` |
| **#2** | 2026-10-12T05:34:38.613Z | 50 | 50 | 0 | 147.59 | 221.29 | 227.16 | 0 | 0 | Nenhuma (100% processado) | `run-02-2026-10-12T05-34-38-613Z.log` |
| **#3** | 2026-10-12T05:34:43.914Z | 50 | 50 | 0 | 145.01 | 223.20 | 228.53 | 0 | 0 | Nenhuma (100% processado) | `run-03-2026-10-12T05-34-43-914Z.log` |
| **#4** | 2026-10-12T05:34:49.085Z | 50 | 50 | 0 | 191.61 | 268.76 | 275.10 | 0 | 0 | Nenhuma (100% processado) | `run-04-2026-10-12T05-34-49-085Z.log` |
| **#5** | 2026-10-12T05:34:54.144Z | 50 | 50 | 0 | 140.56 | 233.98 | 240.98 | 0 | 0 | Nenhuma (100% processado) | `run-05-2026-10-12T05-34-54-144Z.log` |
| **#6** | 2026-10-12T05:34:59.032Z | 50 | 50 | 0 | 137.25 | 216.87 | 225.05 | 0 | 0 | Nenhuma (100% processado) | `run-06-2026-10-12T05-34-59-032Z.log` |
| **#7** | 2026-10-12T05:35:04.519Z | 50 | 50 | 0 | 139.91 | 210.15 | 215.56 | 0 | 0 | Nenhuma (100% processado) | `run-07-2026-10-12T05-35-04-519Z.log` |
| **#8** | 2026-10-12T05:35:09.459Z | 50 | 50 | 0 | 133.82 | 218.94 | 228.61 | 0 | 0 | Nenhuma (100% processado) | `run-08-2026-10-12T05-35-09-459Z.log` |
| **#9** | 2026-10-12T05:35:14.331Z | 50 | 50 | 0 | 139.42 | 213.20 | 218.50 | 0 | 0 | Nenhuma (100% processado) | `run-09-2026-10-12T05-35-14-331Z.log` |
| **#10** | 2026-10-12T05:35:19.160Z | 50 | 50 | 0 | 138.84 | 215.40 | 223.07 | 0 | 0 | Nenhuma (100% processado) | `run-10-2026-10-12T05-35-19-160Z.log` |

### Observações de Concorrência
- Em todas as 10 execuções, o saldo final foi idêntico à soma das transações processadas vezes 10.00 BRL.
- Medição no processo (caso de uso direto, sem HTTP): as 50 apostas disputam o mesmo lock de linha da wallet. Lock Conflicts e Retries são os deltas dos contadores Prometheus durante a rodada; um 503 só ocorre quando um conflito esgota as 6 tentativas.
- Latência percebida pelo cliente (HTTP, 3 réplicas): `bun run load:http`, resultados em `docs/TEST_REPORT.md`.
