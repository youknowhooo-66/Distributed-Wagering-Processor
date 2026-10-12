import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../../shared/infrastructure/database/mikro-orm.config';
import { OpenWalletUseCase } from '../../wallet/application/use-cases/open-wallet.use-case';
import { ProcessWagerTransactionUseCase } from '../../wagering/application/use-cases/process-wager-transaction.use-case';
import { WalletRepository } from '../../wallet/infrastructure/persistence/wallet.repository';
import { WagerTransactionRepository } from '../../wagering/infrastructure/persistence/wager-transaction.repository';
import { SqsWagerConsumer } from '../../wagering/infrastructure/messaging/sqs-wager.consumer';
import { OutboxPublisherWorker } from '../../wagering/infrastructure/messaging/outbox-publisher.worker';
import { WagerTransactionKind } from '../../wagering/domain/wager-transaction.entity';
import { generateId } from '../../shared/domain/identifier';
import { MikroOrmUnitOfWork } from '../../shared/infrastructure/database/mikro-orm-unit-of-work';

/**
 * P1 messaging guarantees: per-group FIFO order in the consumer and in the outbox,
 * no message loss when the DLQ is unavailable, and permanent errors going straight to the DLQ.
 * PostgreSQL and the use case are real; only SQS responses are scripted where a failure
 * must be injected deterministically.
 */
