import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from 'react';
import {
  amountLabel,
  detectFileFormat,
  parseUnifiedStatement,
  PasswordRequiredError,
} from './lib/bankParser';
import { applyRulesToTransactions, CATEGORIES, classifyTransaction } from './lib/categorizer';
import { mergeWithSmartDedup } from './lib/dedup';
import { downloadCsv, downloadOfx, downloadXlsx } from './lib/exporters';
import { computeReconciliation } from './lib/reconciliation';
import { buildDemoTransactions } from './lib/sampleData';
import type {
  CategoryRule,
  ExportLayout,
  ExportScope,
  ImportedFile,
  ProcessSummary,
  Transaction,
} from './types';

const PAGE_SIZE = 100;
const RULES_STORAGE_KEY = 'conversor-extrato-rules-v2';
const SESSION_STORAGE_KEY = 'conversor-extrato-session-v2';

type FilterTab = 'all' | 'attention' | 'divergent' | 'credits' | 'debits';
type SortField = 'default' | 'date' | 'debit' | 'credit' | 'history' | 'category';
type SortDir = 'asc' | 'desc';
type Theme = 'dark' | 'light';

function fileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function parseEditableNumber(value: string): number | null {
  const compact = value.replace(/[R$\s]/gi, '').trim();
  if (!compact) return null;
  let normalized: string;
  if (compact.includes(',') && compact.includes('.')) {
    normalized =
      compact.lastIndexOf(',') > compact.lastIndexOf('.')
        ? compact.replace(/\./g, '').replace(',', '.')
        : compact.replace(/,/g, '');
  } else if (compact.includes(',')) {
    normalized = compact.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = compact;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function formatBrNumber(value: number | null, blankZero = false): string {
  if (value === null || !Number.isFinite(value)) return '';
  if (blankZero && value === 0) return '';
  return value.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

function reviewWarnings(transaction: Transaction): string[] {
  const warnings = [...transaction.warnings];
  if (!isValidIsoDate(transaction.date)) {
    warnings.push('Data inválida ou ausente; corrija antes de exportar.');
  }
  if (!Number.isFinite(transaction.amount)) {
    warnings.push('Valor inválido; corrija antes de exportar.');
  }
  if (!transaction.history.trim()) {
    warnings.push('Histórico vazio; confirme antes de exportar.');
  }
  return [...new Set(warnings)];
}

function reviewConfidence(transaction: Transaction): number {
  return reviewWarnings(transaction).length
    ? Math.min(transaction.confidence, 0.66)
    : transaction.confidence;
}

interface MoneyInputProps {
  value: number | null;
  blankZero?: boolean;
  allowNegative?: boolean;
  className?: string;
  ariaLabel: string;
  placeholder?: string;
  onCommit: (next: number | null) => void;
}

function MoneyInput({
  value,
  blankZero = false,
  allowNegative = false,
  className = '',
  ariaLabel,
  placeholder,
  onCommit,
}: MoneyInputProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const commit = () => {
    setEditing(false);
    const parsed = parseEditableNumber(draft);
    if (draft.trim() === '') {
      onCommit(null);
      return;
    }
    if (parsed !== null) {
      onCommit(allowNegative ? parsed : Math.abs(parsed));
    }
  };

  return (
    <input
      aria-label={ariaLabel}
      inputMode="decimal"
      className={`money-cell ${className}`}
      placeholder={placeholder}
      value={editing ? draft : formatBrNumber(value, blankZero)}
      onFocus={() => {
        setDraft(formatBrNumber(value, blankZero));
        setEditing(true);
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          setEditing(false);
        }
      }}
    />
  );
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('conversor-extrato-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  const [customRules, setCustomRules] = useState<CategoryRule[]>(() => {
    try {
      const saved = localStorage.getItem(RULES_STORAGE_KEY);
      return saved ? (JSON.parse(saved) as CategoryRule[]) : [];
    } catch {
      return [];
    }
  });

  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>(() => {
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as { transactions?: Transaction[] };
      return Array.isArray(parsed.transactions) ? parsed.transactions : [];
    } catch {
      return [];
    }
  });
  const [manualOpeningBalance, setManualOpeningBalance] = useState<number | null>(() => {
    try {
      const raw = localStorage.getItem(SESSION_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { openingBalance?: number | null };
      return typeof parsed.openingBalance === 'number' ? parsed.openingBalance : null;
    } catch {
      return null;
    }
  });

  const [undoStack, setUndoStack] = useState<Transaction[][]>([]);
  const [processing, setProcessing] = useState(false);
  const [progressPct, setProgressPct] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removeDuplicates, setRemoveDuplicates] = useState(true);
  const [message, setMessage] = useState('');
  const [processSummary, setProcessSummary] = useState<ProcessSummary | null>(null);

  const [filter, setFilter] = useState<FilterTab>('all');
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedMonth, setSelectedMonth] = useState<string>('');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('default');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);

  const [exportLayout, setExportLayout] = useState<ExportLayout>('contabil');
  const [exportScope, setExportScope] = useState<ExportScope>('all');
  const [showAccountCode, setShowAccountCode] = useState(false);

  const [columnFilters, setColumnFilters] = useState({
    dateFrom: '',
    dateTo: '',
    debit: '',
    credit: '',
    history: '',
  });

  const [columnWidths, setColumnWidths] = useState({
    date: 126,
    document: 105,
    history: 390,
    category: 195,
    debit: 118,
    credit: 118,
    balance: 145,
  });

  // Rule form state
  const [ruleKeyword, setRuleKeyword] = useState('');
  const [ruleCategory, setRuleCategory] = useState<string>(CATEGORIES[0]);
  const [ruleAccountCode, setRuleAccountCode] = useState('');
  const [ruleReplace, setRuleReplace] = useState('');

  // Batch find & replace state
  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');

  // Password drafts per locked PDF
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});

  const [cookiesAccepted, setCookiesAccepted] = useState(() => {
    try {
      return localStorage.getItem('conversor-extrato-cookies') === 'accepted';
    } catch {
      return true;
    }
  });

  const pushUndoSnapshot = useCallback((snapshot: Transaction[]) => {
    setUndoStack((prev) => [...prev.slice(-24), snapshot]);
  }, []);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      setTransactions(previous);
      setMessage('Última alteração desfeita.');
      return prev.slice(0, -1);
    });
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !event.shiftKey) {
        const tag = (event.target as HTMLElement | null)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (undoStack.length > 0) {
          event.preventDefault();
          handleUndo();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [undoStack.length, handleUndo]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('conversor-extrato-theme', theme);
    } catch {
      // Ignore private browsing quota errors
    }
  }, [theme]);

  useEffect(() => {
    try {
      localStorage.setItem(RULES_STORAGE_KEY, JSON.stringify(customRules));
    } catch {
      // Ignore storage error
    }
  }, [customRules]);

  useEffect(() => {
    try {
      if (transactions.length === 0) {
        localStorage.removeItem(SESSION_STORAGE_KEY);
      } else {
        localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({
            transactions,
            openingBalance: manualOpeningBalance,
          }),
        );
      }
    } catch {
      // Ignore storage quota when dealing with tens of thousands of rows
    }
  }, [transactions, manualOpeningBalance]);

  const reconciliation = useMemo(
    () => computeReconciliation(transactions, manualOpeningBalance),
    [transactions, manualOpeningBalance],
  );

  const hasAttention = useCallback(
    (transaction: Transaction) =>
      reviewConfidence(transaction) < 0.7 || reviewWarnings(transaction).length > 0,
    [],
  );

  const filteredTransactions = useMemo(() => {
    const q = searchQuery.trim().toLocaleLowerCase('pt-BR');
    const filtered = transactions.filter((tx) => {
      if (filter === 'attention' && !hasAttention(tx)) return false;
      if (filter === 'divergent' && !reconciliation.divergentRowIds.has(tx.id)) return false;
      if (filter === 'credits' && tx.amount <= 0) return false;
      if (filter === 'debits' && tx.amount >= 0) return false;
      if (selectedCategory && tx.category !== selectedCategory) return false;
      if (selectedMonth && !tx.date.startsWith(selectedMonth)) return false;
      if (columnFilters.dateFrom && tx.date < columnFilters.dateFrom) return false;
      if (columnFilters.dateTo && tx.date > columnFilters.dateTo) return false;

      const containsText = (val: string | number | null, sub: string) =>
        !sub || String(val ?? '').toLocaleLowerCase('pt-BR').includes(sub.toLocaleLowerCase('pt-BR'));

      if (!containsText(tx.debit === 0 ? '' : tx.debit.toFixed(2), columnFilters.debit)) return false;
      if (!containsText(tx.credit === 0 ? '' : tx.credit.toFixed(2), columnFilters.credit)) return false;
      if (!containsText(tx.history, columnFilters.history)) return false;

      if (q) {
        const haystack = [
          tx.date,
          tx.document,
          tx.history,
          tx.category,
          tx.accountCode,
          tx.sourceBank,
          tx.sourceFile,
          tx.amount.toFixed(2),
          formatBrNumber(tx.debit, true),
          formatBrNumber(tx.credit, true),
        ]
          .join(' ')
          .toLocaleLowerCase('pt-BR');
        if (!haystack.includes(q)) return false;
      }

      return true;
    });

    if (sortField === 'default') return filtered;

    const sorted = [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') cmp = a.date.localeCompare(b.date);
      else if (sortField === 'debit') cmp = a.debit - b.debit;
      else if (sortField === 'credit') cmp = a.credit - b.credit;
      else if (sortField === 'history') cmp = a.history.localeCompare(b.history, 'pt-BR');
      else if (sortField === 'category') cmp = a.category.localeCompare(b.category, 'pt-BR');
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return sorted;
  }, [
    transactions,
    filter,
    hasAttention,
    reconciliation.divergentRowIds,
    selectedCategory,
    selectedMonth,
    columnFilters,
    searchQuery,
    sortField,
    sortDir,
  ]);

  const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const visibleTransactions = filteredTransactions.slice(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE,
  );

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  const readyFiles = files.filter((file) => file.state === 'ready');
  const completeFiles = files.filter((file) => file.state === 'done');

  const credits = useMemo(
    () => transactions.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0),
    [transactions],
  );
  const debits = useMemo(
    () => transactions.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0),
    [transactions],
  );
  const netResult = credits + debits;
  const attentionCount = useMemo(
    () => transactions.filter(hasAttention).length,
    [transactions, hasAttention],
  );

  const categoryStats = useMemo(() => {
    const map = new Map<string, { totalAbs: number; net: number; count: number }>();
    for (const tx of transactions) {
      const cat = tx.category || 'Outros';
      const entry = map.get(cat) ?? { totalAbs: 0, net: 0, count: 0 };
      entry.totalAbs += Math.abs(tx.amount);
      entry.net += tx.amount;
      entry.count += 1;
      map.set(cat, entry);
    }
    const items = Array.from(map.entries())
      .map(([name, data]) => ({ name, ...data }))
      .sort((a, b) => b.totalAbs - a.totalAbs);
    const maxAbs = items[0]?.totalAbs ?? 1;
    return items.map((item) => ({
      ...item,
      pct: Math.max(4, Math.round((item.totalAbs / maxAbs) * 100)),
    }));
  }, [transactions]);

  const monthStats = useMemo(() => {
    const map = new Map<string, { credits: number; debits: number; count: number }>();
    for (const tx of transactions) {
      const ym = tx.date.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(ym)) continue;
      const entry = map.get(ym) ?? { credits: 0, debits: 0, count: 0 };
      entry.credits += tx.credit;
      entry.debits += tx.debit;
      entry.count += 1;
      map.set(ym, entry);
    }
    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, data]) => ({ ym, ...data }));
  }, [transactions]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      if (sortDir === 'asc') setSortDir('desc');
      else {
        setSortField('default');
        setSortDir('asc');
      }
    } else {
      setSortField(field);
      setSortDir('asc');
    }
    setPage(0);
  };

  const acceptCookies = () => {
    try {
      localStorage.setItem('conversor-extrato-cookies', 'accepted');
    } catch {
      // Ignore
    }
    setCookiesAccepted(true);
  };

  const addFiles = (candidateFiles: FileList | File[]) => {
    const selected = Array.from(candidateFiles);
    const supported = selected.filter((file) =>
      /\.(pdf|ofx|qfx|csv|txt|xlsx|xls)$/i.test(file.name) ||
      file.type === 'application/pdf',
    );
    const invalidCount = selected.length - supported.length;
    if (invalidCount > 0) {
      setMessage(
        `${invalidCount} arquivo(s) ignorado(s): envie arquivos PDF, OFX, CSV, TXT ou XLSX.`,
      );
    }

    setFiles((current) => {
      const known = new Set(current.map((item) => fileKey(item.file)));
      const additions: ImportedFile[] = supported
        .filter((file) => !known.has(fileKey(file)))
        .map((file) => ({
          id: crypto.randomUUID(),
          file,
          format: detectFileFormat(file),
          state: 'ready',
          transactions: 0,
        }));
      if (additions.length === 0 && supported.length > 0) {
        setMessage('Esses arquivos já estão na fila.');
      }
      if (additions.length > 0) {
        setMessage(
          `${additions.length} arquivo(s) adicionado(s) na fila. Processamento 100% local.`,
        );
      }
      return [...current, ...additions];
    });
  };

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) addFiles(event.target.files);
    event.target.value = '';
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files.length) addFiles(event.dataTransfer.files);
  };

  const loadDemoData = () => {
    pushUndoSnapshot(transactions);
    const demo = buildDemoTransactions();
    setManualOpeningBalance(demo.openingBalance);
    setTransactions(demo.transactions);
    setProcessSummary({
      processedFiles: 1,
      totalFiles: 1,
      extracted: demo.transactions.length,
      duplicatesRemoved: 0,
      attention: demo.transactions.filter(hasAttention).length,
      errors: 0,
    });
    setFilter('all');
    setSelectedCategory('');
    setSelectedMonth('');
    setMessage(
      'Extrato de demonstração carregado (10 lançamentos conciliados). Experimente editar valores, criar regras ou exportar Excel, OFX e CSV!',
    );
  };

  const clearAll = () => {
    if (processing) return;
    pushUndoSnapshot(transactions);
    setFiles([]);
    setTransactions([]);
    setManualOpeningBalance(null);
    setProcessSummary(null);
    setSelectedCategory('');
    setSelectedMonth('');
    setSearchQuery('');
    setMessage('Mesa limpa. Você pode desfazer com "Desfazer" se limpou por engano.');
  };

  const removeFile = (id: string) => {
    if (processing) return;
    pushUndoSnapshot(transactions);
    setFiles((current) => current.filter((item) => item.id !== id));
    setTransactions((current) => current.filter((transaction) => transaction.sourceId !== id));
    setMessage('Arquivo removido e lançamentos correspondentes retirados da tabela.');
  };

  const runQueue = async (targetItems: ImportedFile[]) => {
    if (!targetItems.length || processing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setProcessing(true);
    setProgressPct(4);
    setMessage('Iniciando leitura adaptativa local (datas, colunas, históricos e saldos)…');

    let extracted: Transaction[] = [];
    let firstOpeningBalance: number | null = null;
    let errors = 0;

    for (let index = 0; index < targetItems.length; index += 1) {
      if (controller.signal.aborted) break;
      const item = targetItems[index];
      setFiles((current) =>
        current.map((file) => (file.id === item.id ? { ...file, state: 'processing' } : file)),
      );

      try {
        const result = await parseUnifiedStatement(
          item.file,
          {
            sourceId: item.id,
            password: item.password,
            signal: controller.signal,
            onPage: (currentPage, totalPages) => {
              const fileBase = (index / targetItems.length) * 100;
              const fileStep = (currentPage / Math.max(1, totalPages)) * (100 / targetItems.length);
              setProgressPct(Math.min(98, Math.round(fileBase + fileStep)));
              setMessage(
                `Lendo ${item.file.name}: página ${currentPage} de ${totalPages}…`,
              );
            },
          },
          customRules,
        );

        extracted = [...extracted, ...result.transactions];
        if (firstOpeningBalance === null && result.openingBalance !== null) {
          firstOpeningBalance = result.openingBalance;
        }

        setFiles((current) =>
          current.map((file) =>
            file.id === item.id
              ? {
                  ...file,
                  state: 'done',
                  transactions: result.transactions.length,
                  pages: result.pages,
                  bankName: result.bankName,
                  openingBalance: result.openingBalance,
                  closingBalance: result.closingBalance,
                  error: result.warnings[0],
                }
              : file,
          ),
        );
      } catch (error) {
        if (error instanceof PasswordRequiredError) {
          setFiles((current) =>
            current.map((file) =>
              file.id === item.id
                ? { ...file, state: 'needs-password', error: error.message }
                : file,
            ),
          );
        } else {
          errors += 1;
          const detail =
            error instanceof Error ? error.message : 'Não foi possível abrir este arquivo.';
          setFiles((current) =>
            current.map((file) =>
              file.id === item.id ? { ...file, state: 'error', error: detail } : file,
            ),
          );
        }
      }
    }

    if (extracted.length > 0 || errors > 0) {
      pushUndoSnapshot(transactions);
      if (manualOpeningBalance === null && firstOpeningBalance !== null) {
        setManualOpeningBalance(firstOpeningBalance);
      }
      setTransactions((current) => {
        const merged = mergeWithSmartDedup(current, extracted, removeDuplicates);
        setProcessSummary({
          processedFiles: targetItems.length,
          totalFiles: files.length,
          extracted: extracted.length,
          duplicatesRemoved: removeDuplicates ? merged.duplicatesCount : 0,
          attention: merged.records.filter(hasAttention).length,
          errors,
        });
        setMessage(
          errors
            ? 'Processamento concluído com alertas em algum arquivo. Confira a fila acima.'
            : merged.duplicatesCount > 0 && removeDuplicates
              ? `Leitura concluída: ${extracted.length} lançamento(s) lido(s) e ${merged.duplicatesCount} duplicidade(s) entre arquivos removida(s) automaticamente.`
              : `Leitura concluída com sucesso (${extracted.length} lançamento(s)). Conciliação de saldo calculada automaticamente.`,
        );
        return merged.records;
      });
    } else if (controller.signal.aborted) {
      setMessage('Processamento interrompido pelo usuário.');
    }

    setProgressPct(100);
    setProcessing(false);
    abortRef.current = null;
  };

  const processFiles = () => {
    const queue = files.filter((file) => file.state === 'ready');
    void runQueue(queue);
  };

  const unlockAndProcessFile = (item: ImportedFile) => {
    const pwd = (passwordDrafts[item.id] ?? '').trim();
    if (!pwd) return;
    const updatedItem: ImportedFile = { ...item, password: pwd, state: 'ready', error: undefined };
    setFiles((current) => current.map((f) => (f.id === item.id ? updatedItem : f)));
    void runQueue([updatedItem]);
  };

  const updateTransactionText = (
    id: string,
    field: 'date' | 'document' | 'history' | 'category' | 'accountCode',
    value: string,
  ) => {
    pushUndoSnapshot(transactions);
    setTransactions((current) =>
      current.map((tx) => (tx.id === id ? { ...tx, [field]: value } : tx)),
    );
  };

  const updateTransactionMoney = (
    id: string,
    field: 'debit' | 'credit' | 'balance',
    next: number | null,
  ) => {
    pushUndoSnapshot(transactions);
    setTransactions((current) =>
      current.map((tx) => {
        if (tx.id !== id) return tx;
        if (field === 'balance') {
          return { ...tx, balance: next };
        }
        const val = next ?? 0;
        if (field === 'debit') {
          const newCredit = val > 0 ? 0 : tx.credit;
          const amount = Math.round((newCredit - val) * 100) / 100;
          return { ...tx, debit: val, credit: newCredit, amount };
        }
        const newDebit = val > 0 ? 0 : tx.debit;
        const amount = Math.round((val - newDebit) * 100) / 100;
        return { ...tx, credit: val, debit: newDebit, amount };
      }),
    );
  };

  const invertTransactionSign = (id: string) => {
    pushUndoSnapshot(transactions);
    setTransactions((current) =>
      current.map((tx) => {
        if (tx.id !== id) return tx;
        const flipped = -tx.amount;
        const classified = classifyTransaction(tx.history, flipped, customRules);
        return {
          ...tx,
          amount: flipped,
          debit: flipped < 0 ? Math.abs(flipped) : 0,
          credit: flipped > 0 ? flipped : 0,
          category: classified.category,
          accountCode: classified.accountCode,
        };
      }),
    );
  };

  const deleteTransactionRow = (id: string) => {
    pushUndoSnapshot(transactions);
    setTransactions((current) => current.filter((tx) => tx.id !== id));
    setMessage('Lançamento excluído (clique em "Desfazer" para restaurar).');
  };

  const addManualTransaction = () => {
    pushUndoSnapshot(transactions);
    const defaultDate =
      filteredTransactions[0]?.date ??
      transactions[transactions.length - 1]?.date ??
      new Date().toISOString().slice(0, 10);

    const newTx: Transaction = {
      id: `manual-${crypto.randomUUID()}`,
      date: defaultDate,
      document: '',
      history: 'AJUSTE / LANÇAMENTO MANUAL',
      category: 'Outros',
      accountCode: '4.9.99',
      amount: 0,
      debit: 0,
      credit: 0,
      balance: null,
      sourceId: 'manual',
      sourceFile: 'Inserção Manual',
      sourceBank: 'Manual',
      sourcePage: 1,
      confidence: 0.99,
      warnings: [],
    };
    setTransactions((current) => [newTx, ...current]);
    setPage(0);
    setMessage('Novo lançamento manual adicionado no topo para preenchimento.');
  };

  const handleAddRule = (event: FormEvent) => {
    event.preventDefault();
    if (!ruleKeyword.trim()) return;
    const nextRule: CategoryRule = {
      id: crypto.randomUUID(),
      keyword: ruleKeyword.trim(),
      category: ruleCategory,
      accountCode: ruleAccountCode.trim(),
      replaceHistory: ruleReplace.trim() || undefined,
    };
    const updatedRules = [nextRule, ...customRules];
    setCustomRules(updatedRules);
    pushUndoSnapshot(transactions);
    setTransactions((current) => applyRulesToTransactions(current, updatedRules));
    setRuleKeyword('');
    setRuleAccountCode('');
    setRuleReplace('');
    setMessage(`Regra "${nextRule.keyword}" criada e aplicada aos lançamentos.`);
  };

  const removeRule = (id: string) => {
    const updated = customRules.filter((r) => r.id !== id);
    setCustomRules(updated);
  };

  const handleBatchReplace = (event: FormEvent) => {
    event.preventDefault();
    const needle = findText.trim();
    if (!needle) return;
    pushUndoSnapshot(transactions);
    let changed = 0;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(escaped, 'gi');
    setTransactions((current) =>
      current.map((tx) => {
        if (!regex.test(tx.history)) return tx;
        changed += 1;
        return {
          ...tx,
          history: tx.history.replace(regex, replaceText).replace(/\s+/g, ' ').trim(),
        };
      }),
    );
    setMessage(
      changed > 0
        ? `Histórico atualizado em ${changed} lançamento(s).`
        : `Nenhum histórico encontrado contendo "${needle}".`,
    );
  };

  const getExportTarget = (): Transaction[] | null => {
    const target = exportScope === 'filtered' ? filteredTransactions : transactions;
    if (!target.length) return null;
    const invalid = target.filter(
      (tx) => !isValidIsoDate(tx.date) || !Number.isFinite(tx.amount) || !tx.history.trim(),
    );
    if (invalid.length) {
      setFilter('attention');
      setPage(0);
      setMessage(
        `Corrija ${invalid.length} lançamento(s) com data, valor ou histórico inválido antes de exportar.`,
      );
      return null;
    }
    return target;
  };

  const handleExportXlsx = () => {
    const target = getExportTarget();
    if (!target) return;
    downloadXlsx(target, reconciliation, exportLayout);
    setMessage(
      exportLayout === 'completo'
        ? `Planilha Excel exportada com 4 abas (${target.length} lançamentos, Resumo Mensal, Categorias e Conciliação Diária).`
        : `Planilha Contábil Excel exportada (${target.length} lançamentos + Resumo Mensal, Categorias e Conciliação).`,
    );
  };

  const handleExportCsv = () => {
    const target = getExportTarget();
    if (!target) return;
    downloadCsv(target, exportLayout);
    setMessage(`Arquivo CSV exportado (${target.length} lançamentos).`);
  };

  const handleExportOfx = () => {
    const target = getExportTarget();
    if (!target) return;
    downloadOfx(target, reconciliation);
    setMessage(
      `Arquivo OFX universal gerado (${target.length} lançamentos) — pronto para Domínio, Alterdata, Conta Azul, Omie ou Fortes.`,
    );
  };

  return (
    <main className="shell">
      <header className="topbar">
        <a className="brand" href="#inicio">
          <span className="brand-mark" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span>
            Conversor de <strong>Extratos</strong>
          </span>
          <span className="version-pill">v2.0</span>
        </a>

        <div className="topbar-right">
          <span className="privacy-chip">
            <i className="pulse" aria-hidden="true" />
            100% Local · Privacidade Total
          </span>
          {undoStack.length > 0 && (
            <button
              className="theme-toggle"
              type="button"
              onClick={handleUndo}
              title="Desfazer última edição (Ctrl+Z)"
            >
              <span aria-hidden="true">↶</span>
              Desfazer ({undoStack.length})
            </button>
          )}
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Trocar para o tema ${theme === 'dark' ? 'claro' : 'escuro'}`}
            aria-pressed={theme === 'light'}
            onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>
            {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          </button>
        </div>
      </header>

      <section className="hero" id="inicio">
        <div className="eyebrow">
          <span aria-hidden="true" />
          Conversor &amp; Conciliador Contábil
        </div>
        <h1>
          Conversor de <em>Extratos</em>
        </h1>
        <p>
          Importe extratos em PDF (nativos, protegidos por senha ou escaneados via OCR), OFX, CSV e
          planilhas de qualquer banco brasileiro, audite a conciliação diária de saldos, categorize
          automaticamente e exporte para <strong>Excel</strong>, <strong>OFX</strong> e{' '}
          <strong>CSV</strong> sem enviar nenhum dado a servidores externos.
        </p>

        <div className="bank-pills" aria-label="Bancos e formatos compatíveis">
          <span>Caixa</span>
          <span>Banco do Brasil</span>
          <span>Itaú</span>
          <span>Bradesco</span>
          <span>Santander</span>
          <span>Nubank</span>
          <span>Inter</span>
          <span>Sicoob / Sicredi</span>
          <span>C6 / Cora / BTG</span>
          <span>PDF · OFX · CSV · XLSX</span>
        </div>

        <div className="flow-line" aria-label="Fluxo de três etapas">
          <span>
            <b>01</b> Importar PDFs, OFX ou CSV
          </span>
          <i />
          <span>
            <b>02</b> Conciliar saldos e categorizar
          </span>
          <i />
          <span>
            <b>03</b> Exportar Excel, OFX ou CSV
          </span>
        </div>
      </section>

      <section className="workspace" aria-label="Conversor de extratos">
        <div className="workspace-title">
          <div>
            <span className="section-index">01</span>
            <h2>Arquivos de extrato</h2>
          </div>
          <span className="file-counter">
            {files.length} arquivo{files.length === 1 ? '' : 's'} na fila
          </span>
        </div>

        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            setDragging(false);
          }}
          onDrop={handleDrop}
        >
          <div className="upload-symbol" aria-hidden="true">
            ↥
          </div>
          <div className="drop-copy">
            <h3>Solte os extratos aqui (PDF, OFX, CSV ou XLSX)</h3>
            <p>
              Consolide vários meses ou bancos em uma única conferência, com reconstrução automática
              de históricos multilinhas, remoção inteligente de duplicidades e conciliação diária.
            </p>
          </div>
          <div className="drop-actions">
            <button className="button secondary" type="button" onClick={loadDemoData}>
              Testar com exemplo
            </button>
            <button
              className="button primary"
              type="button"
              onClick={() => inputRef.current?.click()}
            >
              Selecionar arquivos
            </button>
          </div>
          <input
            ref={inputRef}
            className="visually-hidden"
            type="file"
            accept="application/pdf,.pdf,.ofx,.qfx,.csv,.txt,.xlsx,.xls"
            multiple
            onChange={handleInput}
          />
        </div>

        {processing && (
          <div className="progress-wrap" aria-live="polite">
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {message && (
          <p className="live-message" role="status">
            {message}
          </p>
        )}

        {files.length > 0 && (
          <div className="file-list">
            {files.map((item) => (
              <article className="file-row" key={item.id}>
                <div className="pdf-tag">{item.format}</div>
                <div className="file-meta">
                  <div className="file-meta-top">
                    <strong>{item.file.name}</strong>
                    {item.bankName && <span className="bank-badge">{item.bankName}</span>}
                  </div>
                  <span>
                    {(item.file.size / 1024 / 1024).toFixed(2)} MB
                    {item.pages ? ` · ${item.pages} pág.` : ''}
                    {item.transactions ? ` · ${item.transactions} lançamentos` : ''}
                    {item.openingBalance !== null && item.openingBalance !== undefined
                      ? ` · Saldo ant.: ${amountLabel(item.openingBalance)}`
                      : ''}
                  </span>
                  {item.error && (
                    <small
                      className={
                        item.state === 'error' || item.state === 'needs-password'
                          ? 'error-text'
                          : 'subtle-warning'
                      }
                    >
                      {item.error}
                    </small>
                  )}
                  {item.state === 'needs-password' && (
                    <div className="password-inline">
                      <input
                        type="password"
                        placeholder="Senha do PDF (ex.: CPF/CNPJ)"
                        value={passwordDrafts[item.id] ?? ''}
                        onChange={(e) =>
                          setPasswordDrafts((cur) => ({ ...cur, [item.id]: e.target.value }))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') unlockAndProcessFile(item);
                        }}
                      />
                      <button
                        type="button"
                        className="button primary small"
                        onClick={() => unlockAndProcessFile(item)}
                      >
                        Desbloquear e ler
                      </button>
                    </div>
                  )}
                </div>
                <span className={`file-state state-${item.state}`}>
                  {item.state === 'ready' && 'Na fila'}
                  {item.state === 'processing' && 'Lendo…'}
                  {item.state === 'done' && 'Lido ✓'}
                  {item.state === 'needs-password' && 'Com senha'}
                  {item.state === 'error' && 'Atenção'}
                </span>
                <button
                  className="icon-button"
                  type="button"
                  aria-label={`Remover ${item.file.name}`}
                  onClick={() => removeFile(item.id)}
                  disabled={processing}
                >
                  ×
                </button>
              </article>
            ))}
          </div>
        )}

        <div className="action-bar">
          <div className="action-bar-info">
            <strong>
              {readyFiles.length
                ? `${readyFiles.length} arquivo(s) pronto(s) para processar`
                : completeFiles.length
                  ? 'Todos os arquivos da fila foram processados'
                  : 'Adicione PDFs, OFX, CSV ou clique em "Testar com exemplo"'}
            </strong>
            <label className="dedup-toggle">
              <input
                type="checkbox"
                checked={removeDuplicates}
                onChange={(e) => setRemoveDuplicates(e.target.checked)}
              />
              Remover automaticamente lançamentos repetidos entre arquivos sobrepostos
            </label>
          </div>

          <div className="action-buttons">
            {processing && (
              <button
                className="button ghost"
                type="button"
                onClick={() => abortRef.current?.abort()}
              >
                Cancelar leitura
              </button>
            )}
            {(files.length > 0 || transactions.length > 0) && !processing && (
              <button className="button ghost" type="button" onClick={clearAll}>
                Limpar mesa
              </button>
            )}
            <button
              className="button primary"
              type="button"
              onClick={processFiles}
              disabled={!readyFiles.length || processing}
            >
              {processing ? `Processando (${progressPct}%)…` : 'Ler extratos'}
            </button>
          </div>
        </div>
      </section>

      {transactions.length > 0 && (
        <section className="review" aria-labelledby="review-title">
          <div className="workspace-title review-header">
            <div>
              <span className="section-index">02</span>
              <h2 id="review-title">Conferência, Conciliação e Exportação</h2>
            </div>

            <div className="export-bar">
              <select
                className="layout-select"
                aria-label="Modelo de colunas para exportação"
                value={exportLayout}
                onChange={(e) => setExportLayout(e.target.value as ExportLayout)}
              >
                <option value="contabil">Modelo Contábil (Data · Débito · Crédito · Histórico)</option>
                <option value="completo">Auditoria Completa (12 colunas + 4 abas)</option>
              </select>

              {filteredTransactions.length !== transactions.length && (
                <select
                  className="layout-select"
                  aria-label="Escopo dos lançamentos exportados"
                  value={exportScope}
                  onChange={(e) => setExportScope(e.target.value as ExportScope)}
                >
                  <option value="all">Exportar todos ({transactions.length})</option>
                  <option value="filtered">Apenas filtrados ({filteredTransactions.length})</option>
                </select>
              )}

              <button type="button" className="button secondary" onClick={handleExportCsv}>
                Baixar CSV
              </button>
              <button type="button" className="button secondary" onClick={handleExportOfx}>
                Baixar OFX
              </button>
              <button type="button" className="button primary" onClick={handleExportXlsx}>
                Baixar Excel (.xlsx)
              </button>
            </div>
          </div>

          <div className="summary-grid">
            <div>
              <span>Lançamentos</span>
              <strong>{transactions.length}</strong>
              <small>
                {processSummary?.duplicatesRemoved
                  ? `${processSummary.duplicatesRemoved} duplicidade(s) removida(s)`
                  : attentionCount
                    ? `${attentionCount} item(ns) para revisar`
                    : 'Base pronta para exportação'}
              </small>
            </div>

            <div>
              <span>Créditos (+)</span>
              <strong className="positive">{amountLabel(credits)}</strong>
              <small>
                {transactions.filter((t) => t.amount > 0).length} entrada(s) identificada(s)
              </small>
            </div>

            <div>
              <span>Débitos (-)</span>
              <strong className="negative">{amountLabel(debits)}</strong>
              <small>
                {transactions.filter((t) => t.amount < 0).length} saída(s) identificada(s)
              </small>
            </div>

            <div>
              <span>Resultado Líquido</span>
              <strong className={netResult >= 0 ? 'positive' : 'negative'}>
                {amountLabel(netResult)}
              </strong>
              <small>
                Saldo final calc.: {amountLabel(reconciliation.calculatedClosingBalance)}
              </small>
            </div>

            <div>
              <span>Conciliação de Saldo</span>
              {reconciliation.checkedDaysCount > 0 ? (
                reconciliation.divergentDaysCount === 0 ? (
                  <span className="reconcile-pill reconcile-ok">
                    ✓ {reconciliation.checkedDaysCount} dia(s) conciliado(s)
                  </span>
                ) : (
                  <button
                    type="button"
                    className="reconcile-pill reconcile-warn"
                    onClick={() => {
                      setFilter('divergent');
                      setPage(0);
                    }}
                  >
                    ⚠ {reconciliation.divergentDaysCount} dia(s) divergente(s)
                  </button>
                )
              ) : (
                <strong className="mono">—</strong>
              )}
              <div className="opening-row">
                <label htmlFor="opening-balance-input">Saldo inicial:</label>
                <MoneyInput
                  value={reconciliation.inferredOpeningBalance}
                  allowNegative
                  ariaLabel="Saldo inicial para conciliação"
                  placeholder="0,00"
                  onCommit={(val) => setManualOpeningBalance(val)}
                />
              </div>
            </div>
          </div>

          {/* Analytics & Category Breakdown Drawer */}
          <details className="panel-drawer" open>
            <summary>
              <span>
                Resumo por Categoria e Competência (clique em qualquer barra ou mês para filtrar)
              </span>
              <span>
                {selectedCategory || selectedMonth ? 'Filtro ativo — clique novamente para limpar' : 'Expandir / Recolher'}
              </span>
            </summary>
            <div className="drawer-body insights-grid">
              <div className="cat-bars">
                {categoryStats.slice(0, 7).map((cat) => (
                  <button
                    key={cat.name}
                    type="button"
                    className={`cat-bar-item ${selectedCategory === cat.name ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedCategory((cur) => (cur === cat.name ? '' : cat.name));
                      setPage(0);
                    }}
                  >
                    <span>
                      {cat.name} ({cat.count})
                    </span>
                    <span className="cat-bar-track">
                      <span className="cat-bar-fill" style={{ width: `${cat.pct}%` }} />
                    </span>
                    <span className={`mono ${cat.net >= 0 ? 'positive' : 'negative'}`}>
                      {amountLabel(cat.net)}
                    </span>
                  </button>
                ))}
              </div>

              <div className="month-cards">
                {monthStats.map((m) => (
                  <button
                    key={m.ym}
                    type="button"
                    className={`month-card ${selectedMonth === m.ym ? 'active' : ''}`}
                    onClick={() => {
                      setSelectedMonth((cur) => (cur === m.ym ? '' : m.ym));
                      setPage(0);
                    }}
                  >
                    <strong>{m.ym}</strong>
                    <small className="positive">+ {amountLabel(m.credits)}</small>
                    <small className="negative">- {amountLabel(m.debits)}</small>
                    <small>{m.count} lançamentos</small>
                  </button>
                ))}
              </div>
            </div>
          </details>

          {/* Accounting Rules & Batch Replace Drawer */}
          <details className="panel-drawer">
            <summary>
              <span>Regras Automáticas de Categorização / Plano de Contas &amp; Edição em Lote</span>
              <span>{customRules.length} regra(s) salva(s)</span>
            </summary>
            <div className="drawer-body" style={{ display: 'grid', gap: '16px' }}>
              <form className="inline-form-row" onSubmit={handleAddRule}>
                <label>
                  Se histórico contiver
                  <input
                    placeholder="Ex.: ENERGISA, CONTABILIDADE, CIELO"
                    value={ruleKeyword}
                    onChange={(e) => setRuleKeyword(e.target.value)}
                  />
                </label>
                <label>
                  Definir Categoria
                  <select
                    value={ruleCategory}
                    onChange={(e) => setRuleCategory(e.target.value)}
                  >
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </label>
                <label style={{ flex: '0 1 135px' }}>
                  Conta Contábil
                  <input
                    placeholder="Ex.: 4.1.03"
                    value={ruleAccountCode}
                    onChange={(e) => setRuleAccountCode(e.target.value)}
                  />
                </label>
                <label>
                  Padronizar Histórico (opcional)
                  <input
                    placeholder="Ex.: PAGTO ENERGIA ELÉTRICA"
                    value={ruleReplace}
                    onChange={(e) => setRuleReplace(e.target.value)}
                  />
                </label>
                <button type="submit" className="button primary small">
                  Salvar e aplicar regra
                </button>
              </form>

              {customRules.length > 0 && (
                <div className="rules-list">
                  {customRules.map((rule) => (
                    <span key={rule.id} className="rule-chip">
                      &ldquo;{rule.keyword}&rdquo; → {rule.category}
                      {rule.accountCode ? ` [${rule.accountCode}]` : ''}
                      <button
                        type="button"
                        aria-label={`Remover regra ${rule.keyword}`}
                        onClick={() => removeRule(rule.id)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
              )}

              <form className="inline-form-row" onSubmit={handleBatchReplace}>
                <label>
                  Localizar no histórico (lote)
                  <input
                    placeholder="Texto a localizar em todas as linhas"
                    value={findText}
                    onChange={(e) => setFindText(e.target.value)}
                  />
                </label>
                <label>
                  Substituir por
                  <input
                    placeholder="Deixe vazio para remover o trecho"
                    value={replaceText}
                    onChange={(e) => setReplaceText(e.target.value)}
                  />
                </label>
                <button type="submit" className="button secondary small">
                  Substituir em lote
                </button>
              </form>
            </div>
          </details>

          {/* Column Resize & Display Settings Drawer */}
          <details className="panel-drawer">
            <summary>
              <span>Ajustar largura das colunas e exibição contábil</span>
              <span>Configurar tabela</span>
            </summary>
            <div className="drawer-body" style={{ display: 'grid', gap: '12px' }}>
              <label className="dedup-toggle">
                <input
                  type="checkbox"
                  checked={showAccountCode}
                  onChange={(e) => setShowAccountCode(e.target.checked)}
                />
                Exibir coluna editável &ldquo;Conta Contábil&rdquo; na grade de revisão
              </label>
              <div className="resize-grid">
                {(
                  [
                    ['date', 'Data'],
                    ['document', 'Documento'],
                    ['history', 'Histórico'],
                    ['category', 'Categoria'],
                    ['debit', 'Débito'],
                    ['credit', 'Crédito'],
                    ['balance', 'Saldo PDF'],
                  ] as const
                ).map(([col, label]) => (
                  <label key={col}>
                    {label} ({columnWidths[col]}px)
                    <input
                      type="range"
                      min={85}
                      max={620}
                      value={columnWidths[col]}
                      onChange={(e) =>
                        setColumnWidths((cur) => ({ ...cur, [col]: Number(e.target.value) }))
                      }
                    />
                  </label>
                ))}
              </div>
            </div>
          </details>

          {/* Filter Bar */}
          <div className="review-toolbar">
            <div className="filter-switch" role="group" aria-label="Filtrar lançamentos">
              <button
                type="button"
                className={filter === 'all' ? 'active' : ''}
                onClick={() => {
                  setFilter('all');
                  setPage(0);
                }}
              >
                Todos ({transactions.length})
              </button>
              <button
                type="button"
                className={filter === 'attention' ? 'active' : ''}
                onClick={() => {
                  setFilter('attention');
                  setPage(0);
                }}
              >
                Atenção ({attentionCount})
              </button>
              <button
                type="button"
                className={filter === 'divergent' ? 'active' : ''}
                onClick={() => {
                  setFilter('divergent');
                  setPage(0);
                }}
              >
                Divergências ({reconciliation.divergentDaysCount})
              </button>
              <button
                type="button"
                className={filter === 'credits' ? 'active' : ''}
                onClick={() => {
                  setFilter('credits');
                  setPage(0);
                }}
              >
                Créditos ({transactions.filter((t) => t.amount > 0).length})
              </button>
              <button
                type="button"
                className={filter === 'debits' ? 'active' : ''}
                onClick={() => {
                  setFilter('debits');
                  setPage(0);
                }}
              >
                Débitos ({transactions.filter((t) => t.amount < 0).length})
              </button>
            </div>

            <div className="toolbar-right-actions">
              {(selectedCategory || selectedMonth || searchQuery || filter !== 'all') && (
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => {
                    setFilter('all');
                    setSelectedCategory('');
                    setSelectedMonth('');
                    setSearchQuery('');
                    setColumnFilters({
                      dateFrom: '',
                      dateTo: '',
                      debit: '',
                      credit: '',
                      history: '',
                    });
                    setPage(0);
                  }}
                >
                  Limpar filtros
                </button>
              )}
              <button
                type="button"
                className="button secondary small"
                onClick={addManualTransaction}
              >
                + Novo lançamento
              </button>
            </div>
          </div>

          <div className="column-tools">
            <label>
              Busca global rápida
              <input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Histórico, doc., valor, banco ou categoria…"
              />
            </label>
            <label>
              Data inicial
              <input
                type="date"
                value={columnFilters.dateFrom}
                onChange={(e) => {
                  setColumnFilters((c) => ({ ...c, dateFrom: e.target.value }));
                  setPage(0);
                }}
              />
            </label>
            <label>
              Data final
              <input
                type="date"
                value={columnFilters.dateTo}
                onChange={(e) => {
                  setColumnFilters((c) => ({ ...c, dateTo: e.target.value }));
                  setPage(0);
                }}
              />
            </label>
            <label>
              Filtrar débito
              <input
                value={columnFilters.debit}
                onChange={(e) => {
                  setColumnFilters((c) => ({ ...c, debit: e.target.value }));
                  setPage(0);
                }}
                placeholder="Ex.: 120.00"
              />
            </label>
            <label>
              Filtrar crédito
              <input
                value={columnFilters.credit}
                onChange={(e) => {
                  setColumnFilters((c) => ({ ...c, credit: e.target.value }));
                  setPage(0);
                }}
                placeholder="Ex.: 1500"
              />
            </label>
            <label>
              Filtrar histórico
              <input
                value={columnFilters.history}
                onChange={(e) => {
                  setColumnFilters((c) => ({ ...c, history: e.target.value }));
                  setPage(0);
                }}
                placeholder="Palavra-chave"
              />
            </label>
          </div>

          <div className="table-frame">
            <table>
              <colgroup>
                <col style={{ width: columnWidths.date }} />
                <col style={{ width: columnWidths.document }} />
                <col style={{ width: columnWidths.history }} />
                <col style={{ width: columnWidths.category }} />
                {showAccountCode && <col style={{ width: 105 }} />}
                <col style={{ width: columnWidths.debit }} />
                <col style={{ width: columnWidths.credit }} />
                <col style={{ width: columnWidths.balance }} />
                <col style={{ width: 74 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>
                    <button type="button" className="sort-btn" onClick={() => toggleSort('date')}>
                      Data {sortField === 'date' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                  <th>Doc.</th>
                  <th>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('history')}
                    >
                      Histórico {sortField === 'history' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                  <th>
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('category')}
                    >
                      Categoria {sortField === 'category' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                  {showAccountCode && <th>Conta</th>}
                  <th className="num-col">
                    <button type="button" className="sort-btn" onClick={() => toggleSort('debit')}>
                      Débito {sortField === 'debit' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                  <th className="num-col">
                    <button
                      type="button"
                      className="sort-btn"
                      onClick={() => toggleSort('credit')}
                    >
                      Crédito {sortField === 'credit' ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
                    </button>
                  </th>
                  <th className="num-col">Saldo PDF / Conf.</th>
                  <th className="num-col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {visibleTransactions.map((tx) => {
                  const warnings = reviewWarnings(tx);
                  const isEod = reconciliation.endOfDayRowIds.has(tx.id);
                  const dayDelta = reconciliation.dayDeltaByRowId[tx.id];
                  const isDivergent = reconciliation.divergentRowIds.has(tx.id);
                  const calcBal = reconciliation.rowCalculatedBalance[tx.id] ?? null;

                  return (
                    <tr
                      key={tx.id}
                      className={`${hasAttention(tx) ? 'needs-review' : ''} ${
                        isDivergent ? 'has-divergence' : ''
                      }`}
                    >
                      <td>
                        <input
                          aria-label="Data"
                          type="date"
                          value={tx.date}
                          onChange={(e) => updateTransactionText(tx.id, 'date', e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          aria-label="Documento"
                          className="mono"
                          placeholder="—"
                          value={tx.document}
                          onChange={(e) => updateTransactionText(tx.id, 'document', e.target.value)}
                        />
                      </td>
                      <td className="history-cell">
                        <input
                          aria-label="Histórico"
                          value={tx.history}
                          onChange={(e) => updateTransactionText(tx.id, 'history', e.target.value)}
                        />
                        {warnings[0] && <small title={warnings.join(' ')}>{warnings[0]}</small>}
                      </td>
                      <td>
                        <select
                          aria-label="Categoria"
                          value={tx.category || 'Outros'}
                          onChange={(e) => updateTransactionText(tx.id, 'category', e.target.value)}
                        >
                          {CATEGORIES.map((cat) => (
                            <option key={cat} value={cat}>
                              {cat}
                            </option>
                          ))}
                        </select>
                      </td>
                      {showAccountCode && (
                        <td>
                          <input
                            aria-label="Conta Contábil"
                            className="mono"
                            value={tx.accountCode}
                            onChange={(e) =>
                              updateTransactionText(tx.id, 'accountCode', e.target.value)
                            }
                          />
                        </td>
                      )}
                      <td>
                        <MoneyInput
                          ariaLabel="Débito"
                          className="input-negative"
                          value={tx.debit}
                          blankZero
                          onCommit={(val) => updateTransactionMoney(tx.id, 'debit', val)}
                        />
                      </td>
                      <td>
                        <MoneyInput
                          ariaLabel="Crédito"
                          className="input-positive"
                          value={tx.credit}
                          blankZero
                          onCommit={(val) => updateTransactionMoney(tx.id, 'credit', val)}
                        />
                      </td>
                      <td>
                        {(isEod || tx.balance !== null) && (
                          <>
                            <MoneyInput
                              ariaLabel="Saldo informado no PDF"
                              allowNegative
                              value={tx.balance}
                              placeholder={calcBal !== null ? formatBrNumber(calcBal) : '—'}
                              onCommit={(val) => updateTransactionMoney(tx.id, 'balance', val)}
                            />
                            {isEod && dayDelta !== undefined && (
                              <span
                                className={`balance-note ${
                                  Math.abs(dayDelta) <= 0.02 ? 'ok' : 'diff'
                                }`}
                              >
                                {Math.abs(dayDelta) <= 0.02
                                  ? '✓ Conciliado'
                                  : `Dif: ${amountLabel(dayDelta)}`}
                              </span>
                            )}
                          </>
                        )}
                      </td>
                      <td>
                        <div className="row-actions">
                          <button
                            type="button"
                            className="icon-button swap-sign"
                            title="Inverter Débito ⇄ Crédito"
                            aria-label="Inverter sinal entre Débito e Crédito"
                            onClick={() => invertTransactionSign(tx.id)}
                          >
                            ⇄
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="Excluir lançamento"
                            aria-label="Excluir lançamento"
                            onClick={() => deleteTransactionRow(tx.id)}
                          >
                            ×
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <span>
              Mostrando {filteredTransactions.length ? page * PAGE_SIZE + 1 : 0}–
              {Math.min((page + 1) * PAGE_SIZE, filteredTransactions.length)} de{' '}
              {filteredTransactions.length} lançamento(s)
            </span>
            <div>
              <button
                type="button"
                onClick={() => setPage((value) => Math.max(0, value - 1))}
                disabled={page === 0}
              >
                Anterior
              </button>
              <span>
                Página {page + 1} de {pageCount}
              </span>
              <button
                type="button"
                onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))}
                disabled={page + 1 >= pageCount}
              >
                Próxima
              </button>
            </div>
          </div>
        </section>
      )}

      <footer>
        Feito por Ademir Varjão · Conversor de Extratos — Processamento 100% local no navegador
      </footer>

      {!cookiesAccepted && (
        <aside className="cookie-notice" role="dialog" aria-label="Aviso de armazenamento local">
          <strong>Privacidade &amp; Armazenamento Local</strong>
          <span>
            Usamos apenas armazenamento local do seu navegador para salvar tema, regras contábeis e
            rascunho da conferência. Nenhum arquivo é enviado à internet.
          </span>
          <button type="button" className="button primary" onClick={acceptCookies}>
            Entendi
          </button>
        </aside>
      )}
    </main>
  );
}
