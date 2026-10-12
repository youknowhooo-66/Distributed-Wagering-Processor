# Test Execution Evidence

Execution: 2026-10-11T21:16:29Z → 2026-10-11T21:17:10Z  
Host: Darwin 24.6.0 arm64 (Apple Silicon)  
Runtime: Bun v1.4.2

## Resumo Final

| Suíte | Arquivos | Testes | Falhas |
|---|---|---|---|
| Unit | 6 | **56** | 0 |
| Integration | 5 | **39** | 0 |
| Concurrency | 2 | **6** | 0 |
| Load | 1 | **1** | 0 |
| **Total** | **14** | **102** | **0** |

## Unit Tests
```
(pass) WagerTransaction Entity > creation and invariants > creates in PENDING state [0.08ms]
(pass) WagerTransaction Entity > creation and invariants > requires reference for REFUND and ROLLBACK [0.05ms]
(pass) WagerTransaction Entity > creation and invariants > recognizes LOSS does not affect balance [0.01ms]
(pass) WagerTransaction Entity > state transitions > transitions from PENDING to PROCESSED [0.04ms]
(pass) WagerTransaction Entity > state transitions > transitions from PENDING to REJECTED [0.02ms]
(pass) WagerTransaction Entity > state transitions > transitions from PENDING to PENDING_REFERENCE and then PROCESSED [0.03ms]
(pass) WagerTransaction Entity > state transitions > throws InvalidTransactionStateError if attempting transition from terminal status [0.08ms]
(pass) WagerTransaction Entity > ledger direction resolution > determines BET direction as DEBIT [0.03ms]
(pass) WagerTransaction Entity > ledger direction resolution > determines WIN direction as CREDIT
(pass) WagerTransaction Entity > ledger direction resolution > determines REFUND direction as CREDIT [0.01ms]
(pass) WagerTransaction Entity > ledger direction resolution > determines ROLLBACK direction as inverse of reference [0.02ms]
(pass) WagerTransaction Entity > ledger direction resolution > throws when determining ledger direction for LOSS [0.01ms]
(pass) WagerTransaction Entity > retry backoff calculation > schedules retry with exponential backoff [0.05ms]
(pass) Money Value Object > creation and validation > creates Money with valid decimal string and currency [0.24ms]
(pass) Money Value Object > creation and validation > creates zero Money [0.03ms]
(pass) Money Value Object > creation and validation > rejects negative amount in from() contract [0.03ms]
(pass) Money Value Object > creation and validation > rejects more than 2 decimal places [0.03ms]
(pass) Money Value Object > creation and validation > rejects scientific notation [0.02ms]
(pass) Money Value Object > creation and validation > rejects empty string and invalid strings [0.03ms]
(pass) Money Value Object > creation and validation > rejects invalid currency codes [0.03ms]
(pass) Money Value Object > creation and validation > allows negative amounts in fromInternal() [0.03ms]
(pass) Money Value Object > arithmetic operations > adds two Money instances with exact precision [0.12ms]
(pass) Money Value Object > arithmetic operations > subtracts two Money instances [0.11ms]
(pass) Money Value Object > arithmetic operations > negates a Money instance [0.03ms]
(pass) Money Value Object > arithmetic operations > throws CurrencyMismatchError when adding or subtracting different currencies [0.07ms]
(pass) Money Value Object > comparisons > correctly compares equality [0.06ms]
(pass) Money Value Object > comparisons > correctly compares isLessThan [0.04ms]
(pass) Money Value Object > comparisons > correctly detects isZero, isPositive, isNegative [0.07ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > returns null for a valid REFUND referencing a processed BET with same context [0.34ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > returns null for a valid ROLLBACK referencing a processed BET [0.06ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > returns null for a valid ROLLBACK referencing a processed WIN [0.04ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > REFERENCE_NOT_PROCESSED: ref is in PENDING status [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > REFERENCE_NOT_PROCESSED: ref is in REJECTED status [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > CROSS_PROVIDER_REFERENCE: different providerId [0.04ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > CROSS_PLAYER_REFERENCE: different playerId [0.04ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > CROSS_WALLET_REFERENCE: different walletId [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > CROSS_ROUND_REFERENCE: different roundId [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > CURRENCY_MISMATCH: different currencies [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > REVERSAL_AMOUNT_MISMATCH: different amounts [0.04ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > INVALID_REFERENCE_KIND: REFUND referencing WIN (not BET) [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > INVALID_REFERENCE_KIND: REFUND referencing LOSS (not BET) [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > INVALID_REFERENCE_KIND: ROLLBACK referencing LOSS [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > REFERENCE_ALREADY_REVERSED: REFUND when ref already has an active reversal [0.04ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > REFERENCE_ALREADY_REVERSED: ROLLBACK when ref already has an active reversal [0.03ms]
(pass) validateReference — in-memory unit tests covering all FailureCodes > returns null for ROLLBACK referencing a processed REFUND (rolling back the refund) [0.03ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > opens a wallet with zero balance and version 1 [0.07ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > credits balance, increments version, and produces balanced ledger entry [0.13ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > debits balance, increments version, and produces balanced ledger entry [0.12ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > throws InsufficientBalanceError when debit exceeds balance [0.07ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > throws CurrencyMismatchError on credit or debit with different currency [0.04ms]
(pass) Wallet and WalletLedgerEntry > Wallet Aggregate Root > rehydrates correctly from persistence state [0.03ms]
(pass) Wallet and WalletLedgerEntry > WalletLedgerEntry > throws InvalidLedgerEntryError if arithmetic is unbalanced [0.05ms]
(pass) Wallet and WalletLedgerEntry > WalletLedgerEntry > rehydrates ledger entry from persistence without recalculating [0.03ms]
(pass) Canonical JSON and Payload Hash > produces identical canonical string regardless of key ordering [0.16ms]
(pass) Canonical JSON and Payload Hash > produces different hash for different payload values [0.03ms]
 55 pass
 0 fail
Ran 55 tests across 5 files. [15.00ms]
```