describe('Messaging — FIFO ordering, DLQ safety and outbox order', () => {
  let orm: MikroORM;
  let processWager: ProcessWagerTransactionUseCase;
  let openWallet: OpenWalletUseCase;

  beforeAll(async () => {
    orm = await MikroORM.init(config);
    processWager = new ProcessWagerTransactionUseCase(new MikroOrmUnitOfWork(orm.em));
    openWallet = new OpenWalletUseCase(new MikroOrmUnitOfWork(orm.em));
  });

  afterAll(async () => {
    await orm.close();
  });

  function envelope(walletId: string, playerId: string, amount = '1.00') {
    const ext = 'ext-' + generateId();
    return JSON.stringify({
      messageId: 'msg-' + generateId(),
      type: 'WagerTransactionRequested',
      occurredAt: new Date().toISOString(),
      data: {
        providerId: 'prov-p1',
        externalTransactionId: ext,
        idempotencyKey: 'prov-p1:' + ext,
        playerId,
        walletId,
        roundId: 'r1',
        gameId: 'g1',
        kind: WagerTransactionKind.Bet,
        money: { amount, currency: 'BRL' },
      },
    });
  }

  /** Consumer whose SQS client returns `messages` once and records every command. */
  function scriptedConsumer(
    messages: object[],
    opts: { failDlqSend?: boolean } = {},
  ): { consumer: SqsWagerConsumer; commands: any[] } {
    const consumer = new SqsWagerConsumer(processWager);
    const commands: any[] = [];
    (consumer as any).sqsClient = {
      send: async (cmd: any) => {
        commands.push(cmd);
        const name = cmd.constructor?.name;
        if (name === 'ReceiveMessageCommand') return { Messages: messages };
        if (name === 'SendMessageCommand' && opts.failDlqSend) throw new Error('DLQ unavailable');
        return {};
      },
    };
    (consumer as any).isRunning = true;
    return { consumer, commands };
  }

  const named = (commands: any[], name: string) =>
    commands.filter((c) => c.constructor?.name === name);

  it('does not process later messages of a group whose head failed in the same batch', async () => {
    const playerId = generateId();
    const wallet = await openWallet.execute({ playerId, initialBalance: { amount: '10.00', currency: 'BRL' } });
    const otherPlayer = generateId();
    const other = await openWallet.execute({ playerId: otherPlayer, initialBalance: { amount: '10.00', currency: 'BRL' } });

    const msgs = [
      { MessageId: 'm1', ReceiptHandle: 'rh-1', Body: envelope(wallet.id, playerId), Attributes: { ApproximateReceiveCount: '1', MessageGroupId: wallet.id } },
      { MessageId: 'm2', ReceiptHandle: 'rh-2', Body: envelope(wallet.id, playerId), Attributes: { ApproximateReceiveCount: '1', MessageGroupId: wallet.id } },
      { MessageId: 'm3', ReceiptHandle: 'rh-3', Body: envelope(other.id, otherPlayer), Attributes: { ApproximateReceiveCount: '1', MessageGroupId: other.id } },
    ];
    const { consumer, commands } = scriptedConsumer(msgs);

    const processed: string[] = [];
    const original = processWager.execute.bind(processWager);
    processWager.execute = async (cmd) => {
      processed.push(cmd.walletId);
      if (cmd.walletId === wallet.id) throw new Error('Simulated transient failure');
      return original(cmd);
    };
    try {
      await consumer.pollMessages();
    } finally {
      processWager.execute = original;
    }

    // m1 failed -> m2 (same wallet) is not executed; m3 (other wallet) is unaffected
    expect(processed).toEqual([wallet.id, other.id]);
    const visibility = named(commands, 'ChangeMessageVisibilityCommand');
    expect(visibility.find((c) => c.input.ReceiptHandle === 'rh-1')?.input.VisibilityTimeout).toBe(10);
    expect(visibility.find((c) => c.input.ReceiptHandle === 'rh-2')?.input.VisibilityTimeout).toBe(0);
    const deleted = named(commands, 'DeleteMessageCommand').map((c) => c.input.ReceiptHandle);
    expect(deleted).toEqual(['rh-3']);
  });

  it('keeps the message in the main queue when forwarding to the DLQ fails', async () => {
    const msgs = [
      { MessageId: 'poison', ReceiptHandle: 'rh-poison', Body: 'not json', Attributes: { ApproximateReceiveCount: '1' } },
    ];
    const { consumer, commands } = scriptedConsumer(msgs, { failDlqSend: true });

    await consumer.pollMessages();

    expect(named(commands, 'SendMessageCommand')).toHaveLength(1);
    expect(named(commands, 'DeleteMessageCommand')).toHaveLength(0);
  });

  it('sends permanent errors (wallet not found, invalid contract) straight to the DLQ on first receive', async () => {
    const missingWallet = generateId();
    const invalid = JSON.parse(envelope(generateId(), generateId()));
    invalid.data.money.amount = '0.00'; // zero BET: contract violation
    const msgs = [
      { MessageId: 'nf', ReceiptHandle: 'rh-nf', Body: envelope(missingWallet, generateId()), Attributes: { ApproximateReceiveCount: '1', MessageGroupId: missingWallet } },
      { MessageId: 'iv', ReceiptHandle: 'rh-iv', Body: JSON.stringify(invalid), Attributes: { ApproximateReceiveCount: '1' } },
    ];
    const { consumer, commands } = scriptedConsumer(msgs);

    await consumer.pollMessages();

    const dlq = named(commands, 'SendMessageCommand');
    expect(dlq.map((c) => c.input.MessageAttributes.FailureReason.StringValue)).toEqual([
      'HTTP_404',
      'INVALID_CONTRACT',
    ]);
    expect(named(commands, 'DeleteMessageCommand').map((c) => c.input.ReceiptHandle)).toEqual(['rh-nf', 'rh-iv']);
  });

  describe('outbox publisher', () => {
    async function insertGroup(groupId: string, count: number): Promise<string[]> {
      const conn = orm.em.fork().getConnection();
      const base = Date.now() - 60_000;
      const ids: string[] = [];
      for (let i = 0; i < count; i++) {
        const id = generateId();
        ids.push(id);
        await conn.execute(
          `INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
           VALUES (?, ?, 'WalletBalanceChanged', ?::jsonb, ?)`,
          [id, id, JSON.stringify({ eventId: 'evt-' + id, data: { walletId: groupId, seq: i } }), new Date(base + i)],
        );
      }
      return ids;
    }

    function recordingWorker(sent: { group: string; seq: number }[], failEventIds = new Set<string>()) {
      const worker = new OutboxPublisherWorker(orm.em);
      (worker as any).sqsClient = {
        send: async (cmd: any) => {
          const body = JSON.parse(cmd.input.MessageBody);
          if (failEventIds.has(body.eventId)) throw new Error('SQS unavailable');
          await new Promise((r) => setTimeout(r, 2));
          sent.push({ group: cmd.input.MessageGroupId, seq: body.data.seq });
          return {};
        },
      };
      return worker;
    }

    it('stops a group at the first failed message so later events never overtake it', async () => {
      const group = generateId();
      const ids = await insertGroup(group, 3);
      const sent: { group: string; seq: number }[] = [];

      await recordingWorker(sent, new Set(['evt-' + ids[0]])).pollAndPublish();
      expect(sent.filter((s) => s.group === group)).toEqual([]);

      // Head becomes due again and SQS recovers: all three go out in order
      await orm.em.fork().getConnection().execute(
        `UPDATE outbox_messages SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = ?`,
        [ids[0]],
      );
      await recordingWorker(sent).pollAndPublish();
      expect(sent.filter((s) => s.group === group).map((s) => s.seq)).toEqual([0, 1, 2]);
    });

    it('keeps per-group order with concurrent publishers', async () => {
      // More messages per group than one publisher takes per poll (50), so a second
      // publisher could otherwise grab the tail of a group while the head is in flight
      const groups = [generateId(), generateId()];
      for (const g of groups) await insertGroup(g, 60);
      const sent: { group: string; seq: number }[] = [];

      await Promise.all([
        recordingWorker(sent).pollAndPublish(),
        recordingWorker(sent).pollAndPublish(),
        recordingWorker(sent).pollAndPublish(),
      ]);
      // Drain what was left behind (locked groups, tails beyond one batch)
      while ((await recordingWorker(sent).pollAndPublish()) > 0);

      for (const g of groups) {
        expect(sent.filter((s) => s.group === g).map((s) => s.seq)).toEqual([...Array(60).keys()]);
      }
    });
  });
});
