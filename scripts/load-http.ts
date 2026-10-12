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
}

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
  const deadline = performance.now() + opts.seconds * 1000;
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
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  console.log(`targets=${opts.targets.join(',')} vus=${opts.vus} seconds=${opts.seconds}\n`);
  console.log('| Cenário | Requisições | req/s | p50 (ms) | p95 (ms) | p99 (ms) | máx (ms) | Erros |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---|');
  for (const scenario of opts.scenarios) {
    const r = await runScenario(scenario, opts);
    const errors = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(', ') || '0';
    console.log(
      `| ${r.scenario} | ${r.requests} | ${r.rps.toFixed(1)} | ${r.p50.toFixed(0)} | ${r.p95.toFixed(0)} | ${r.p99.toFixed(0)} | ${r.max.toFixed(0)} | ${errors} |`,
    );
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`load-http failed: ${(err as Error).message}`);
    process.exit(1);
  });
}
