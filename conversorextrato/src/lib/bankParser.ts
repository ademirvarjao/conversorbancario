import * as pdfjsLib from 'pdfjs-dist';
import { createWorker } from 'tesseract.js';
import type { ParseFileResult, Transaction } from '../types';

type TextChunk = {
  text: string;
  x: number;
  y: number;
  width: number;
};

type PdfLine = {
  text: string;
  y: number;
  chunks: TextChunk[];
};

type ValueToken = {
  raw: string;
  value: number;
  currency: boolean;
  negative: boolean;
};

type WorkingRecord = {
  line: PdfLine;
  continuations: PdfLine[];
};

type DateColumn = {
  x: number;
  label: string;
};

type ColumnHints = {
  dates: DateColumn[];
  amountX?: number;
  balanceX?: number;
  splitDateLayout: boolean;
};

const DATE_PATTERN = /(?<!\d)(\d{2}[/.\-]\d{2}[/.\-]\d{2,4}|\d{4}[/.\-]\d{2}[/.\-]\d{2})(?!\d)/g;
const MONEY_PATTERN = /(?<![\d.])(?:[-−–]\s*)?(?:R\$|BRL|\$)?\s*\(?\s*(?:\d{1,3}(?:[.\s]\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+[,\.]\d{2})\s*\)?(?:\s*(?:CR|DR|C|D))?(?![\d.])/gi;
const HEADER_PATTERN = /(data\s*(?:de)?|lan[çc]amento|movimento|documento|hist[oó]rico|descri[çc][aã]o|valor(?:\s*\(.*\))?|saldo|extrato|ag[eê]ncia|conta(?:\s*corrente)?|cnpj|cpf|emitido\s*em|p[aá]gina|per[ií]odo|lan[çc]amentos\s+de|nome\s+do\s+cliente|banco\s+do\s+brasil|caixa\s+econ[oô]mica)/i;
const FOOTER_PATTERN = /^(?:p[aá]g(?:ina)?\.?\s*\d+(?:\s*(?:de|\/)\s*\d+)?|sac\s+|ouvidoria|central\s+de\s+atendimento|autentica[çc][aã]o\s+digital)/i;
const DEBIT_PATTERN = /\b(?:deb(?:ito)?|d[eé]b(?:ito)?|pix\s+enviado|transfer[eê]ncia\s+enviada|saque)\b/i;

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

function normalizeHistoryParts(parts: string[]): string {
  const seen = new Set<string>();
  return parts
    .map((part) => normalizeSpaces(part)
      .replace(/about:blank/gi, '')
      .replace(/\b(?:p[aá]gina|page)\s*\d+(?:\s*(?:de|of|\/)\s*\d+)?\b/gi, '')
      .trim())
    .filter((part) => part.length > 0)
    .filter((part) => {
      const key = part.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function readDate(raw: string): string | null {
  const numeric = raw.replace(/[-.]/g, '/');
  const parts = numeric.split('/');

  if (parts.length !== 3) return null;
  let year: number;
  let month: number;
  let day: number;

  if (parts[0].length === 4) {
    [year, month, day] = parts.map(Number);
  } else {
    [day, month, year] = parts.map(Number);
    if (year < 100) year += 2000;
  }

  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function getDateMatches(text: string): Array<{ raw: string; index: number; date: string }> {
  return Array.from(text.matchAll(DATE_PATTERN)).flatMap((match) => {
    const date = readDate(match[1]);
    return date && match.index !== undefined ? [{ raw: match[1], index: match.index, date }] : [];
  });
}

function dateCandidatesAtPosition(line: PdfLine): Array<{ date: string; x: number }> {
  const candidates = line.chunks.flatMap((chunk) => {
    const match = Array.from(chunk.text.matchAll(DATE_PATTERN))[0];
    const date = match?.[1] ? readDate(match[1]) : null;
    return date ? [{ date, x: chunk.x }] : [];
  });
  if (candidates.length > 0) return candidates;
  return getDateMatches(line.text).map((match, index) => ({ date: match.date, x: index * 100 }));
}

function parseMonetaryValue(raw: string): ValueToken | null {
  const compact = raw.replace(/\s+/g, ' ').trim();
  const negative = /^[-−–]/.test(compact) || /^\(/.test(compact) || /\)$/.test(compact) || /\b(?:D|DR)\s*$/i.test(compact);
  const numberText = compact
    .replace(/[-−–()R$BRL\s]/gi, '')
    .replace(/\b(?:CR|DR|C|D)\s*$/i, '');

  if (!numberText || !/[,.]\d{2}$/.test(numberText)) return null;
  let normalized: string;
  if (numberText.includes(',') && numberText.includes('.')) {
    normalized = numberText.lastIndexOf(',') > numberText.lastIndexOf('.')
      ? numberText.replace(/\./g, '').replace(',', '.')
      : numberText.replace(/,/g, '');
  } else if (numberText.includes(',')) {
    normalized = numberText.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = numberText.replace(/,/g, '');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return {
    raw: compact,
    value: negative ? -Math.abs(parsed) : Math.abs(parsed),
    currency: /R\$|BRL|\$/i.test(compact),
    negative,
  };
}

function moneyTokens(text: string): ValueToken[] {
  return Array.from(text.matchAll(MONEY_PATTERN))
    .map((match) => parseMonetaryValue(match[0]))
    .filter((value): value is ValueToken => value !== null);
}

function valuesAtPosition(lines: PdfLine[]): Array<ValueToken & { x: number }> {
  return lines.flatMap((line) => line.chunks.flatMap((chunk) => {
    const value = parseMonetaryValue(chunk.text);
    return value ? [{ ...value, x: chunk.x }] : [];
  }));
}

function makeLines(items: unknown[]): PdfLine[] {
  const chunks: TextChunk[] = [];
  for (const item of items) {
    const candidate = item as { str?: string; transform?: number[]; width?: number };
    if (!candidate.str?.trim() || !candidate.transform) continue;
    chunks.push({
      text: candidate.str,
      x: candidate.transform[4],
      y: candidate.transform[5],
      width: candidate.width ?? 0,
    });
  }

  const groups: TextChunk[][] = [];
  for (const chunk of chunks.sort((a, b) => b.y - a.y || a.x - b.x)) {
    const group = groups.find((candidate) => Math.abs(candidate[0].y - chunk.y) <= 2.8);
    if (group) group.push(chunk);
    else groups.push([chunk]);
  }

  return groups
    .map((group) => {
      const sorted = group.sort((a, b) => a.x - b.x);
      const text = normalizeSpaces(sorted.map((chunk) => chunk.text).join(' '));
      return { text, y: sorted[0].y, chunks: sorted };
    })
    .filter((line) => line.text.length > 0)
    .sort((a, b) => b.y - a.y);
}

function makeOcrLines(text: string): PdfLine[] {
  return text.split(/\r?\n/)
    .map((value) => normalizeSpaces(value))
    .filter(Boolean)
    .map((value, index) => ({
      text: value,
      y: -index,
      chunks: [{ text: value, x: 0, y: -index, width: 0 }],
    }));
}

async function readPageWithOcr(page: pdfjsLib.PDFPageProxy): Promise<PdfLine[]> {
  const viewport = page.getViewport({ scale: 2 });
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) return [];
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  const worker = await createWorker('por');
  try {
    const result = await worker.recognize(canvas);
    return makeOcrLines(result.data.text);
  } finally {
    await worker.terminate();
  }
}

function inferColumns(lines: PdfLine[]): ColumnHints {
  const dates: DateColumn[] = [];
  const labels: Array<{ x: number; label: string }> = [];
  let amountX: number | undefined;
  let balanceX: number | undefined;

  for (const line of lines.slice(0, 18)) {
    for (const chunk of line.chunks) {
      const label = chunk.text.toLocaleLowerCase('pt-BR');
      if (/^data(?:\s+de)?$/i.test(chunk.text) || /data\s+(?:de\s+)?(?:lan[çc]|movimento|vencimento|transa)/i.test(chunk.text)) {
        dates.push({ x: chunk.x, label: label });
      }
      if (/(lan[çc]amento|movimento|compet[eê]ncia|efetiva[çc]|vencimento|transa[çc])/i.test(label)) {
        labels.push({ x: chunk.x, label });
      }
      if (/^valor$/i.test(label)) amountX = chunk.x;
      if (/^saldo$/i.test(label)) balanceX = chunk.x;
    }
  }

  const enrichedDates = dates.map((date) => {
    const nearest = labels.reduce<{ x: number; label: string } | null>((selected, item) => {
      if (!selected || Math.abs(item.x - date.x) < Math.abs(selected.x - date.x)) return item;
      return selected;
    }, null);
    return { ...date, label: `${date.label} ${nearest?.label ?? ''}` };
  });
  return { dates: enrichedDates, amountX, balanceX, splitDateLayout: lines.some((line) => /data\s+efetiva/i.test(line.text)) };
}

function selectedDate(line: PdfLine, hints: ColumnHints): string | null {
  const candidates = dateCandidatesAtPosition(line);
  if (!candidates.length) return null;
  const ranked = candidates.map((candidate) => {
    const nearest = hints.dates.reduce<DateColumn | null>((selected, column) => {
      if (!selected || Math.abs(column.x - candidate.x) < Math.abs(selected.x - candidate.x)) return column;
      return selected;
    }, null);
    const label = nearest?.label ?? '';
    let score = nearest ? Math.max(0, 12 - Math.abs((nearest?.x ?? candidate.x) - candidate.x) / 8) : 1;
    if (/movimento|efetiva|transa/.test(label)) score += 5;
    if (/lan[çc]amento|compet/.test(label)) score += 4;
    if (/vencimento/.test(label)) score -= 7;
    return { ...candidate, score };
  });
  ranked.sort((first, second) => second.score - first.score || first.x - second.x);
  return ranked[0].date;
}

function isNoise(line: PdfLine): boolean {
  const value = line.text;
  if (!value || FOOTER_PATTERN.test(value)) return true;
  if (/about:blank|^(?:p[aá]gina|page)\s*\d+(?:\s*(?:de|of|\/)\s*\d+)?$/i.test(value.trim())) return true;
  const noDates = getDateMatches(value).length === 0;
  const noMoney = moneyTokens(value).length === 0;
  if (noDates && noMoney && HEADER_PATTERN.test(value)) return true;
  return /(?:lan[çc]amentos\s+de|extrato\s+(?:banc[aá]rio|da\s+conta)?|emitido\s+em|saldo\s+(?:inicial|anterior|final)|per[ií]odo\s+(?:de|da))/i.test(value);
}

function looksLikeStart(line: PdfLine): boolean {
  return getDateMatches(line.text).length > 0 && moneyTokens(line.text).length > 0;
}

function isDateAnchor(line: PdfLine): boolean {
  return /^\d{2}[/.-]\d{2}[/.-]\d{4}$/.test(line.text.trim()) && line.chunks[0]?.x < 100;
}

function isEffectiveDateLine(text: string): boolean {
  return /^\d{2}[/.-]\d{2}\s+\d{2}:\d{2}$/.test(text.trim());
}

function isTrackingCode(text: string): boolean {
  if (/R\$|BRL|\$/.test(text)) return false;
  const compact = text.replace(/\s+/g, '');
  return compact.length >= 18 && /[A-Za-z]/.test(compact) && /\d/.test(compact);
}

function nearestValue(values: Array<ValueToken & { x: number }>, x: number | undefined): ValueToken | undefined {
  if (x === undefined || values.length === 0) return undefined;
  return values.reduce<(ValueToken & { x: number }) | undefined>((selected, value) => {
    if (!selected || Math.abs(value.x - x) < Math.abs(selected.x - x)) return value;
    return selected;
  }, undefined);
}

function structuredDescription(line: PdfLine, hints: ColumnHints): { description: string; document: string } {
  const visible = line.chunks
    .filter((chunk) => hints.amountX === undefined || chunk.x < hints.amountX - 20)
    .map((chunk) => chunk.text)
    .join(' ')
    .replace(DATE_PATTERN, ' ');
  const beforeValue = normalizeSpaces(visible);
  const documentMatch = beforeValue.match(/^(?:(?:doc(?:umento)?\s*[:#-]?\s*)?)(\d{1,20})(?=\s|$)/i);
  return {
    description: normalizeSpaces(documentMatch ? beforeValue.slice(documentMatch[0].length) : beforeValue),
    document: documentMatch?.[1] ?? '',
  };
}

function isPureValueFragment(line: PdfLine): boolean {
  const compact = line.text.replace(/[R$BRL\s\-−–().,\d]/gi, '');
  return compact.length === 0 && (moneyTokens(line.text).length > 0 || /^[-−–]$/.test(line.text.trim()));
}

function stripDateAndNumbers(line: PdfLine): { description: string; document: string } {
  const values = Array.from(line.text.matchAll(MONEY_PATTERN));
  const cutoff = values[0]?.index ?? line.text.length;
  let beforeValue = line.text.slice(0, cutoff);
  beforeValue = beforeValue.replace(DATE_PATTERN, ' ');
  beforeValue = normalizeSpaces(beforeValue);

  const documentMatch = beforeValue.match(/^(?:(?:doc(?:umento)?\s*[:#-]?\s*)?)(\d{1,20})(?=\s|$)/i);
  const document = documentMatch?.[1] ?? '';
  if (documentMatch) beforeValue = beforeValue.slice(documentMatch[0].length);

  return { description: normalizeSpaces(beforeValue), document };
}

function hasSaldoDia(description: string): boolean {
  return /^(?:saldo\s+(?:do\s+)?dia|saldo\s+anterior|saldo\s+final)$/i.test(description);
}

function lineDistance(first: PdfLine, second: PdfLine): number {
  return Math.abs(first.y - second.y);
}

function parseRecord(
  record: WorkingRecord,
  fileName: string,
  sourceId: string,
  page: number,
  index: number,
  hints: ColumnHints,
): Transaction | null {
  const date = selectedDate(record.line, hints) ?? selectedDate(record.continuations.find((line) => getDateMatches(line.text).length > 0) ?? record.line, hints);
  if (!date) return null;

  const detailLines = [record.line, ...record.continuations];
  const mainValues = moneyTokens(record.line.text);
  const continuationText = record.continuations.map((item) => item.text).join(' ');
  const fragmentValues = moneyTokens(continuationText);
  const allValues = [...mainValues, ...fragmentValues];
  if (allValues.length === 0) return null;

  let amountToken: ValueToken;
  let balanceToken: ValueToken | undefined;
  const positionedValues = valuesAtPosition(detailLines);
  const splitLayout = hints.splitDateLayout || isDateAnchor(record.line);
  const structuredHints = splitLayout
    ? { ...hints, amountX: hints.amountX ?? 500, balanceX: hints.balanceX ?? 700 }
    : hints;
  const positionedAmount = nearestValue(positionedValues, structuredHints.amountX);
  const positionedBalance = nearestValue(positionedValues, structuredHints.balanceX);
  if (splitLayout && positionedAmount && positionedAmount !== positionedBalance) {
    amountToken = positionedAmount;
    balanceToken = positionedBalance ?? (allValues.length > 1 ? allValues[allValues.length - 1] : undefined);
  } else if (mainValues.length === 1 && mainValues[0].currency && fragmentValues.length > 0) {
    amountToken = fragmentValues[0];
    balanceToken = mainValues[0];
  } else {
    amountToken = allValues[0];
    balanceToken = allValues.length > 1 ? allValues[allValues.length - 1] : undefined;
  }

  let document = '';
  const descriptions = detailLines
    .filter((line) => !isPureValueFragment(line) && !isEffectiveDateLine(line.text) && !isTrackingCode(line.text))
    .map((line) => {
      const parsed = splitLayout ? structuredDescription(line, structuredHints) : stripDateAndNumbers(line);
      if (!document && parsed.document) document = parsed.document;
      return parsed.description;
    })
    .filter((text) => !HEADER_PATTERN.test(text) && !isNoise({ text, y: 0, chunks: [] }));
  const history = normalizeHistoryParts(descriptions);
  if (!history || hasSaldoDia(history)) return null;

  const separateMinus = record.continuations.some((line) => /^[-−–]$/.test(line.text.trim()));
  const amount = (!amountToken.negative && (separateMinus || DEBIT_PATTERN.test(history)))
    ? -Math.abs(amountToken.value)
    : amountToken.value;

  const warnings: string[] = [];
  let confidence = 0.98;
  if (!document) {
    confidence -= 0.04;
  }
  if (history.length < 4) {
    warnings.push('Histórico muito curto; confirme este lançamento.');
    confidence -= 0.25;
  }
  if (record.continuations.some((line) => lineDistance(line, record.line) > 55)) {
    warnings.push('Histórico unido de linhas distantes; confira a descrição.');
    confidence -= 0.2;
  }

  return {
    id: `${sourceId}-${page}-${index}-${date}-${amount}-${history}`,
    date,
    document,
    history,
    amount,
    debit: amount < 0 ? Math.abs(amount) : 0,
    credit: amount > 0 ? amount : 0,
    balance: balanceToken?.value ?? null,
    sourceId,
    sourceFile: fileName,
    sourcePage: page,
    confidence: Math.max(0.35, Math.min(0.99, confidence)),
    warnings,
  };
}

function recordsFromLines(lines: PdfLine[]): WorkingRecord[] {
  const records: WorkingRecord[] = [];
  let current: WorkingRecord | null = null;
  let pending: PdfLine[] = [];

  const attachPending = (next: WorkingRecord | null) => {
    if (!current || pending.length === 0) {
      if (next) next.continuations.push(...pending.filter((line) => lineDistance(line, next.line) <= 40));
      pending = [];
      return;
    }
    if (!next) {
      current.continuations.push(...pending);
      pending = [];
      return;
    }
    const midpoint = (current.line.y + next.line.y) / 2;
    for (const line of pending) {
      if (line.y > midpoint) current.continuations.push(line);
      else next.continuations.push(line);
    }
    pending = [];
  };

  for (const line of lines) {
    if (isNoise(line)) continue;
    if (looksLikeStart(line)) {
      const next: WorkingRecord = { line, continuations: [] };
      attachPending(next);
      records.push(next);
      current = next;
      continue;
    }
    if (isDateAnchor(line)) {
      const next: WorkingRecord = { line, continuations: [] };
      attachPending(next);
      records.push(next);
      current = next;
      continue;
    }
    pending.push(line);
  }
  attachPending(null);
  return records;
}

export async function parseBankStatement(
  file: File,
  onPage?: (current: number, total: number) => void,
  sourceId = file.name,
): Promise<ParseFileResult> {
  const data = new Uint8Array(await file.arrayBuffer());
  const document = await pdfjsLib.getDocument({ data }).promise;
  const transactions: Transaction[] = [];
  const warnings: string[] = [];

  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    onPage?.(pageNumber, document.numPages);
    const page = await document.getPage(pageNumber);
    const textContent = await page.getTextContent();
    let lines = makeLines(textContent.items);
    if (lines.length === 0) {
      warnings.push(`Página ${pageNumber} processada por OCR local.`);
      lines = await readPageWithOcr(page);
    }
    const hints = inferColumns(lines);
    const records = recordsFromLines(lines);
    const pageTransactions = records
      .map((record, index) => parseRecord(record, file.name, sourceId, pageNumber, index, hints))
      .filter((transaction): transaction is Transaction => transaction !== null);
    transactions.push(...pageTransactions);
  }

  if (transactions.length === 0) {
    warnings.push('Nenhum lançamento estruturado foi localizado. O PDF pode ser imagem digitalizada, protegido ou ter um layout que precisa de conferência manual.');
  }

  return { transactions, pages: document.numPages, warnings };
}

export function humanDate(date: string): string {
  return formatDate(date);
}

export function amountLabel(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
