# ADR-006: Pareamento Saldo ↔ Ledger e Imutabilidade de Transações no Schema

## Status
Aceito e Implementado (`Migration20261015000001_wager_transaction_guard`, `Migration20261015000002_ledger_wallet_version_chain`)

## Contexto
A restrição 9 do enunciado exige que as garantias de unicidade, imutabilidade e não-negatividade da seção 6 sejam aplicadas **no schema**, não só no código. Já existiam no banco: unicidade (wallet por jogador e moeda, idempotência, reversão única), saldo não negativo, imutabilidade do ledger e a coerência ledger ↔ transação (ADR-004 e migration `…12000004`).

Faltavam no banco duas garantias da seção 6:

1. **"Toda alteração de saldo tem um lançamento correspondente no ledger (e vice-versa)"** e **"`version` incrementa somente quando o saldo muda"**. Um `UPDATE wallets SET balance_amount = …` sem lançamento era aceito, e um lançamento sem movimentação também. A única proteção era a reconciliação, que detecta depois.
2. **Estados terminais da `WagerTransaction`** ("uma transação que chegou a um deles não muda mais de estado"). O banco aceitava mudar o status ou o valor de uma transação `PROCESSED` e apagar transações.

## Decisão

### Cadeia de versões saldo ↔ ledger
- Cada lançamento grava `wallet_version`, a versão da wallet que ele produziu: `UNIQUE (wallet_id, wallet_version)`, `CHECK (wallet_version >= 1)`. O domínio preenche o campo (`Wallet.debit/credit` → versão + 1; `Wallet.openingEntry` → 1).
- `trg_wallet_balance_has_ledger` (diferido, `AFTER INSERT OR UPDATE ON wallets`):
  - wallet nasce na versão 1; saldo inicial positivo exige o lançamento `(versão 1, 0 → saldo)`;
  - alteração de saldo exige versão = anterior + 1 **e** o lançamento `(versão nova, saldo antigo → saldo novo)`;
  - sem alteração de saldo, a versão não muda.
- `trg_ledger_wallet_version` (diferido, `AFTER INSERT ON wallet_ledger_entries`): no commit, o lançamento é o estado da wallet (mesma versão, mesmo `balance_after`, mesma moeda).
- Diferidos porque, dentro da transação, o `UPDATE` da wallet e o `INSERT` do lançamento acontecem em qualquer ordem (unit of work).

Resultado: por indução, o ledger de cada wallet é uma cadeia sem lacunas cujo último `balance_after` é o saldo armazenado. O invariante final dos testes (`wallet.balance == saldo reconstruído pelo ledger`) passa a ser garantido pelo banco para qualquer escrita que não desligue gatilhos.

### Guarda de transações
`trg_wager_transaction_guard` (`BEFORE UPDATE OR DELETE ON wager_transactions`):
- linha em `PROCESSED`/`REJECTED`/`FAILED` não muda;
- colunas de negócio nunca mudam;
- nenhuma linha volta a `PENDING`;
- `DELETE` é proibido.

`BEFORE TRUNCATE` bloqueia `TRUNCATE` em `wager_transactions` e `wallet_ledger_entries`.

### Backfill
A migration preenche `wallet_version` dos lançamentos existentes a partir da versão atual de cada wallet: o mais novo recebe a versão atual, o anterior a versão − 1, e assim por diante, por `(created_at, id)`. O gatilho de imutabilidade do ledger fica suspenso só durante esse `UPDATE`. Se algum lançamento ficasse com versão < 1 (dados anteriores às regras de versão), a migration aborta pedindo para recriar o banco local, em vez de gravar uma cadeia inventada.

## Alternativas consideradas
- **Só reconciliação periódica:** detecta, mas deixa a divergência ser gravada e exige ação manual. Mantida como segunda linha de defesa.
- **Saldo derivado do ledger (sem saldo materializado):** elimina a divergência, mas o enunciado pede saldo materializado e o `SUM` por operação não escala para hot wallets.
- **Gatilho que atualiza o saldo a partir do lançamento:** move regra de negócio para o banco e duplica a lógica do agregado `Wallet`.
- **Cursor do ledger por `(created_at, id)`:** depende do relógio de cada instância. Com relógios dessincronizados, um lançamento novo poderia cair numa página já lida. `wallet_version` é monotônica por construção (lock da wallet).

## Consequências
- **Positivas:**
  - Saldo sem lançamento, lançamento sem movimentação e transação terminal alterada passam a ser impossíveis para a aplicação, e também para um `psql` comum.
  - O ledger ganha ordem total por wallet, e o cursor de paginação fica estável.
- **Negativas:**
  - Cada commit financeiro executa duas consultas indexadas a mais (PK da wallet e `uq_ledger_wallet_version`).
  - Uma transação SQL só pode mover o saldo de uma wallet uma vez. É o desenho de todos os fluxos (o enunciado já limita a um lançamento por wallet por transação), mas lotes na mesma wallet precisariam de uma transação por movimentação.
  - Testes que simulam corrupção precisam desligar gatilhos (`SET LOCAL session_replication_role = replica`), exatamente como um operador privilegiado. É o cenário que a reconciliação continua cobrindo.
