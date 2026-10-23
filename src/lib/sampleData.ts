import type { Transaction } from '../types';
import { classifyTransaction } from './categorizer';

export function buildDemoTransactions(): {
  openingBalance: number;
  transactions: Transaction[];
} {
  const openingBalance = 18450.20;
  const raw: Array<{
    date: string;
    document: string;
    history: string;
    amount: number;
    balance: number | null;
    sourceBank: string;
    sourceFile: string;
    sourcePage: number;
    warnings?: string[];
  }> = [
    {
      date: '2026-09-02',
      document: '840112',
      history: 'PIX RECEBIDO COMERCIO CENTRAL LTDA NF 4021',
      amount: 7527.32,
      balance: 25977.52,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 1,
    },
    {
      date: '2026-09-05',
      document: '31422',
      history: 'PAGAMENTO GAS DO POVO CONVENIO ESTADUAL',
      amount: -12555.84,
      balance: 13421.68,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 1,
    },
    {
      date: '2026-09-09',
      document: '90451',
      history: 'DEPOSITO CHEQUE CAIXA AG 0842 COMPENSACAO',
      amount: 4200.00,
      balance: null,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 1,
    },
    {
      date: '2026-09-09',
      document: '000412',
      history: 'TARIFA CESTA EMPRESARIAL MENSAL',
      amount: -69.90,
      balance: 17551.78,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 1,
    },
    {
      date: '2026-09-15',
      document: '771203',
      history: 'ARRECADACAO DARF SIMPLES NACIONAL COMP 08/2026',
      amount: -3184.50,
      balance: null,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 2,
    },
    {
      date: '2026-09-15',
      document: '771299',
      history: 'PAGTO BOLETO LIGHT SERVICOS DE ELETRICIDADE SA',
      amount: -842.15,
      balance: 13525.13,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 2,
    },
    {
      date: '2026-09-22',
      document: '551908',
      history: 'VENDAS CARTAO REDE CREDITO A VISTA LOTE 2209',
      amount: 9640.00,
      balance: 23165.13,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 2,
    },
    {
      date: '2026-09-28',
      document: '660014',
      history: 'FOLHA DE PAGAMENTO FUNCIONARIOS SETEMBRO',
      amount: -6450.00,
      balance: null,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 3,
    },
    {
      date: '2026-09-28',
      document: '',
      history: 'PIX ENVIADO FORN EMBALAGENS SUL',
      amount: -1120.00,
      balance: 15595.13,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 3,
      warnings: ['Documento ausente no extrato original; confira se necessário.'],
    },
    {
      date: '2026-09-30',
      document: '998120',
      history: 'RENDIMENTO APLICACAO CDB LIQUIDEZ DIARIA',
      amount: 194.87,
      balance: 15790.00,
      sourceBank: 'Caixa Econômica Federal',
      sourceFile: 'EXTRATO-DEMO-SET2026.pdf',
      sourcePage: 3,
    },
  ];

  const transactions: Transaction[] = raw.map((item, idx) => {
    const classified = classifyTransaction(item.history, item.amount);
    return {
      id: `demo-${idx + 1}`,
      date: item.date,
      document: item.document,
      history: classified.history,
      category: classified.category,
      accountCode: classified.accountCode,
      amount: item.amount,
      debit: item.amount < 0 ? Math.abs(item.amount) : 0,
      credit: item.amount > 0 ? item.amount : 0,
      balance: item.balance,
      sourceId: 'demo-file',
      sourceFile: item.sourceFile,
      sourceBank: item.sourceBank,
      sourcePage: item.sourcePage,
      occurrenceInSource: 1,
      confidence: item.warnings?.length ? 0.68 : 0.98,
      warnings: item.warnings ?? [],
    };
  });

  return { openingBalance, transactions };
}
