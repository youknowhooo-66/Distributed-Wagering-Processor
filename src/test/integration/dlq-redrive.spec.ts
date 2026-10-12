import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import {
  SQSClient,
  CreateQueueCommand,
  DeleteQueueCommand,
  SendMessageCommand,
  ReceiveMessageCommand,
} from '@aws-sdk/client-sqs';
import { redriveDlq } from '../../wagering/infrastructure/messaging/dlq-redrive';
import { generateId } from '../../shared/domain/identifier';

/** Runs against real LocalStack FIFO queues created only for this test. */
describe('DLQ redrive tool', () => {
  const sqs = new SQSClient({
    endpoint: 'http://localhost:4566',
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const suffix = generateId().slice(-12);
  let queueUrl: string;
  let dlqUrl: string;

  beforeAll(async () => {
    const attrs = { FifoQueue: 'true', ContentBasedDeduplication: 'true' };
    queueUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `redrive-main-${suffix}.fifo`, Attributes: attrs }))).QueueUrl!;
    dlqUrl = (await sqs.send(new CreateQueueCommand({ QueueName: `redrive-dlq-${suffix}.fifo`, Attributes: attrs }))).QueueUrl!;
  });

  afterAll(async () => {
    await sqs.send(new DeleteQueueCommand({ QueueUrl: queueUrl })).catch(() => {});
    await sqs.send(new DeleteQueueCommand({ QueueUrl: dlqUrl })).catch(() => {});
  });

  async function drain(url: string): Promise<string[]> {
    const bodies: string[] = [];
    for (let i = 0; i < 5; i++) {
      const res = await sqs.send(
        new ReceiveMessageCommand({ QueueUrl: url, MaxNumberOfMessages: 10, WaitTimeSeconds: 1, VisibilityTimeout: 30 }),
      );
      if (!res.Messages?.length) break;
      bodies.push(...res.Messages.map((m) => m.Body!));
    }
    return bodies;
  }

  it('dry-run moves nothing; execute moves only the selected reasons and keeps the group', async () => {
    const toDlq = (body: string, group: string, reason: string) =>
      sqs.send(
        new SendMessageCommand({
          QueueUrl: dlqUrl,
          MessageBody: body,
          MessageGroupId: group,
          MessageAttributes: { FailureReason: { DataType: 'String', StringValue: reason } },
        }),
      );
    await toDlq('{"case":"missing-wallet"}', 'wallet-a', 'HTTP_404');
    await toDlq('{"case":"bad-contract"}', 'wallet-b', 'INVALID_CONTRACT');

    const dry = await redriveDlq({ sqs, dlqUrl, queueUrl, reasons: ['HTTP_404'], dryRun: true, maxMessages: 10 });
    expect(dry.items.map((i) => [i.reason, i.action]).sort()).toEqual([
      ['HTTP_404', 'would_redrive'],
      ['INVALID_CONTRACT', 'skipped'],
    ]);

    const run = await redriveDlq({ sqs, dlqUrl, queueUrl, reasons: ['HTTP_404'], dryRun: false, maxMessages: 10 });
    expect(run.items.find((i) => i.reason === 'HTTP_404')).toMatchObject({ action: 'redriven', groupId: 'wallet-a' });

    expect(await drain(queueUrl)).toEqual(['{"case":"missing-wallet"}']);
    expect(await drain(dlqUrl)).toEqual(['{"case":"bad-contract"}']);
  });
});
