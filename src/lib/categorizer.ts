import type { CategoryRule, Transaction } from '../types';

export const CATEGORIES = [
  'Receitas / Pix Recebido',
  'Vendas Cartão / Recebíveis',
  'Fornecedores e Boletos',
  'Impostos e Tributos',
  'Folha e Pessoal',
  'Tarifas e Encargos',
  'Consumo e Concessionárias',
  'Transferências / Pix Enviado',
  'Saques, Cheques e Depósitos',
  'Aplicações e Rendimentos',
  'Compras no Cartão / Débito',
  'Benefícios e Programas',
  'Outros',
] as const;

type BuiltinRule = {
  pattern: RegExp;
  category: string;
  accountCode: string;
  direction?: 'credit' | 'debit' | 'any';
};

const BUILTIN_RULES: BuiltinRule[] = [
  {
    pattern: /\b(darf|das\b|simples\s*nacional|fgts|gps\b|inss|icms|iss\b|iptu|ipva|sefaz|receita\s+federal|tributo|guia\s+previd)/i,
    category: 'Impostos e Tributos',
    accountCode: '4.1.04',
  },
  {
    pattern: /\b(tarifa|tar\s+|iof\b|encargo|juros|anuidade|manuten[çc][aã]o\s+de\s+conta|pacote\s+de\s+servi|cesta\s+de\s+relacionamento)/i,
    category: 'Tarifas e Encargos',
    accountCode: '4.2.01',
    direction: 'debit',
  },
  {
    pattern: /\b(sal[aá]rio|folha\s+de\s+pag|pr[oó][\s-]?labore|f[eé]rias|rescis[aã]o|13[oº]\s*sal|vale\s+transp|vale\s+refei|vale\s+aliment)/i,
    category: 'Folha e Pessoal',
    accountCode: '4.1.01',
  },
  {
    pattern: /\b(energia|el[eé]trica|enel|cemig|light|cpfl|coelba|equatorial|copel|sabesp|cedae|sanepar|embasa|[aá]gua\s+e\s+esgoto|telecom|internet|vivo|claro|tim\b|oi\s+s\.?a)/i,
    category: 'Consumo e Concessionárias',
    accountCode: '4.1.03',
  },
  {
    pattern: /\b(gas\s+do\s+povo|aux[ií]lio|bolsa|benef[ií]cio)/i,
    category: 'Benefícios e Programas',
    accountCode: '2.1.04',
  },
  {
    pattern: /\b(cielo|redecard|rede\s+|stone|pagseguro|getnet|safrapay|mercadopago\s+receb|vendas?\s+cart[aã]o|antecipac)/i,
    category: 'Vendas Cartão / Recebíveis',
    accountCode: '3.1.02',
    direction: 'credit',
  },
  {
    pattern: /\b(aplica[çc][aã]o|resgate|rendimento|cdb\b|lci\b|lca\b|poupan[çc]a|fundo\s+de\s+invest|remunera[çc][aã]o\s+autom)/i,
    category: 'Aplicações e Rendimentos',
    accountCode: '1.1.03',
  },
  {
    pattern: /\b(saque|cheque|dep[oó]sito|desbloq)/i,
    category: 'Saques, Cheques e Depósitos',
    accountCode: '1.1.01',
  },
  {
    pattern: /\b(boleto|cobranc|fornecedor|titulo|duplicata|pag(?:amento|to)\s+eletr)/i,
    category: 'Fornecedores e Boletos',
    accountCode: '2.1.01',
    direction: 'debit',
  },
  {
    pattern: /\b(compra\s+(?:no\s+)?(?:cart[aã]o|d[eé]bito)|mastercard|visa\s+electron|elo\s+debito|ifood|uber|posto\s+|supermercado)/i,
    category: 'Compras no Cartão / Débito',
    accountCode: '4.1.05',
    direction: 'debit',
  },
  {
    pattern: /\b(pix\s+receb|transf(?:er[eê]ncia)?\s+receb|ted\s+receb|cr[eé]dito\s+em\s+conta|recebimento)/i,
    category: 'Receitas / Pix Recebido',
    accountCode: '3.1.01',
    direction: 'credit',
  },
  {
    pattern: /\b(pix|ted\b|doc\b|transf)/i,
    category: 'Receitas / Pix Recebido',
    accountCode: '3.1.01',
    direction: 'credit',
  },
  {
    pattern: /\b(pix|ted\b|doc\b|transf)/i,
    category: 'Transferências / Pix Enviado',
    accountCode: '2.1.09',
    direction: 'debit',
  },
  {
    pattern: /\b(pag(?:amento|to)|d[eé]b(?:ito)?)/i,
    category: 'Fornecedores e Boletos',
    accountCode: '2.1.01',
    direction: 'debit',
  },
];

export function classifyTransaction(
  history: string,
  amount: number,
  customRules: CategoryRule[] = [],
): { category: string; accountCode: string; history: string } {
  const normalizedHistory = history.trim();
  const lower = normalizedHistory.toLocaleLowerCase('pt-BR');

  for (const rule of customRules) {
    const keyword = rule.keyword.trim().toLocaleLowerCase('pt-BR');
    if (keyword && lower.includes(keyword)) {
      return {
        category: rule.category || 'Outros',
        accountCode: rule.accountCode || '',
        history: rule.replaceHistory?.trim() ? rule.replaceHistory.trim() : normalizedHistory,
      };
    }
  }

  const direction = amount >= 0 ? 'credit' : 'debit';
  for (const rule of BUILTIN_RULES) {
    if (rule.direction && rule.direction !== 'any' && rule.direction !== direction) continue;
    if (rule.pattern.test(normalizedHistory)) {
      return {
        category: rule.category,
        accountCode: rule.accountCode,
        history: normalizedHistory,
      };
    }
  }

  return {
    category: amount > 0 ? 'Receitas / Pix Recebido' : 'Outros',
    accountCode: amount > 0 ? '3.1.01' : '4.9.99',
    history: normalizedHistory,
  };
}

export function applyRulesToTransactions(
  transactions: Transaction[],
  customRules: CategoryRule[],
): Transaction[] {
  return transactions.map((transaction) => {
    const result = classifyTransaction(transaction.history, transaction.amount, customRules);
    return {
      ...transaction,
      history: result.history,
      category: result.category,
      accountCode: transaction.accountCode || result.accountCode,
    };
  });
}
