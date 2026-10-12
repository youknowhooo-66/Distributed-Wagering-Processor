# ADR-002: Publicação Assíncrona via Outbox Pattern para SQS FIFO

## Status
Aceito e Implementado

## Contexto
O processamento de apostas precisa despachar eventos de domínio (`WalletBalanceChanged`, `WagerTransactionProcessed`, etc.) para filas externas sem incorrer no risco de dual-write ou perda de eventos.

## Decisão
1. **Destino Único**: O `OutboxPublisherWorker` despacha eventos exclusivamente para a fila **Amazon SQS FIFO** (`http://localhost:4566/000000000000/wagering-events.fifo`).
2. **Chave de Agrupamento (`MessageGroupId`)**:
   - Para garantir estrita ordenação cronológica das mutações de saldo por carteira, o `MessageGroupId` é extraído do `walletId` da operação contida no payload do evento.
   - Caso `walletId` não esteja presente no payload, utiliza-se `aggregate_id`.
3. **Chave de Deduplicação (`MessageDeduplicationId`)**:
   - É fixada com o `eventId` único do evento (UUID v7), garantindo que mensagens idênticas despachadas dentro de uma janela de 5 minutos sejam desduplicadas no SQS.
4. **Mecanismo de Despacho Concorrente**:
   - ~~`SELECT ... FOR UPDATE SKIP LOCKED` por lote~~ — substituído por lock consultivo por grupo, ver [ADR-005](./005-outbox-per-group-ordering.md). O `SKIP LOCKED` por lote permitia que uma mensagem posterior de uma wallet fosse publicada antes de uma anterior em backoff ou nas mãos de outra instância.
   - Mensagens despachadas com sucesso recebem `published_at = NOW()`. Mensagens com falha de rede sofrem incremento em `attempts` e agendamento de retentativa exponencial em `next_attempt_at`.

## Consequências
- **Positivas**: Eliminação de colisões entre instâncias de worker; ordenação cronológica preservada por carteira de jogador; compatibilidade total com SQS FIFO local e em nuvem AWS.
- **Negativas**: A fila SQS FIFO impõe throughput máximo por group ID, o que exige que a granularidade de agrupamento permaneça no nível de carteira individual (`walletId`).
