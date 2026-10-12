# Load Test Execution Summary — 10 Consecutive Runs (50 Concurrent Bets Each)

Timestamp Inicial (UTC): 2026-10-12T04:15:19.467Z  
Total de Rodadas: 10  
Apostas por Rodada: 50 simultâneas disputando a mesma carteira  
Invariante: Zero saldo negativo, ledger 100% equilibrado e reconciliado em todas as rodadas.

| # | Data/Hora (UTC) | Total | PROCESSED | 503 | p50 (ms) | p95 (ms) | p99 (ms) | Lock Conflicts | Retries | Causa dos 503 | Log |
|---|---|---|---|---|---|---|---|---|---|---|---|

### Observações de Concorrência
- Em todas as 10 execuções, o saldo final foi idêntico à soma das transações processadas vezes 10.00 BRL.
- Os retornos 503 decorrem comprovadamente de colisões de versionamento otimista (`optimistic_lock`) que excederam o limite de 6 retentativas.
