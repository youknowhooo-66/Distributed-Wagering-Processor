import {
  SQSClient,
  ReceiveMessageCommand,
  SendMessageCommand,
  DeleteMessageCommand,
  ChangeMessageVisibilityCommand,
  Message,
} from '@aws-sdk/client-sqs';

export interface RedriveOptions {
  sqs: SQSClient;
  dlqUrl: string;
  queueUrl: string;
  /** Only messages whose FailureReason is in this list are moved back. */
  reasons: string[];
  /** When true nothing is sent or deleted; the report shows what would happen. */
  dryRun: boolean;
  maxMessages: number;
}

export interface RedriveItem {
  messageId: string;
  groupId: string;
  reason: string;
  action: 'redriven' | 'would_redrive' | 'skipped';
}

/**
 * Moves selected messages from the wager DLQ back to the main queue.
 *
 * FIFO semantics: a group's next message is only delivered after the current one leaves the
 * queue, so a skipped message keeps its group's later messages out of this run (reported via
 * `blockedGroups`). Skipped messages are made visible again at the end. A message is deleted
 * from the DLQ only after the main queue accepted the copy.
 */
export async function redriveDlq(opts: RedriveOptions): Promise<{ items: RedriveItem[]; blockedGroups: string[] }> {
  const items: RedriveItem[] = [];
  const held: string[] = []; // receipt handles kept in flight during the run
  const blockedGroups = new Set<string>();
  const seen = new Set<string>();

  try {
    while (items.length < opts.maxMessages) {
      const res = await opts.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: opts.dlqUrl,
          MaxNumberOfMessages: Math.min(10, opts.maxMessages - items.length),
          WaitTimeSeconds: 1,
          VisibilityTimeout: 120,
          MessageAttributeNames: ['All'],
          MessageSystemAttributeNames: ['MessageGroupId'],
        }),
      );
      const batch = (res.Messages ?? []).filter((m) => m.MessageId && !seen.has(m.MessageId));
      if (batch.length === 0) break;

      for (const msg of batch) {
        seen.add(msg.MessageId!);
        items.push(await handle(opts, msg, held, blockedGroups));
      }
    }
  } finally {
    // Skipped / dry-run messages go back to the DLQ untouched
    for (const handle of held) {
      await opts.sqs
        .send(new ChangeMessageVisibilityCommand({ QueueUrl: opts.dlqUrl, ReceiptHandle: handle, VisibilityTimeout: 0 }))
        .catch(() => {});
    }
  }
  return { items, blockedGroups: [...blockedGroups] };
}

async function handle(
  opts: RedriveOptions,
  msg: Message,
  held: string[],
  blockedGroups: Set<string>,
): Promise<RedriveItem> {
  const reason = msg.MessageAttributes?.FailureReason?.StringValue ?? 'UNSPECIFIED';
  const groupId = msg.Attributes?.MessageGroupId ?? 'unknown';
  const base = { messageId: msg.MessageId!, groupId, reason };

  if (!opts.reasons.includes(reason)) {
    held.push(msg.ReceiptHandle!);
    blockedGroups.add(groupId);
    return { ...base, action: 'skipped' };
  }
  if (opts.dryRun) {
    held.push(msg.ReceiptHandle!);
    blockedGroups.add(groupId);
    return { ...base, action: 'would_redrive' };
  }

  await opts.sqs.send(
    new SendMessageCommand({
      QueueUrl: opts.queueUrl,
      MessageBody: msg.Body!,
      MessageGroupId: groupId,
      // A fresh id: the original may still be inside the queue's 5-minute dedup window
      MessageDeduplicationId: `redrive-${msg.MessageId}-${Date.now()}`,
    }),
  );
  await opts.sqs.send(new DeleteMessageCommand({ QueueUrl: opts.dlqUrl, ReceiptHandle: msg.ReceiptHandle! }));
  return { ...base, action: 'redriven' };
}