## Integration Tests
```
(pass) Integration — Core Use Cases & Database Atomic Invariants > opens a wallet with initial balance and verifies ledger atomicity [33.34ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > rejects duplicate wallet creation for same player and currency [10.98ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > processes BET, WIN, LOSS, and maintains continuous ledger consistency [29.05ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > processes REFUND of a BET and prevents duplicate reversal [25.79ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > handles idempotent replay and rejects idempotency conflict [10.84ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > enforces ledger immutability at database level by blocking UPDATE and DELETE [4.39ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > P0.3: returns historical balance observed at transaction time on idempotent replay (BET, LOSS, REJECTED) [25.41ms]
(pass) Integration — Core Use Cases & Database Atomic Invariants > P0.4: processes pending references concurrently without duplicate processing [27.00ms]
(pass) Transactional Outbox to SQS FIFO — Permanent Integration Test > handles concurrent publishers with FOR UPDATE SKIP LOCKED without duplicate SQS dispatch [32.78ms]
(pass) SQS Consumer Integration — Contracts, Inbox Dedup, DLQ, and ACK Invariants > forwards malformed payload directly to DLQ and removes it from main queue [2027.57ms]
(pass) SQS Consumer Integration — Contracts, Inbox Dedup, DLQ, and ACK Invariants > processes valid SQS wager message, records inbox message, and deletes from queue [2040.20ms]
 11 pass
 0 fail
Ran 11 tests across 3 files. [4.47s]
```

## E2E / Concurrency Tests
```
(pass) Real Multi-Process Concurrency — 3 Bun Processes Disputing Single Wallet > spawns 3 separate OS processes executing bets against the same wallet: guarantees zero balance drift and ledger consistency [757.21ms]
(pass) Concurrency Tests — Real Parallelism & Distributed Invariants > MANDATORY SCENARIO (Section 8): 100.00 BRL balance, two 80.00 BRL bets processed simultaneously [76.99ms]
(pass) Concurrency Tests — Real Parallelism & Distributed Invariants > IDEMPOTENCY UNDER HIGH CONCURRENCY: 50 simultaneous identical requests cause exactly 1 debit [94.82ms]
(pass) Concurrency Tests — Real Parallelism & Distributed Invariants > OUT-OF-ORDER REFERENCE: REFUND arrives before BET, resolves when BET arrives [28.34ms]
(pass) Concurrency Tests — Real Parallelism & Distributed Invariants > P0.2: CONCURRENT REVERSALS: two simultaneous ROLLBACKs and two simultaneous REFUNDs on the same reference [29.62ms]
(pass) Concurrency Tests — Real Parallelism & Distributed Invariants > CONCURRENCY ACROSS DISTINCT WALLETS: concurrent bets on separate wallets do not block each other [14.99ms]
 6 pass
 0 fail
Ran 6 tests across 2 files. [1210.00ms]
```
