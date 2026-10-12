# Load Test Execution Summary — 10 Consecutive Runs (50 Concurrent Bets Each)

Timestamp Inicial (UTC): 2026-10-12T04:51:44.222Z  
Total de Rodadas: 10  
Apostas por Rodada: 50 simultâneas disputando a mesma carteira  
Invariante: Zero saldo negativo, ledger 100% equilibrado e reconciliado em todas as rodadas.

| # | Data/Hora (UTC) | Total | PROCESSED | 503 | p50 (ms) | p95 (ms) | p99 (ms) | Lock Conflicts | Retries | Causa dos 503 | Log |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **#1** | 2026-10-12T04:51:44.222Z | 50 | 50 | 0 | 87.33 | 133.85 | 137.80 | 0 | 0 | Nenhuma (100% processado) | `run-01-2026-10-12T04-51-44-222Z.log` |
| **#2** | 2026-10-12T04:51:47.310Z | 50 | 50 | 0 | 86.75 | 134.68 | 138.59 | 0 | 0 | Nenhuma (100% processado) | `run-02-2026-10-12T04-51-47-310Z.log` |
| **#3** | 2026-10-12T04:51:50.413Z | 50 | 50 | 0 | 88.47 | 138.01 | 142.44 | 0 | 0 | Nenhuma (100% processado) | `run-03-2026-10-12T04-51-50-413Z.log` |
| **#4** | 2026-10-12T04:51:53.500Z | 50 | 50 | 0 | 93.83 | 141.43 | 145.60 | 0 | 0 | Nenhuma (100% processado) | `run-04-2026-10-12T04-51-53-500Z.log` |
| **#5** | 2026-10-12T04:51:56.586Z | 50 | 50 | 0 | 88.72 | 135.53 | 140.69 | 0 | 0 | Nenhuma (100% processado) | `run-05-2026-10-12T04-51-56-586Z.log` |
| **#6** | 2026-10-12T04:51:59.724Z | 50 | 50 | 0 | 91.77 | 149.84 | 154.05 | 0 | 0 | Nenhuma (100% processado) | `run-06-2026-10-12T04-51-59-724Z.log` |
| **#7** | 2026-10-12T04:52:02.795Z | 50 | 50 | 0 | 87.51 | 134.57 | 138.48 | 0 | 0 | Nenhuma (100% processado) | `run-07-2026-10-12T04-52-02-795Z.log` |
| **#8** | 2026-10-12T04:52:05.865Z | 50 | 50 | 0 | 84.80 | 136.63 | 140.72 | 0 | 0 | Nenhuma (100% processado) | `run-08-2026-10-12T04-52-05-865Z.log` |
| **#9** | 2026-10-12T04:52:08.947Z | 50 | 50 | 0 | 102.83 | 150.03 | 153.84 | 0 | 0 | Nenhuma (100% processado) | `run-09-2026-10-12T04-52-08-947Z.log` |
| **#10** | 2026-10-12T04:52:11.994Z | 50 | 50 | 0 | 88.46 | 135.70 | 139.59 | 0 | 0 | Nenhuma (100% processado) | `run-10-2026-10-12T04-52-11-994Z.log` |

### Observações de Concorrência
- Em todas as 10 execuções, o saldo final foi idêntico à soma das transações processadas vezes 10.00 BRL.
- Medição no processo (caso de uso direto, sem HTTP): as 50 apostas disputam o mesmo lock de linha da wallet. Lock Conflicts e Retries são os deltas dos contadores Prometheus durante a rodada; um 503 só ocorre quando um conflito esgota as 6 tentativas.
- Latência percebida pelo cliente (HTTP, 3 réplicas): `bun run load:http`, resultados em `docs/TEST_REPORT.md`.
