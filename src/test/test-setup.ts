import { Logger } from '@nestjs/common';

process.env.ENABLE_BACKGROUND_POLL = 'false';
// Keep test output readable: only errors from the application loggers (override with LOG_LEVEL)
process.env.LOG_LEVEL ??= 'error';
if (process.env.LOG_LEVEL === 'error') Logger.overrideLogger(['error', 'fatal']);
