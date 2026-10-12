import { Module, Global } from '@nestjs/common';
import { HealthController } from './infrastructure/health/health.controller';
import { MetricsController } from './infrastructure/metrics/metrics.controller';
import { NoopAuthGuard } from './application/ports/auth.guard';
import { UnitOfWork } from './application/ports/unit-of-work.port';
import { MikroOrmUnitOfWork } from './infrastructure/database/mikro-orm-unit-of-work';
import { WageringMetrics } from './application/ports/wagering-metrics.port';
import { PrometheusWageringMetrics } from './infrastructure/metrics/prometheus-wagering-metrics';

@Global()
@Module({
  controllers: [HealthController, MetricsController],
  providers: [
    NoopAuthGuard,
    { provide: UnitOfWork, useClass: MikroOrmUnitOfWork },
    { provide: WageringMetrics, useClass: PrometheusWageringMetrics },
  ],
  exports: [NoopAuthGuard, UnitOfWork, WageringMetrics],
})
export class SharedModule {}
