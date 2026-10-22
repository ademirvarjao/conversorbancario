export type FileState = 'ready' | 'processing' | 'done' | 'error';

export interface ImportedFile {
  id: string;
  file: File;
  state: FileState;
  transactions: number;
  pages?: number;
  error?: string;
}

export interface Transaction {
  id: string;
  date: string;
  document: string;
  history: string;
  amount: number;
  debit: number;
  credit: number;
  balance: number | null;
  sourceId: string;
  sourceFile: string;
  sourcePage: number;
  confidence: number;
  warnings: string[];
}

export interface ParseFileResult {
  transactions: Transaction[];
  pages: number;
  warnings: string[];
}

export interface ProcessSummary {
  processedFiles: number;
  totalFiles: number;
  extracted: number;
  duplicates: number;
  attention: number;
  errors: number;
}
