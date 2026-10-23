export type FileState = 'ready' | 'processing' | 'done' | 'needs-password' | 'error';
export type FileFormat = 'pdf' | 'ofx' | 'csv' | 'xlsx';

export interface ImportedFile {
  id: string;
  file: File;
  format: FileFormat;
  state: FileState;
  transactions: number;
  pages?: number;
  bankName?: string;
  matchedModelId?: string;
  matchedModelName?: string;
  openingBalance?: number | null;
  closingBalance?: number | null;
  password?: string;
  error?: string;
}

export interface Transaction {
  id: string;
  date: string;
  document: string;
  history: string;
  accountCode: string;
  amount: number;
  debit: number;
  credit: number;
  balance: number | null;
  sourceId: string;
  sourceFile: string;
  sourceBank?: string;
  layoutModelId?: string;
  sourcePage: number;
  occurrenceInSource?: number;
  confidence: number;
  warnings: string[];
  isDuplicate?: boolean;
}

export interface LearnedColumns {
  dateX?: number;
  debitX?: number;
  creditX?: number;
  amountX?: number;
  balanceX?: number;
  maxLineGapY?: number;
}

export interface HistoryReplacementRule {
  from: string;
  to: string;
}

export interface LearnedLayoutModel {
  id: string;
  fingerprint: string;
  name: string;
  bankName: string;
  headerTokens: string[];
  dateStyle: 'DD/MM/YYYY' | 'DD/MM' | 'WRITTEN_PT' | 'ISO' | 'MIXED';
  signStyle: 'DC_SUFFIX' | 'PAREN_SIGN' | 'TRAILING_MINUS' | 'LEADING_SIGN' | 'DUAL_COLUMNS' | 'BALANCE_INFERRED';
  columns: LearnedColumns;
  creditKeywords: string[];
  debitKeywords: string[];
  ignoredPatterns: string[];
  historyReplacements: HistoryReplacementRule[];
  swapDebitCreditColumns?: boolean;
  timesSeen: number;
  totalTransactions: number;
  accuracyScore: number;
  createdAt: string;
  updatedAt: string;
}

export interface LearningEvent {
  id: string;
  timestamp: string;
  modelName: string;
  kind: 'new-model' | 'matched-model' | 'learned-sign' | 'learned-ignore' | 'learned-clean' | 'auto-reconcile' | 'ai-assist';
  detail: string;
}

export interface AiProviderConfig {
  provider: 'gemini' | 'openai' | 'openrouter';
  apiKey: string;
  model: string;
}

export interface ParseFileOptions {
  onPage?: (current: number, total: number) => void;
  sourceId?: string;
  password?: string;
  signal?: AbortSignal;
  learnedModels?: LearnedLayoutModel[];
  aiConfig?: AiProviderConfig | null;
}

export interface ParseFileResult {
  transactions: Transaction[];
  pages: number;
  warnings: string[];
  bankName: string;
  openingBalance: number | null;
  closingBalance: number | null;
  updatedModel: LearnedLayoutModel;
  wasKnownModel: boolean;
  agentNotes: string[];
}

export interface ProcessSummary {
  processedFiles: number;
  totalFiles: number;
  extracted: number;
  duplicatesRemoved: number;
  attention: number;
  errors: number;
}

export interface DayReconciliation {
  date: string;
  openingBalance: number | null;
  credits: number;
  debits: number;
  netChange: number;
  expectedClosing: number | null;
  reportedClosing: number | null;
  delta: number | null;
  reconciled: boolean | null;
  lastTransactionId: string;
  count: number;
}

export interface ReconciliationSummary {
  days: DayReconciliation[];
  inferredOpeningBalance: number | null;
  calculatedClosingBalance: number | null;
  reportedClosingBalance: number | null;
  totalDelta: number | null;
  divergentDaysCount: number;
  checkedDaysCount: number;
  rowCalculatedBalance: Record<string, number | null>;
  endOfDayRowIds: Set<string>;
  divergentRowIds: Set<string>;
  dayDeltaByRowId: Record<string, number>;
}

export interface AutoRepairFix {
  transactionId: string;
  action: 'invert-sign' | 'remove-noise';
  date: string;
  history: string;
  oldAmount: number;
  newAmount: number;
  reason: string;
}

export type ExportLayout = 'contabil' | 'completo';
export type ExportScope = 'all' | 'filtered';
