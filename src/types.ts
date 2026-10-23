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
  category: string;
  accountCode: string;
  amount: number;
  debit: number;
  credit: number;
  balance: number | null;
  sourceId: string;
  sourceFile: string;
  sourceBank?: string;
  sourcePage: number;
  occurrenceInSource?: number;
  confidence: number;
  warnings: string[];
  isDuplicate?: boolean;
}

export interface CategoryRule {
  id: string;
  keyword: string;
  category: string;
  accountCode: string;
  replaceHistory?: string;
}

export interface ParseFileOptions {
  onPage?: (current: number, total: number) => void;
  sourceId?: string;
  password?: string;
  signal?: AbortSignal;
}

export interface ParseFileResult {
  transactions: Transaction[];
  pages: number;
  warnings: string[];
  bankName: string;
  openingBalance: number | null;
  closingBalance: number | null;
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

export type ExportLayout = 'contabil' | 'completo';
export type ExportScope = 'all' | 'filtered';
