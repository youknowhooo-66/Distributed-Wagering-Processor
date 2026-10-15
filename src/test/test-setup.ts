import { Logger } from '@nestjs/common';
import { setDefaultTimeout } from 'bun:test';

process.env.ENABLE_BACKGROUND_POLL = 'false';
// Keep test output readable: only errors from the application loggers (override with LOG_LEVEL)
process.env.LOG_LEVEL ??= 'error';
if (process.env.LOG_LEVEL === 'error') Logger.overrideLogger(['error', 'fatal']);
// Plain `bun test` (without --timeout) must not fail the slow multi-process and load scenarios
setDefaultTimeout(120_000);
