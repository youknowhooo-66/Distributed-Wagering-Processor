/**
 * Operational DLQ redrive (see docs/OPERATIONS_RUNBOOK.md, section 4.1).
 *
 *   bun run dlq:redrive --reason HTTP_404              # dry-run: lists what would move
 *   bun run dlq:redrive --reason HTTP_404 --execute    # moves them back to the main queue
 *
 * Options: --reason <FailureReason> (repeatable, required), --execute, --max <n> (default 100).
 * Queue URLs come from SQS_WAGER_QUEUE_URL / SQS_WAGER_DLQ_URL (LocalStack defaults otherwise).
 */
import { createSqsClient } from '../src/shared/infrastructure/messaging/sqs.client';
import { redriveDlq } from '../src/wagering/infrastructure/messaging/dlq-redrive';

function parseArgs(argv: string[]) {
  const reasons: string[] = [];
  let execute = false;
  let max = 100;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--reason') reasons.push(argv[++i] ?? '');
    else if (arg === '--execute') execute = true;
    else if (arg === '--max') max = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (reasons.length === 0 || reasons.some((r) => !r)) {
    throw new Error('At least one --reason <FailureReason> is required (e.g. --reason HTTP_404)');
  }
  if (!Number.isInteger(max) || max < 1) throw new Error('--max must be a positive integer');
  return { reasons, execute, max };
}

async function main() {
  const { reasons, execute, max } = parseArgs(process.argv.slice(2));
  const { items, blockedGroups } = await redriveDlq({
    sqs: createSqsClient(),
    queueUrl: process.env.SQS_WAGER_QUEUE_URL || 'http://localhost:4566/000000000000/wager-transactions.fifo',
    dlqUrl: process.env.SQS_WAGER_DLQ_URL || 'http://localhost:4566/000000000000/wager-transactions-dlq.fifo',
    reasons,
    dryRun: !execute,
    maxMessages: max,
  });

  for (const item of items) {
    console.log(`${item.action.padEnd(13)} ${item.reason.padEnd(24)} group=${item.groupId} message=${item.messageId}`);
  }
  console.log(
    `\n${items.length} inspected, ${items.filter((i) => i.action === 'redriven').length} redriven` +
      (execute ? '' : ' (dry-run: use --execute to move them)'),
  );
  if (blockedGroups.length > 0) {
    console.log(`Groups with later messages not inspected (head skipped): ${blockedGroups.join(', ')}`);
  }
}

main().catch((err) => {
  console.error(`dlq-redrive failed: ${(err as Error).message}`);
  process.exit(1);
});
