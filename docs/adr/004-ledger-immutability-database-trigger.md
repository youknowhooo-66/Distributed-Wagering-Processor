# ADR-004: Imutabilidade Estrita do Ledger Contábil via Trigger de Banco de Dados

## Status
Aceito e Implementado

## Contexto
O desafio exige um sistema contábil auditável com garantias estritas de imutabilidade. Se qualquer usuário administrativo, rotina defeituosa ou injeção de SQL executar um comando `UPDATE` ou `DELETE` na tabela `wallet_ledger_entries`, a consistência do balanço da carteira é corrompida.

Apenas regras em código TypeScript não fornecem segurança suficiente contra operações manuais ou bugs de ORM.

## Decisão
Implementou-se a migration `Migration20261011000001_ledger_immutability.ts`, criando uma trigger e procedure nativa no PostgreSQL:
```sql
CREATE OR REPLACE FUNCTION trg_prevent_ledger_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Wallet ledger entries are immutable. UPDATE and DELETE operations are prohibited.';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_wallet_ledger_immutable
BEFORE UPDATE OR DELETE ON wallet_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION trg_prevent_ledger_mutation();
```

## Consequências
- **Positivas**: Proteção física no banco de dados contra alteração de histórico financeiro; qualquer tentativa de mutação aborta a transação inteira; auditoria contábil verificável via trigger `trg_wallet_ledger_immutable`.
- **Negativas**: Correções de lançamentos contábeis errôneos exigem estornos compensatórios (lançamento de estorno com nova linha), aderindo ao padrão contábil tradicional.
