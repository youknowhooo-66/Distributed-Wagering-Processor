# ADR-003: Semântica e Unicidade Estrita de Reversões (Exclusão Mútua de REFUND e ROLLBACK)

## Status
Aceito e Implementado (Migration `Migration20261011000004_strict_single_reversal_index`)

## Contexto
Reversões de transações financeiras de aposta ocorrem sob dois tipos:
- `REFUND`: Estorno regulatório ou de cancelamento de evento referente a uma aposta (`BET`).
- `ROLLBACK`: Cancelamento técnico de uma transação com falha anterior.

Na modelagem inicial, o índice `(reference_transaction_id, kind)` permitia que uma mesma aposta sofresse um `REFUND` e um `ROLLBACK` concorrentemente no banco, creditando o saldo do jogador duas vezes caso houvesse colisão ou envio indevido pelo provedor.

## Decisão
Implementou-se a migração `Migration20261011000004_strict_single_reversal_index`, aplicando um índice único parcial **sem a coluna `kind`**:
```sql
CREATE UNIQUE INDEX uq_wager_reference_reversal 
  ON wager_transactions (reference_transaction_id) 
  WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK');
```

**Semântica Adotada**:
1. **Regra Mais Estrita que o Enunciado**: Uma aposta (`BET`) só pode ter **uma única reversão processada** em todo o seu ciclo de vida (`REFUND` OU `ROLLBACK`). Qualquer tentativa de segunda reversão (mesmo que de tipo diferente) é bloqueada fisicamente pelo PostgreSQL (`23505 duplicate key`).
2. **Reversão em Cascata**: Um `ROLLBACK` que cancela um `REFUND` referencia o `transactionId` do próprio `REFUND`, e não o da `BET` original. Portanto, essa operação legítima não é bloqueada pelo índice.
3. **Mapeamento de Erro**: O caso de uso captura violações de `uq_wager_reference_reversal` e mapeia para `FailureCode.REFERENCE_ALREADY_REVERSED` (HTTP 422).
4. **Comportamento de Borda (ROLLBACK de REFUND vs Novo REFUND)**: Um `ROLLBACK(REFUND)` é permitido e referencia o ID do `REFUND`. Contudo, a aposta original (`BET`) mantém seu histórico referenciado pelo primeiro `REFUND` processado. Em conformidade com a unicidade estrita do índice e regra de domínio, qualquer tentativa posterior de submeter um novo `REFUND(BET)` é rejeitada com `REFERENCE_ALREADY_REVERSED`. O ciclo financeiro da aposta original é considerado imutavelmente encerrado.

## Consequências
- **Positivas**: Elimina qualquer possibilidade de crédito duplo concorrente na mesma aposta em nível físico de banco de dados.
- **Negativas**: A regra de negócio torna-se mais rígida, exigindo que estornos técnicos e de cancelamento não possam coexistir diretamente sobre o mesmo identificador de aposta. Caso um estorno tenha sido desfeito via rollback, um novo estorno sobre a aposta raiz exige intervenção ou conciliação manual.
