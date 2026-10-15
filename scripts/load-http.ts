/**
 * Closed-loop HTTP load test against running replicas (docker compose up -d --wait).
 *
 *   bun run load:http                         # both scenarios, 64 virtual users, 20 s each
 *   bun run load:http --vus 32 --seconds 10 --scenario hot
 *
 * Each virtual user sends a BET, waits for the response and sends the next one. Requests are
 * spread round-robin over LOAD_TARGETS (default: the three compose replicas).
 *   distributed: every virtual user bets on its own wallet (no lock contention)
 *   hot:         all virtual users bet on one wallet (worst case: serialized by the row lock)
 */
import { randomUUID } from 'crypto';

interface Options {
  vus: number;
  seconds: number;
  scenarios: Array<'distributed' | 'hot'>;
  targets: string[];
}

interface Result {
  scenario: string;
  requests: number;
  rps: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  errors: Record<string, number>;
  /** Lock/version conflicts and retries recorded by the replicas during the scenario (deltas). */
  lockConflicts: number;
  retries: number;
  /** Highest outbox lag (age of the oldest unpublished event) and backlog seen while loading. */
  maxOutboxLagSeconds: number;
  maxOutboxPending: number;
  /** Time for the outbox to be fully published after the load stopped. */
  drainSeconds: number;
}

/** Sum of every sample of a Prometheus metric in the text exposition format. */
function metricSum(text: string, name: string): number {
  let sum = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith(name + ' ') || line.startsWith(name + '{')) {
      const value = Number(line.slice(line.lastIndexOf(' ') + 1));
      if (Number.isFinite(value)) sum += value;
    }
  }
  return sum;
}

async function scrape(targets: string[]): Promise<string[]> {
  return Promise.all(targets.map((t) => fetch(`${t}/metrics`).then((r) => r.text()).catch(() => '')));
}

const sumAcross = (texts: string[], name: string) => texts.reduce((acc, t) => acc + metricSum(t, name), 0);
const maxAcross = (texts: string[], name: string) => Math.max(0, ...texts.map((t) => metricSum(t, name)));

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    vus: 64,
    seconds: 20,
    scenarios: ['distributed', 'hot'],
    targets: (process.env.LOAD_TARGETS || 'http://localhost:3011,http://localhost:3012,http://localhost:3013').split(','),
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = argv[++i];
    if (arg === '--vus') opts.vus = Number(value);
    else if (arg === '--seconds') opts.seconds = Number(value);
    else if (arg === '--scenario' && (value === 'distributed' || value === 'hot')) opts.scenarios = [value];
    else throw new Error(`Unknown argument: ${arg} ${value ?? ''}`);
  }
  return opts;
}

/** Nearest-rank percentile over sorted latencies. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

async function openWallet(target: string): Promise<{ id: string; playerId: string }> {
  const playerId = randomUUID();
  const res = await fetch(`${target}/wallets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ playerId, initialBalance: { amount: '1000000.00', currency: 'BRL' } }),
  });
  if (res.status !== 201) throw new Error(`wallet creation failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ id: string; playerId: string }>;
}

async function runScenario(scenario: 'distributed' | 'hot', opts: Options): Promise<Result> {
  const shared = scenario === 'hot' ? await openWallet(opts.targets[0]!) : undefined;
  const wallets = await Promise.all(
    Array.from({ length: opts.vus }, () => shared ?? openWallet(opts.targets[0]!)),
  );

  const latencies: number[] = [];
  const errors: Record<string, number> = {};
  const before = await scrape(opts.targets);
  const deadline = performance.now() + opts.seconds * 1000;

  // Outbox lag/backlog sampled while the load runs (gauges refreshed by every publisher poll)
  let maxOutboxLagSeconds = 0;
  let maxOutboxPending = 0;
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      const texts = await scrape(opts.targets);
      maxOutboxLagSeconds = Math.max(maxOutboxLagSeconds, maxAcross(texts, 'wagering_outbox_lag_seconds'));
      maxOutboxPending = Math.max(maxOutboxPending, maxAcross(texts, 'wagering_outbox_pending_messages'));
      await new Promise((r) => setTimeout(r, 500));
    }
  })();
  let next = 0;

  const virtualUser = async (wallet: { id: string; playerId: string }) => {
    while (performance.now() < deadline) {
      const target = opts.targets[next++ % opts.targets.length]!;
      const ext = randomUUID();
      const t0 = performance.now();
      try {
        const res = await fetch(`${target}/wagering/transactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Idempotency-Key': `load:${ext}` },
          body: JSON.stringify({
            providerId: 'load',
            externalTransactionId: ext,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: 'load-round',
            gameId: 'load-game',
            kind: 'BET',
            money: { amount: '1.00', currency: 'BRL' },
          }),
        });
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        if (res.status !== 200) errors[`HTTP_${res.status}`] = (errors[`HTTP_${res.status}`] ?? 0) + 1;
      } catch (err) {
        errors[(err as Error).name] = (errors[(err as Error).name] ?? 0) + 1;
      }
    }
  };

  const started = performance.now();
  await Promise.all(wallets.map(virtualUser));
  const elapsed = (performance.now() - started) / 1000;
  sampling = false;
  await sampler;

  const after = await scrape(opts.targets);
  const delta = (name: string) => sumAcross(after, name) - sumAcross(before, name);

  // Drain: until every replica reports an empty outbox (bounded)
  const drainStart = performance.now();
  for (let i = 0; i < 120; i++) {
    const texts = await scrape(opts.targets);
    if (maxAcross(texts, 'wagering_outbox_pending_messages') === 0) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const drainSeconds = (performance.now() - drainStart) / 1000;

  latencies.sort((a, b) => a - b);
  return {
    scenario,
    requests: latencies.length,
    rps: latencies.length / elapsed,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1] ?? 0,
    errors,
    lockConflicts: delta('wagering_optimistic_lock_conflicts_total'),
    retries: delta('wagering_retry_attempts_total'),
    maxOutboxLagSeconds,
    maxOutboxPending,
    drainSeconds,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`targets=${opts.targets.join(',')} vus=${opts.vus} seconds=${opts.seconds}\n`);
  console.log(
    '| Cenário | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Taxa de erro | Erros | Conflitos de lock | Retries | Outbox lag máx (s) | Outbox pendente máx | Drenagem (s) |',
  );
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|');
  for (const scenario of opts.scenarios) {
    const r = await runScenario(scenario, opts);
    const errorCount = Object.values(r.errors).reduce((a, b) => a + b, 0);
    const errorRate = r.requests > 0 ? ((errorCount / r.requests) * 100).toFixed(2) + '%' : '-';
    const errors = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(', ') || '0';
    console.log(
      `| ${r.scenario} | ${r.requests} | ${r.rps.toFixed(1)} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.p99.toFixed(0)} | ${r.max.toFixed(0)} | ${errorRate} | ${errors} | ${r.lockConflicts} | ${r.retries} | ${r.maxOutboxLagSeconds.toFixed(2)} | ${r.maxOutboxPending} | ${r.drainSeconds.toFixed(1)} |`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`load-http failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
