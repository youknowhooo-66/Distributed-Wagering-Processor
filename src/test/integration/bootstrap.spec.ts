import { describe, it, expect, afterAll } from 'bun:test';
import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../../app.module';

describe('Bootstrap — full AppModule DI graph', () => {
  let app: INestApplication | undefined;

  afterAll(async () => {
    await app?.close();
  });

  it('resolves every provider and serves /health/ready', async () => {
    // abortOnError: false surfaces DI failures as a test failure instead of a silent process.exit(1)
    app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
    await app.listen(0);
    const port = (app.getHttpServer().address() as { port: number }).port;

    const res = await fetch(`http://localhost:${port}/health/ready`);
    expect(res.status).toBe(200);
  });
});
