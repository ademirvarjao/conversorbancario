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
import { mergeWithSmartDedup } from './lib/dedup';
import { downloadCsv, downloadOfx, downloadXlsx } from './lib/exporters';
import {
  diagnoseAndSolveDivergences,
  exportMemoryPayload,
  hydrateMemoryFromIndexedDb,
  loadAiConfig,
  loadEventsSync,
  loadModelsSync,
  parseImportedMemoryPayload,
  persistMemory,
  recordIgnoredRowInModel,
  recordSignCorrectionInModel,
  saveAiConfig,
  upsertModelInList,
} from './lib/layoutAgent';
import { computeReconciliation } from './lib/reconciliation';
import type {
  AiProviderConfig,
  ExportLayout,
  ExportScope,
  ImportedFile,
  LearnedLayoutModel,
  LearningEvent,
  ProcessSummary,
  Transaction,
} from './types';

const PAGE_SIZE = 100;
const SESSION_STORAGE_KEY = 'conversor-extratos-session-v3';

type FilterTab = 'all' | 'attention' | 'divergent' | 'credits' | 'debits';
type SortField = 'default' | 'date' | 'debit' | 'credit' | 'history';
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

function formatTimeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
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
  const importMemoryInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('conversor-extrato-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });

  // Persistent Evolving AI Layout Memory (IndexedDB + localStorage)
  const [learnedModels, setLearnedModels] = useState<LearnedLayoutModel[]>(() => loadModelsSync());
  const [learningEvents, setLearningEvents] = useState<LearningEvent[]>(() => loadEventsSync());
  const [aiConfig, setAiConfig] = useState<AiProviderConfig | null>(() => loadAiConfig());
  const [aiCommand, setAiCommand] = useState('');

  // External LLM config form drafts
  const [providerDraft, setProviderDraft] = useState<AiProviderConfig['provider']>(
    () => loadAiConfig()?.provider ?? 'gemini',
  );
  const [apiKeyDraft, setApiKeyDraft] = useState(() => loadAiConfig()?.apiKey ?? '');
  const [modelNameDraft, setModelNameDraft] = useState(
    () => loadAiConfig()?.model ?? 'gemini-2.5-flash',
  );

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
    date: 132,
    document: 112,
    history: 490,
    debit: 128,
    credit: 128,
    balance: 152,
  });

  const [findText, setFindText] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});

  const [cookiesAccepted, setCookiesAccepted] = useState(() => {
    try {
      return localStorage.getItem('conversor-extrato-cookies') === 'accepted';
    } catch {
      return true;
    }
  });

  // Hydrate persistent memory from IndexedDB on boot
  useEffect(() => {
    void hydrateMemoryFromIndexedDb().then(({ models, events }) => {
      if (models.length > 0) setLearnedModels(models);
      if (events.length > 0) setLearningEvents(events);
    });
  }, []);

  const commitMemoryUpdate = useCallback(
    (nextModels: LearnedLayoutModel[], newEvents: LearningEvent[]) => {
      const mergedEvents = [...newEvents, ...learningEvents].slice(0, 60);
      setLearnedModels(nextModels);
      setLearningEvents(mergedEvents);
      persistMemory(nextModels, mergedEvents);
    },
    [learningEvents],
  );

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
      // Ignore quota exceeded
    }
  }, [transactions, manualOpeningBalance]);

  const reconciliation = useMemo(
    () => computeReconciliation(transactions, manualOpeningBalance),
    [transactions, manualOpeningBalance],
  );

  const pendingAutoFixes = useMemo(
    () => diagnoseAndSolveDivergences(transactions, reconciliation),
    [transactions, reconciliation],
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

    return [...filtered].sort((a, b) => {
      let cmp = 0;
      if (sortField === 'date') cmp = a.date.localeCompare(b.date);
      else if (sortField === 'debit') cmp = a.debit - b.debit;
      else if (sortField === 'credit') cmp = a.credit - b.credit;
      else if (sortField === 'history') cmp = a.history.localeCompare(b.history, 'pt-BR');
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [
    transactions,
    filter,
    hasAttention,
    reconciliation.divergentRowIds,
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

  const totalLearnedRulesCount = useMemo(
    () =>
      learnedModels.reduce(
        (sum, m) =>
          sum +
          m.creditKeywords.length +
          m.debitKeywords.length +
          m.ignoredPatterns.length +
          m.historyReplacements.length,
        0,
      ),
    [learnedModels],
  );

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
    const supported = selected.filter(
      (file) =>
        /\.(pdf|ofx|qfx|csv|txt|xlsx|xls)$/i.test(file.name) ||
        file.type === 'application/pdf',
    );
    const invalidCount = selected.length - supported.length;
    if (invalidCount > 0) {
      setMessage(`${invalidCount} arquivo(s) ignorado(s): envie PDF, OFX, CSV, TXT ou XLSX.`);
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
          `${additions.length} arquivo(s) na fila. O Agente de I.A. aplicará e salvará o aprendizado de layout automaticamente.`,
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

  const clearAll = () => {
    if (processing) return;
    pushUndoSnapshot(transactions);
    setFiles([]);
    setTransactions([]);
    setManualOpeningBalance(null);
    setProcessSummary(null);
    setSearchQuery('');
    setMessage('Mesa limpa (os modelos de layout aprendidos pela I.A. permanecem salvos na memória).');
  };

  const removeFile = (id: string) => {
    if (processing) return;
    pushUndoSnapshot(transactions);
    setFiles((current) => current.filter((item) => item.id !== id));
    setTransactions((current) => current.filter((transaction) => transaction.sourceId !== id));
    setMessage('Arquivo removido da conferência.');
  };

  const runQueue = async (
    targetItems: ImportedFile[],
    overrideModels?: LearnedLayoutModel[],
    replaceExistingFromSources = false,
  ) => {
    if (!targetItems.length || processing) return;

    const controller = new AbortController();
    abortRef.current = controller;
    setProcessing(true);
    setProgressPct(4);
    setMessage('Agente de I.A. analisando estrutura de colunas, datas e sinais dos extratos…');

    let workingModels = [...(overrideModels ?? learnedModels)];
    const generatedEvents: LearningEvent[] = [];
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
        const result = await parseUnifiedStatement(item.file, {
          sourceId: item.id,
          password: item.password,
          signal: controller.signal,
          learnedModels: workingModels,
          aiConfig,
          onPage: (currentPage, totalPages) => {
            const fileBase = (index / targetItems.length) * 100;
            const fileStep = (currentPage / Math.max(1, totalPages)) * (100 / targetItems.length);
            setProgressPct(Math.min(98, Math.round(fileBase + fileStep)));
            setMessage(`Lendo ${item.file.name}: página ${currentPage} de ${totalPages}…`);
          },
        });

        workingModels = upsertModelInList(workingModels, result.updatedModel);
        for (const note of result.agentNotes) {
          generatedEvents.push({
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            modelName: result.updatedModel.name,
            kind: result.wasKnownModel ? 'matched-model' : 'new-model',
            detail: note,
          });
        }

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
                  matchedModelId: result.updatedModel.id,
                  matchedModelName: result.updatedModel.name,
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

    commitMemoryUpdate(workingModels, generatedEvents);

    if (extracted.length > 0 || errors > 0) {
      pushUndoSnapshot(transactions);
      if (manualOpeningBalance === null && firstOpeningBalance !== null) {
        setManualOpeningBalance(firstOpeningBalance);
      }
      const sourceIdsToReplace = new Set(targetItems.map((i) => i.id));
      setTransactions((current) => {
        const base = replaceExistingFromSources
          ? current.filter((tx) => !sourceIdsToReplace.has(tx.sourceId))
          : current;
        const merged = mergeWithSmartDedup(base, extracted, removeDuplicates);
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
            ? 'Processamento concluído com avisos. Verifique os arquivos sinalizados.'
            : `Conversão concluída (${extracted.length} lançamentos). Modelo de layout salvo na memória evolutiva da I.A.!`,
        );
        return merged.records;
      });
    } else if (controller.signal.aborted) {
      setMessage('Leitura cancelada pelo usuário.');
    }

    setProgressPct(100);
    setProcessing(false);
    abortRef.current = null;
  };

  const processFiles = () => {
    const queue = files.filter((file) => file.state === 'ready');
    void runQueue(queue);
  };

  const reprocessAllWithLearnedMemory = () => {
    if (!files.length || processing) return;
    void runQueue(files, learnedModels, true);
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
    field: 'date' | 'document' | 'history' | 'accountCode',
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
    const targetTx = transactions.find((t) => t.id === id);
    pushUndoSnapshot(transactions);

    let nextAmountForLearning: number | null = null;
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
          if (tx.amount >= 0 && amount < 0) nextAmountForLearning = amount;
          return { ...tx, debit: val, credit: newCredit, amount };
        }
        const newDebit = val > 0 ? 0 : tx.debit;
        const amount = Math.round((val - newDebit) * 100) / 100;
        if (tx.amount <= 0 && amount > 0) nextAmountForLearning = amount;
        return { ...tx, credit: val, debit: newDebit, amount };
      }),
    );

    if (targetTx && nextAmountForLearning !== null) {
      const { models, event } = recordSignCorrectionInModel(
        learnedModels,
        targetTx,
        nextAmountForLearning,
      );
      if (event) {
        commitMemoryUpdate(models, [event]);
        setMessage(`I.A. aprendeu com seu ajuste: ${event.detail}`);
      }
    }
  };

  // Every manual flip teaches the AI layout memory automatically!
  const invertTransactionSign = (id: string) => {
    const targetTx = transactions.find((t) => t.id === id);
    if (!targetTx) return;
    pushUndoSnapshot(transactions);
    const flipped = -targetTx.amount;

    setTransactions((current) =>
      current.map((tx) =>
        tx.id === id
          ? {
              ...tx,
              amount: flipped,
              debit: flipped < 0 ? Math.abs(flipped) : 0,
              credit: flipped > 0 ? flipped : 0,
            }
          : tx,
      ),
    );

    const { models, event } = recordSignCorrectionInModel(learnedModels, targetTx, flipped);
    if (event) {
      commitMemoryUpdate(models, [event]);
      setMessage(`Sinal invertido e salvo na memória da I.A.: ${event.detail}`);
    }
  };

  // Deleting a noise/subtotal row teaches the layout model to ignore it in future uploads!
  const deleteTransactionRow = (id: string) => {
    const targetTx = transactions.find((t) => t.id === id);
    pushUndoSnapshot(transactions);
    setTransactions((current) => current.filter((tx) => tx.id !== id));

    if (targetTx && targetTx.sourceId !== 'manual') {
      const { models, event } = recordIgnoredRowInModel(learnedModels, targetTx);
      if (event) {
        commitMemoryUpdate(models, [event]);
        setMessage(`Linha excluída e memorizada pela I.A.: ${event.detail}`);
        return;
      }
    }
    setMessage('Lançamento excluído (clique em "Desfazer" se desejar restaurar).');
  };

  const applyAiAutoReconcile = () => {
    if (!pendingAutoFixes.length) {
      setMessage('Nenhuma divergência matemática pendente para reparo automático.');
      return;
    }
    pushUndoSnapshot(transactions);
    const removeIds = new Set(
      pendingAutoFixes.filter((f) => f.action === 'remove-noise').map((f) => f.transactionId),
    );
    const flipIds = new Set(
      pendingAutoFixes.filter((f) => f.action === 'invert-sign').map((f) => f.transactionId),
    );

    let updatedModels = [...learnedModels];
    const events: LearningEvent[] = [];

    for (const fix of pendingAutoFixes) {
      const originalTx = transactions.find((t) => t.id === fix.transactionId);
      if (!originalTx) continue;
      if (fix.action === 'invert-sign') {
        const res = recordSignCorrectionInModel(updatedModels, originalTx, fix.newAmount);
        updatedModels = res.models;
        if (res.event) events.push(res.event);
      } else {
        const res = recordIgnoredRowInModel(updatedModels, originalTx);
        updatedModels = res.models;
        if (res.event) events.push(res.event);
      }
    }

    setTransactions((current) =>
      current
        .filter((tx) => !removeIds.has(tx.id))
        .map((tx) => {
          if (!flipIds.has(tx.id)) return tx;
          const flipped = -tx.amount;
          return {
            ...tx,
            amount: flipped,
            debit: flipped < 0 ? Math.abs(flipped) : 0,
            credit: flipped > 0 ? flipped : 0,
          };
        }),
    );

    events.unshift({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      modelName: updatedModels[0]?.name ?? 'Memória Geral',
      kind: 'auto-reconcile',
      detail: `Agente de I.A. aplicou ${pendingAutoFixes.length} correção(ões) matemática(s) conciliando os saldos diários.`,
    });
    commitMemoryUpdate(updatedModels, events);
    setFilter('all');
    setMessage(
      `Agente de I.A. corrigiu ${pendingAutoFixes.length} lançamento(s), conciliou o saldo e salvou o aprendizado na memória!`,
    );
  };

  // Natural-language AI Assistant handler
  const handleAiPromptSubmit = (event: FormEvent) => {
    event.preventDefault();
    const raw = aiCommand.trim();
    if (!raw) return;
    const lower = raw.toLocaleLowerCase('pt-BR');

    // 1. Reconcile / Fix balance divergences
    if (/(concili|corrigir?\s+diverg|ajustar?\s+saldo)/.test(lower)) {
      applyAiAutoReconcile();
      setAiCommand('');
      return;
    }

    // 2. Swap debit/credit columns on learned model & reprocess
    if (/inverter\s+colunas|trocar\s+colunas/.test(lower)) {
      if (!learnedModels.length) {
        setMessage('Importe um arquivo primeiro para calibrar as colunas do modelo.');
        return;
      }
      const target = learnedModels[0];
      const toggled: LearnedLayoutModel = {
        ...target,
        swapDebitCreditColumns: !target.swapDebitCreditColumns,
        updatedAt: new Date().toISOString(),
      };
      const nextModels = upsertModelInList(learnedModels, toggled);
      const ev: LearningEvent = {
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        modelName: toggled.name,
        kind: 'ai-assist',
        detail: `Ordem das colunas Débito/Crédito invertida e salva no modelo "${toggled.name}".`,
      };
      commitMemoryUpdate(nextModels, [ev]);
      setAiCommand('');
      if (files.length > 0) {
        void runQueue(files, nextModels, true);
      } else {
        setMessage(ev.detail);
      }
      return;
    }

    // 3. Teach ignore rule: "ignorar [TERMO]" / "remover linhas com [TERMO]"
    const ignoreMatch = raw.match(
      /(?:ignorar?|ignore|excluir?|remover?)(?:\s+linhas?\s+(?:com|que\s+contenham?))?\s+["']?(.+?)["']?$/i,
    );
    if (ignoreMatch?.[1]) {
      const pattern = ignoreMatch[1].trim().toUpperCase();
      pushUndoSnapshot(transactions);
      const before = transactions.length;
      const remaining = transactions.filter((tx) => !tx.history.toUpperCase().includes(pattern));
      setTransactions(remaining);

      if (learnedModels.length > 0) {
        const target = learnedModels[0];
        const updated: LearnedLayoutModel = {
          ...target,
          ignoredPatterns: [...new Set([pattern, ...target.ignoredPatterns])],
          updatedAt: new Date().toISOString(),
        };
        commitMemoryUpdate(upsertModelInList(learnedModels, updated), [
          {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            modelName: updated.name,
            kind: 'learned-ignore',
            detail: `Regra ensinada ao Agente: ignorar sempre linhas contendo "${pattern}" no modelo ${updated.name}.`,
          },
        ]);
      }
      setAiCommand('');
      setMessage(
        `I.A. memorizou o filtro "${pattern}" (${before - remaining.length} linha(s) removida(s) agora e filtradas automaticamente nos próximos extratos).`,
      );
      return;
    }

    // 4. Teach credit / debit rule: "[TERMO] é crédito/débito" or "converter [TERMO] para débito/crédito"
    const isDebitCmd = /\bd[eé]bito\b|\bsa[ií]da\b|\bnegativo\b/i.test(lower);
    const isCreditCmd = /\bcr[eé]dito\b|\bentrada\b|\bpositivo\b/i.test(lower);
    if (isDebitCmd || isCreditCmd) {
      const cleanedTerm = raw
        .replace(
          /\b(?:todo\s+lan[çc]amento\s+com|lan[çc]amentos?\s+com|converter|marcar|definir|deve\s+ser|[eé]|como|para|sempre|d[eé]bito|deb|cr[eé]dito|cred|sa[ií]da|entrada|negativo|positivo)\b/gi,
          ' ',
        )
        .replace(/["']/g, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toUpperCase();

      if (cleanedTerm.length >= 2) {
        pushUndoSnapshot(transactions);
        let count = 0;
        setTransactions((current) =>
          current.map((tx) => {
            if (!tx.history.toUpperCase().includes(cleanedTerm)) return tx;
            const abs = Math.abs(tx.amount);
            const nextAmt = isCreditCmd ? abs : -abs;
            if (nextAmt !== tx.amount) count += 1;
            return {
              ...tx,
              amount: nextAmt,
              debit: nextAmt < 0 ? abs : 0,
              credit: nextAmt > 0 ? abs : 0,
            };
          }),
        );

        if (learnedModels.length > 0) {
          const target = learnedModels[0];
          const updated: LearnedLayoutModel = {
            ...target,
            creditKeywords: isCreditCmd
              ? [...new Set([cleanedTerm, ...target.creditKeywords])]
              : target.creditKeywords.filter((k) => k !== cleanedTerm),
            debitKeywords: !isCreditCmd
              ? [...new Set([cleanedTerm, ...target.debitKeywords])]
              : target.debitKeywords.filter((k) => k !== cleanedTerm),
            updatedAt: new Date().toISOString(),
          };
          commitMemoryUpdate(upsertModelInList(learnedModels, updated), [
            {
              id: crypto.randomUUID(),
              timestamp: new Date().toISOString(),
              modelName: updated.name,
              kind: 'learned-sign',
              detail: `Ensinamento salvo: "${cleanedTerm}" classificado sempre como ${
                isCreditCmd ? 'CRÉDITO (+)' : 'DÉBITO (-)'
              } no modelo ${updated.name}.`,
            },
          ]);
        }
        setAiCommand('');
        setMessage(
          `I.A. aprendeu que "${cleanedTerm}" é ${
            isCreditCmd ? 'Crédito (+)' : 'Débito (-)'
          } (${count} lançamento(s) ajustado(s) e salvo para próximos PDFs).`,
        );
        return;
      }
    }

    // 5. Teach text replacement: "substituir X por Y"
    const repMatch = raw.match(/substitu(?:ir|a)\s+["']?(.+?)["']?\s+por\s+["']?(.+?)["']?$/i);
    if (repMatch?.[1]) {
      const fromStr = repMatch[1].trim();
      const toStr = repMatch[2]?.trim() ?? '';
      pushUndoSnapshot(transactions);
      const escaped = fromStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'gi');
      let updatedCount = 0;
      setTransactions((current) =>
        current.map((tx) => {
          if (!regex.test(tx.history)) return tx;
          updatedCount += 1;
          return {
            ...tx,
            history: tx.history.replace(regex, toStr).replace(/\s+/g, ' ').trim(),
          };
        }),
      );
      if (learnedModels.length > 0) {
        const target = learnedModels[0];
        const updated: LearnedLayoutModel = {
          ...target,
          historyReplacements: [
            ...target.historyReplacements.filter((r) => r.from !== fromStr),
            { from: fromStr, to: toStr },
          ],
          updatedAt: new Date().toISOString(),
        };
        commitMemoryUpdate(upsertModelInList(learnedModels, updated), [
          {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            modelName: updated.name,
            kind: 'learned-clean',
            detail: `Substituição automática memorizada: "${fromStr}" → "${toStr}".`,
          },
        ]);
      }
      setAiCommand('');
      setMessage(`Padronização aplicada em ${updatedCount} linha(s) e salva na memória da I.A.`);
      return;
    }

    setMessage(
      'Dica do Agente de I.A.: experimente comandos como "TARIFA CESTA é débito", "RESGATE AUT é crédito", "ignorar SALDO APLIC AUT", "substituir PAGTO ELETRON por PAGAMENTO BOLETO" ou "corrigir divergências".',
    );
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
      history: 'LANÇAMENTO MANUAL',
      accountCode: '',
      amount: 0,
      debit: 0,
      credit: 0,
      balance: null,
      sourceId: 'manual',
      sourceFile: 'Manual',
      sourceBank: 'Manual',
      sourcePage: 1,
      confidence: 0.99,
      warnings: [],
    };
    setTransactions((current) => [newTx, ...current]);
    setPage(0);
    setMessage('Novo lançamento manual adicionado.');
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

    if (learnedModels.length > 0 && changed > 0) {
      const target = learnedModels[0];
      const updated: LearnedLayoutModel = {
        ...target,
        historyReplacements: [
          ...target.historyReplacements.filter((r) => r.from !== needle),
          { from: needle, to: replaceText },
        ],
        updatedAt: new Date().toISOString(),
      };
      commitMemoryUpdate(upsertModelInList(learnedModels, updated), [
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          modelName: updated.name,
          kind: 'learned-clean',
          detail: `Padronização "${needle}" → "${replaceText}" salva no modelo ${updated.name}.`,
        },
      ]);
    }

    setMessage(
      changed > 0
        ? `Histórico atualizado em ${changed} lançamento(s) e salvo na memória da I.A.`
        : `Nenhum histórico encontrado contendo "${needle}".`,
    );
  };

  const handleSaveAiProvider = (event: FormEvent) => {
    event.preventDefault();
    if (!apiKeyDraft.trim()) {
      saveAiConfig(null);
      setAiConfig(null);
      setMessage('Conector externo removido. O Agente Neural Local permanece 100% ativo.');
      return;
    }
    const cfg: AiProviderConfig = {
      provider: providerDraft,
      apiKey: apiKeyDraft.trim(),
      model: modelNameDraft.trim(),
    };
    saveAiConfig(cfg);
    setAiConfig(cfg);
    setMessage(`Conector ${cfg.provider.toUpperCase()} salvo localmente no navegador.`);
  };

  const handleExportMemory = () => {
    const json = exportMemoryPayload(learnedModels, learningEvents);
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'memoria-ia-conversor-extratos.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const handleImportMemory = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      const raw = await file.text();
      const imported = parseImportedMemoryPayload(raw);
      let merged = [...learnedModels];
      for (const m of imported.models) {
        merged = upsertModelInList(merged, m);
      }
      commitMemoryUpdate(merged, [
        {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          modelName: 'Memória Importada',
          kind: 'ai-assist',
          detail: `${imported.models.length} modelo(s) de layout importado(s) com sucesso.`,
        },
      ]);
      setMessage(`${imported.models.length} modelo(s) de layout carregado(s) na memória da I.A.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : 'Falha ao importar memória JSON.');
    }
  };

  const removeLearnedModel = (id: string) => {
    const remaining = learnedModels.filter((m) => m.id !== id);
    commitMemoryUpdate(remaining, []);
    setMessage('Modelo removido da memória da I.A.');
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

  const handleExportXlsx = async () => {
    const target = getExportTarget();
    if (!target) return;
    await downloadXlsx(target, reconciliation, exportLayout);
    setMessage(`Planilha Excel exportada (${target.length} lançamentos na aba Lançamentos).`);
  };

  const handleExportCsv = () => {
    const target = getExportTarget();
    if (!target) return;
    downloadCsv(target, exportLayout, reconciliation);
    setMessage(`Arquivo CSV exportado (${target.length} lançamentos).`);
  };

  const handleExportOfx = () => {
    const target = getExportTarget();
    if (!target) return;
    downloadOfx(target, reconciliation);
    setMessage(`Arquivo OFX gerado (${target.length} lançamentos).`);
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
        </a>

        <div className="topbar-right">
          <a className="ai-status-chip" href="#agente-ia">
            <i className="pulse" aria-hidden="true" />
            I.A. Evolutiva · {learnedModels.length} modelo{learnedModels.length === 1 ? '' : 's'} salvo{learnedModels.length === 1 ? '' : 's'}
          </a>
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

      <section className="workspace" id="inicio" aria-label="Importação de extratos">
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
              Cada layout processado é catalogado automaticamente pela I.A. para aperfeiçoar
              conversões futuras.
            </p>
          </div>
          <div className="drop-actions">
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
                    {item.matchedModelName ? (
                      <span className="bank-badge">{item.matchedModelName}</span>
                    ) : (
                      item.bankName && <span className="bank-badge">{item.bankName}</span>
                    )}
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
                  : 'Adicione um ou mais arquivos de extrato'}
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
            {files.length > 0 && !processing && (
              <button
                className="button secondary"
                type="button"
                onClick={reprocessAllWithLearnedMemory}
              >
                Reprocessar com memória da I.A.
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

      {/* Evolutionary AI Layout Agent Section */}
      <section
        className="ai-agent-card"
        id="agente-ia"
        aria-labelledby="ai-agent-heading"
      >
        <div className="workspace-title">
          <div>
            <span className="section-index">I.A.</span>
            <h2 id="ai-agent-heading">Agente de I.A. &amp; Memória Evolutiva de Layouts</h2>
          </div>
          <span className="file-counter">
            {learnedModels.length} layout{learnedModels.length === 1 ? '' : 's'} aprendido
            {learnedModels.length === 1 ? '' : 's'} · {totalLearnedRulesCount} regra
            {totalLearnedRulesCount === 1 ? '' : 's'} ativa{totalLearnedRulesCount === 1 ? '' : 's'}
          </span>
        </div>

        <form className="ai-prompt-form" onSubmit={handleAiPromptSubmit}>
          <input
            aria-label="Instruir Agente de I.A."
            placeholder='Ensine ou peça ajustes ao Agente (ex.: "TARIFA CESTA é débito", "RESGATE AUT é crédito", "ignorar SALDO APLIC AUT", "inverter colunas")…'
            value={aiCommand}
            onChange={(e) => setAiCommand(e.target.value)}
          />
          <button type="submit" className="button primary">
            Aplicar e ensinar I.A.
          </button>
        </form>

        <div className="ai-quick-actions">
          {pendingAutoFixes.length > 0 && (
            <button
              type="button"
              className="chip-action"
              onClick={applyAiAutoReconcile}
              style={{ borderColor: 'var(--warning)', color: 'var(--warning)' }}
            >
              ⚡ Auto-corrigir {pendingAutoFixes.length} divergência(s) matemática(s) com I.A.
            </button>
          )}
          <button
            type="button"
            className="chip-action"
            onClick={() => setAiCommand('corrigir divergências')}
          >
            Auditar saldos diários
          </button>
          <button
            type="button"
            className="chip-action"
            onClick={() => setAiCommand('inverter colunas')}
          >
            Inverter colunas Débito/Crédito deste layout
          </button>
          <button type="button" className="chip-action" onClick={handleExportMemory}>
            Exportar memória (.json)
          </button>
          <button
            type="button"
            className="chip-action"
            onClick={() => importMemoryInputRef.current?.click()}
          >
            Importar memória (.json)
          </button>
          <input
            ref={importMemoryInputRef}
            className="visually-hidden"
            type="file"
            accept="application/json,.json"
            onChange={handleImportMemory}
          />
        </div>

        <div className="ai-grid">
          <div className="ai-box">
            <div className="ai-box-header">
              <strong>Modelos de Layout Salvos ({learnedModels.length})</strong>
            </div>

            {learnedModels.length === 0 ? (
              <p className="empty-hint">
                Nenhum extrato processado ainda. Ao importar qualquer extrato, o Agente identifica
                colunas, formato de data e sinais, salvando o modelo aqui e evoluindo a cada ajuste
                feito na tabela.
              </p>
            ) : (
              <div className="model-list">
                {learnedModels.map((model) => (
                  <div className="model-item" key={model.id}>
                    <div className="model-item-main">
                      <strong>{model.name}</strong>
                      <small>
                        Visto {model.timesSeen}x · {model.totalTransactions} lançamentos · Precisão{' '}
                        {model.accuracyScore}% · Data {model.dateStyle}
                      </small>
                      {(model.creditKeywords.length > 0 ||
                        model.debitKeywords.length > 0 ||
                        model.ignoredPatterns.length > 0) && (
                        <small style={{ color: 'var(--accent)' }}>
                          +{model.creditKeywords.length} créd. · -{model.debitKeywords.length} déb.{' '}
                          · {model.ignoredPatterns.length} filtro(s) de ruído
                        </small>
                      )}
                    </div>
                    <button
                      type="button"
                      className="icon-button"
                      title={`Remover modelo ${model.name}`}
                      aria-label={`Remover modelo ${model.name}`}
                      onClick={() => removeLearnedModel(model.id)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ai-box">
            <div className="ai-box-header">
              <strong>Histórico de Aprendizado Contínuo</strong>
            </div>

            {learningEvents.length === 0 ? (
              <p className="empty-hint">
                Sempre que você inverter o sinal (⇄), excluir um cabeçalho/subtotal (×) ou ensinar
                uma regra, a I.A. registrará o aprendizado aqui para aplicar automaticamente nos
                próximos arquivos do mesmo banco.
              </p>
            ) : (
              <div className="event-feed">
                {learningEvents.slice(0, 12).map((ev) => (
                  <div className="event-row" key={ev.id}>
                    <time>{formatTimeShort(ev.timestamp)}</time>
                    {ev.detail}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <details className="panel-drawer" style={{ margin: '14px 0 0' }}>
          <summary>
            <span>Conectar API de I.A. Generativa Externa Opcional (Gemini / OpenAI / OpenRouter)</span>
            <span>{aiConfig?.apiKey ? `Conectado (${aiConfig.provider.toUpperCase()})` : 'Opcional'}</span>
          </summary>
          <div className="drawer-body">
            <form className="inline-form-row" onSubmit={handleSaveAiProvider}>
              <label style={{ flex: '0 1 170px' }}>
                Provedor
                <select
                  value={providerDraft}
                  onChange={(e) => setProviderDraft(e.target.value as AiProviderConfig['provider'])}
                >
                  <option value="gemini">Google Gemini</option>
                  <option value="openai">OpenAI</option>
                  <option value="openrouter">OpenRouter</option>
                </select>
              </label>
              <label style={{ flex: '0 1 210px' }}>
                Modelo
                <input
                  placeholder="gemini-2.5-flash"
                  value={modelNameDraft}
                  onChange={(e) => setModelNameDraft(e.target.value)}
                />
              </label>
              <label>
                Chave de API (guardada apenas neste navegador)
                <input
                  type="password"
                  placeholder="Cole sua API Key para PDFs atípicos sem estrutura tabular…"
                  value={apiKeyDraft}
                  onChange={(e) => setApiKeyDraft(e.target.value)}
                />
              </label>
              <button type="submit" className="button secondary small">
                Salvar configuração
              </button>
            </form>
          </div>
        </details>
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
                <option value="completo">Modelo Completo (Data · Doc. · Histórico · Débito · Crédito · Saldo)</option>
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
                <label>Saldo inicial:</label>
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

          {/* Batch Find/Replace & Column Sizing Drawers */}
          <details className="panel-drawer">
            <summary>
              <span>Padronizar Histórico em Lote &amp; Ajustar Colunas</span>
              <span>Configurar</span>
            </summary>
            <div className="drawer-body" style={{ display: 'grid', gap: '14px' }}>
              <form className="inline-form-row" onSubmit={handleBatchReplace}>
                <label>
                  Localizar no histórico
                  <input
                    placeholder="Trecho a localizar em todas as linhas"
                    value={findText}
                    onChange={(e) => setFindText(e.target.value)}
                  />
                </label>
                <label>
                  Substituir por (também ensina a I.A.)
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

              <label className="dedup-toggle">
                <input
                  type="checkbox"
                  checked={showAccountCode}
                  onChange={(e) => setShowAccountCode(e.target.checked)}
                />
                Exibir coluna editável &ldquo;Conta Contábil&rdquo; na tabela
              </label>

              <div className="resize-grid">
                {(
                  [
                    ['date', 'Data'],
                    ['document', 'Documento'],
                    ['history', 'Histórico'],
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
                      max={680}
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
              {(searchQuery || filter !== 'all') && (
                <button
                  type="button"
                  className="button ghost small"
                  onClick={() => {
                    setFilter('all');
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
              Busca rápida
              <input
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setPage(0);
                }}
                placeholder="Histórico, documento, valor ou banco…"
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
                            title="Inverter Débito ⇄ Crédito (ensina a I.A.)"
                            aria-label="Inverter sinal entre Débito e Crédito"
                            onClick={() => invertTransactionSign(tx.id)}
                          >
                            ⇄
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            title="Excluir linha (ensina a I.A. a ignorar ruído)"
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
          <strong>Memória Local da I.A.</strong>
          <span>
            Usamos apenas armazenamento local do seu navegador (IndexedDB / LocalStorage) para
            salvar o aprendizado evolutivo dos layouts e sua conferência.
          </span>
          <button type="button" className="button primary" onClick={acceptCookies}>
            Entendi
          </button>
        </aside>
      )}
    </main>
  );
}
