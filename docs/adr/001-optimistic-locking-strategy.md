> O nome do arquivo (`optimistic-locking-strategy`) é histórico: a decisão registrada aqui é o lock pessimista por linha.

# ADR-001: Estratégia de Concorrência — Bloqueio Pessimista por Linha (`SELECT ... FOR UPDATE`) com Barreiras Otimista e Relacional

## Status
Aceito e Implementado

## Contexto
O processamento de apostas e mutações de saldo em iGaming exige alto throughput e latência controlada. Sob concorrência distribuída de múltiplos nós de aplicação, requisições paralelas direcionadas à mesma carteira (hot wallet) não podem sobrescrever dados nem permitir saldo negativo sob nenhuma hipótese.

Avaliou-se as duas abordagens fundamentais:
1. **Bloqueio Otimista puro (`version`)**: Lê o saldo sem lock e incrementa `version` no UPDATE com `WHERE id = ? AND version = ?`. Em alta contenção na mesma carteira, múltiplas transações competem e a grande maioria falha com `OptimisticLockError`, exigindo retries sucessivos na aplicação.
2. **Bloqueio Pessimista por Linha (`SELECT ... FOR UPDATE`)**: Serializa transações disputando a mesma carteira na ordem de chegada diretamente na linha do PostgreSQL (`wallets` por chave primária), enfileirando as conexões em nível de banco de dados com resolução sub-milissegundo.

## Decisão
Adotou-se **Bloqueio Pessimista por Linha** na carteira (`SELECT ... FOR UPDATE` via MikroORM `LockMode.PESSIMISTIC_WRITE`) adquirido no início de cada transação de use case (`ProcessWagerTransactionUseCase`), aliado a:
1. **Ordem Consistente de Bloqueio**: O lock da carteira é adquirido primeiro, antes de qualquer escrita no banco, eliminando deadlocks entre transações financeiras.
2. **`lock_timeout` Curto no PostgreSQL**: Parâmetro de sessão de cada conexão do pool (`-c lock_timeout=5000ms` ao conectar, `DB_LOCK_TIMEOUT_MS`); até 12/10/2026 era um `SET LOCAL` por transação, uma ida ao banco a mais em cada aposta. Mapeia timeouts eventuais para HTTP 503 com cabeçalho `Retry-After: 1`.
3. **Barreiras de Segurança Adicionais**:
   - Coluna inteira `version` mantida com incremento automático no agregado e persistência (`WalletMikroEntity.version`).
   - Constraint relacional `chk_wallets_balance_non_negative CHECK (balance_amount >= 0)` como barreira definitiva contra saldo negativo.
4. **Proteção no Consumer SQS**: Erros de contenção de concorrência ou timeout de lock são tratados estritamente como transitórios, sofrendo backoff exponencial via `ChangeMessageVisibilityCommand`, impedindo que mensagens válidas sejam descartadas ou enviadas à DLQ por mera contenção de fila.
5. **Consumo de Outbox**: publishers paralelos usam lock consultivo por wallet na tabela `outbox_messages`, preservando a ordem por wallet (ver [ADR-005](./005-outbox-per-group-ordering.md)).
6. **Erros tipados**: o adaptador `MikroOrmUnitOfWork` traduz `55P03` (lock timeout), `40P01` (deadlock), `40001` (serialização) e `OptimisticLockError` em `ConcurrencyConflictError`; o caso de uso retenta sem inspecionar mensagens do driver.

## O Trade-off Real: Fila por Linha vs. Retentativas de Aplicação
- **Com Lock Otimista (Antes)**:
  - 30 rodadas de 50 apostas simultâneas na mesma carteira geraram **24 respostas 503 em 16 rodadas**, com uma média de **118 conflitos de lock por rodada**.
  - Em rajadas de 100 apostas, **19% das requisições resultaram em 503**.
  - No consumidor SQS, o esgotamento das tentativas de retry levava apostas perfeitamente válidas à DLQ por simples contenção.
- **Com Bloqueio Pessimista por Linha (Depois)**:
  - 30 rodadas consecutivas de 50 apostas simultâneas na mesma carteira alcançam **50/50 PROCESSED em 30 de 30 rodadas (100% de sucesso, 0 respostas 503 e 0 conflitos)**.
  - Testes com 100 e 200 apostas simultâneas na mesma carteira alcançam **100% de processamento com zero erros 503**.
  - A fila por linha no PostgreSQL tem overhead desprezível (~2ms por aposta sequencial) comparado ao custo de rede, CPU e retry storm do lock otimista sob alta contenção.

## Consequências
- **Positivas**: Eliminação completa de rejeições 503 por contenção em hot wallets; latência p50 previsível; ausência de deadlocks pela aquisição consistente de lock no início da transação; reconciliação contábil exata de 100% das transações.
- **Negativas**: Transações que afetam a mesma carteira física aguardam a conclusão da transação anterior no banco; carteiras distintas continuam operando em paralelo total sem qualquer interferência mútua.
