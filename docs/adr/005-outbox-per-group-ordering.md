# ADR-005: Publicação do Outbox em Ordem por Wallet (Lock Consultivo por Grupo)

## Status
Aceito e Implementado — substitui o item 4 do [ADR-002](./002-outbox-sqs-fifo-destination.md)

## Contexto
O SQS FIFO preserva a ordem **dentro de um `MessageGroupId` na ordem em que as mensagens são enviadas**. A ordem de envio, portanto, é responsabilidade do publisher. O desenho anterior selecionava um lote global com `FOR UPDATE SKIP LOCKED` e permitia duas inversões:
1. **Backoff:** se o envio do evento N de uma wallet falhava, o evento N+1 da mesma wallet (sem backoff) era publicado no ciclo seguinte, antes de N.
2. **Concorrência:** com várias instâncias, uma pegava os eventos 1–50 de uma wallet e outra, pulando as linhas travadas, pegava os eventos 51+ e os publicava em paralelo.

A alternativa direta, publicar apenas mensagens sem nenhuma anterior pendente no mesmo grupo, preserva a ordem, mas limita cada wallet a **uma mensagem por ciclo** (1 s), o que é inaceitável para uma wallet muito ativa.

## Decisão
1. `outbox_messages.message_group_id` é uma **coluna gerada** (`COALESCE(payload->'data'->>'walletId', aggregate_id::text)`), usada tanto para ordenar quanto como `MessageGroupId` no SQS. Nenhum caminho de escrita pode omiti-la ou divergir.
2. A cada ciclo, o publisher seleciona os grupos cuja mensagem **mais antiga** não publicada está liberada (`next_attempt_at` nulo ou vencido).
3. Para cada grupo, tenta `pg_try_advisory_xact_lock(hashtextextended('outbox:' || grupo, 0))`. Sem o lock, o grupo é pulado: outra instância está publicando essa wallet.
4. Com o lock, publica as mensagens do grupo em ordem `(occurred_at, id)` e **para na primeira mensagem em backoff ou com falha**.
5. O lock é liberado no commit da transação do ciclo.

## Consequências
- **Positivas:** ordem por wallet garantida mesmo com falhas e várias instâncias; vazão de até 50 mensagens por wallet por ciclo; wallets diferentes publicadas em paralelo por instâncias diferentes.
- **Negativas:** uma mensagem com falha persistente bloqueia apenas a sua wallet até ser publicada (o comportamento correto para eventos de saldo); colisões de hash entre grupos apenas serializam esses grupos, sem afetar a correção.
- **Verificação:** `src/test/integration/messaging-ordering.spec.ts` cobre a parada no primeiro evento com falha e a ordem com 3 publishers concorrentes em grupos de 60 mensagens. Sem o lock consultivo, esse teste falha.
