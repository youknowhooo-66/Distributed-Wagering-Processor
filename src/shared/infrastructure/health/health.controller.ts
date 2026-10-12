import { Controller, Get, HttpStatus, Res } from '@nestjs/common';
import type { Response } from 'express';
import { EntityManager } from '@mikro-orm/postgresql';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { createSqsClient } from '../messaging/sqs.client';

@Controller('health')
export class HealthController {
  private sqsClient: SQSClient;

  constructor(private readonly em: EntityManager) {
    this.sqsClient = createSqsClient();
  }

  @Get('live')
  live() {
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  @Get('ready')
  async ready(@Res() res: Response) {
    let pgOk = false;
    let pgLatencyMs = 0;
    let sqsOk = false;
    let sqsLatencyMs = 0;

    // Check Postgres
    try {
      const t0 = Date.now();
      await this.em.getConnection().execute('SELECT 1');
      pgLatencyMs = Date.now() - t0;
      pgOk = true;
    } catch {
      pgOk = false;
    }

    // Check SQS
    try {
      const t0 = Date.now();
      await this.sqsClient.send(new ListQueuesCommand({ MaxResults: 1 }));
      sqsLatencyMs = Date.now() - t0;
      sqsOk = true;
    } catch {
      sqsOk = false;
    }

    const allHealthy = pgOk && sqsOk;
    const status = allHealthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE;

    return res.status(status).json({
      status: allHealthy ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      checks: {
        postgresql: {
          status: pgOk ? 'ok' : 'error',
          latencyMs: pgLatencyMs,
        },
        sqs: {
          status: sqsOk ? 'ok' : 'error',
          latencyMs: sqsLatencyMs,
        },
      },
    });
  }
}
