import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker, type Worker as TesseractWorker } from 'tesseract.js';
import * as XLSX from 'xlsx';
import type {
  AiProviderConfig,
  FileFormat,
  LearnedColumns,
  LearnedLayoutModel,
  ParseFileOptions,
  ParseFileResult,
  Transaction,
} from '../types';
import {
  blendColumns,
  computeLayoutFingerprint,
  diagnoseAndSolveDivergences,
  extractReusablePatternStem,
  findMatchingLayoutModel,
  normalizeHeaderTokens,
  queryExternalAiForRawLines,
} from './layoutAgent';
import { computeReconciliation } from './reconciliation';

export class PasswordRequiredError extends Error {
  readonly incorrectPassword: boolean;

  constructor(incorrect = false) {
    super(
      incorrect
        ? 'Senha incorreta para este PDF. Verifique os dígitos (ex.: CPF/CNPJ) e tente novamente.'
        : 'Este PDF é protegido por senha. Informe a senha do extrato para desbloquear localmente.',
    );
    this.name = 'PasswordRequiredError';
    this.incorrectPassword = incorrect;
  }
}

type SignHint = 'debit' | 'credit' | 'none';

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
  absValue: number;
  currency: boolean;
  negative: boolean;
  signHint: SignHint;
};

type WorkingRecord = {
  line: PdfLine;
  continuations: PdfLine[];
  inheritedDate?: string;
};

type DateColumn = {
  x: number;
  label: string;
};

type ColumnHints = {
  dates: DateColumn[];
  docX?: number;
  amountX?: number;
  debitX?: number;
  creditX?: number;
  balanceX?: number;
  splitDateLayout: boolean;
};

type StatementPeriod = {
  defaultYear: number;
  yearByMonth: Map<number, number>;
};

type SectionParserState = {
  inExcludedSection: boolean;
  activeDate: string | null;
};

const PT_MONTHS: Record<string, number> = {
  jan: 1,
  janeiro: 1,
  fev: 2,
  fevereiro: 2,
  mar: 3,
  marco: 3,
  março: 3,
  abr: 4,
  abril: 4,
  mai: 5,
  maio: 5,
  jun: 6,
  junho: 6,
  jul: 7,
  julho: 7,
  ago: 8,
  agosto: 8,
  set: 9,
  setembro: 9,
  out: 10,
  outubro: 10,
  nov: 11,
  novembro: 11,
  dez: 12,
  dezembro: 12,
};

const FULL_DATE_PATTERN = /(?<!\d)(\d{2}[/.\-]\d{2}[/.\-]\d{2,4}|\d{4}[/.\-]\d{2}[/.\-]\d{2})(?!\d)/g;
const WRITTEN_DATE_LINE_PATTERN = /^(\d{1,2})\s+(?:de\s+)?([a-zç]{3,9})\.?(?:\s+(?:de\s+)?(\d{2,4}))?$/i;
const WRITTEN_DATE_LEADING_PATTERN =
  /^(\d{1,2})\s+(?:de\s+)?(jan(?:eiro)?|fev(?:ereiro)?|mar(?:[çc]o)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\.?(?:\s+(?:de\s+)?(\d{2,4}))?(?=\s|$)/i;
const SHORT_DATE_LEADING_PATTERN = /^(\d{2})[/.\-](\d{2})(?=\s|$)/;

const MONEY_PATTERN =
  /(?<![\d.,A-Za-z])(?:[+]|[-−–]\s*)?(?:R\$|BRL|\$)?\s*\(?\s*(?:\d{1,3}(?:[.\s]\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d+[,\.]\d{2})\s*\)?(?:[-−–]|\s*\([+-]\)|\s*(?:CR|DR|C|D)(?![A-Za-z]))?(?![\d.,])/gi;

const HEADER_PATTERN =
  /(data\s*(?:de)?|lan[çc]amento|movimento|documento|docto\.?|hist[oó]rico|descri[çc][aã]o|valor(?:\s*\(.*\))?|saldo|extrato|ag[eê]ncia|conta(?:\s*corrente)?|cnpj|cpf|emitido\s*em|p[aá]gina|per[ií]odo|lan[çc]amentos\s+de|nome\s+do\s+cliente|banco\s+do\s+brasil|caixa\s+econ[oô]mica|ita[uú]\s+unibanco|bradesco|santander|nubank|nu\s+pagamentos)/i;

const FOOTER_PATTERN =
  /^(?:p[aá]g(?:ina)?\.?\s*\d+(?:\s*(?:de|\/)\s*\d+)?|sac\s+|ouvidoria|central\s+de\s+atendimento|atendimento\s+empresarial|autentica[çc][aã]o\s+(?:digital|banc[aá]ria|eletr[oô]nica)|os\s+dados\s+acima\s+t[eê]m\s+como\s+base|este\s+documento\s+[eé]\s+para\s+simples\s+confer[eê]ncia)/i;

/**
 * Headings that immediately terminate reading of the realized transactions table
 * (balance composition boxes, position summaries, limits, future/scheduled entries, fee packages).
 */
const SECTION_STOP_PATTERN = new RegExp(
  [
    '^(?:saldos?|resumo)$',
    '^resumo\\s+(?:financeiro|do\\s+per[ií]odo|do\\s+m[eê]s|da\\s+conta|de\\s+movimenta[çc][aã]o|consolidado)\\b',
    '^composi[çc][aã]o\\s+(?:do\\s+|de\\s+)?saldos?\\b',
    '^demonstrativo\\s+(?:de\\s+saldos?|de\\s+encargos|de\\s+utiliza[çc][aã]o|financeiro|de\\s+pacote)\\b',
    '^quadro\\s+(?:de\\s+saldos?|resumo|de\\s+limites?|demonstrativo)\\b',
    '^posi[çc][aã]o\\s+(?:em\\s*:?\\s*\\d{2}[/.\\-]\\d{2}[/.\\-]\\d{2,4}|consolidada|de\\s+saldos?|atual)\\b',
    'entenda\\s+a\\s+composi[çc][aã]o\\s+do\\s+(?:seu\\s+)?saldo',
    '^lan[çc]amentos?\\s+(?:futuros?|agendados?|provisionados?|a\\s+vencer|pendentes?)\\b',
    '^movimenta[çc][oõ]es?\\s+futuras?\\b',
    '^(?:agendamentos?|d[eé]bitos?\\s+agendados?)\\b',
    '^valores?\\s+(?:bloqueados?|a\\s+liberar)\\b',
    '^extrato\\s+de\\s+(?:investimentos?|aplica[çc][oõ]es?)\\b',
    '^(?:limites?\\s+de\\s+cr[eé]dito|pacote\\s+de\\s+servi[çc]os|encargos\\s+financeiros|custo\\s+efetivo\\s+total|informa[çc][oõ]es?\\s+(?:adicionais|importantes|ao\\s+cliente)|notas?\\s+explicativas?)\\b',
  ].join('|'),
  'i',
);

/**
 * Summary / balance-composition / limit / accrual rows that are NEVER accounting journal entries
 * even if encountered outside a detected section header.
 */
const SUMMARY_OR_NON_TX_LINE_PATTERN = new RegExp(
  [
    // Lettered balance composition schedule rows: "A – Saldo de Conta Corrente", "C – Provisão...", "H – Limite...", "J - Saldo..."
    '^[A-Z]\\s*[-\\u00AD\\u2010-\\u2015\\u2212.)]+\\s+(?:saldo|provis[aã]o|limite|juros|iof|encargos|aplic|invest|total|cr[eé]dito|d[eé]bito|cheque|desbloqueio)',
    // Algebraic formula references at end of composition lines: "(A-B)", "(E+F)", "(G + H + I)"
    '\\([A-Z](?:\\s*[+-]\\s*[A-Z])+\\)(?:\\s+[R$BRL0-9.,()+-\\u2013\\u2212]+)?$',
    // Unblocking schedule breakdown rows: "Desbloqueio em 1 dia", "Desbloqueio em mais de 2 dias"
    '^desbloqueio\\s+em\\s+(?:mais\\s+de\\s+)?\\d+\\s+dias?\\b',
    // Provisions & accrued-to-date informational rows (distinct from real dated IOF/Juros charges)
    '\\bprovis[aã]o\\s+de\\s+(?:encargos|juros|iof|seguro|tarifas?)\\b',
    '\\b(?:juros|iof|encargos|rendimentos?)\\s+acumulados?\\s+at[eé]\\s+a\\s+data\\b',
    // Credit / overdraft limit rows: "Limite Cheque Empresa", "Limite Disponível", "Limite Utilizado"
    '^(?:[A-Z]\\s*[-\\u00AD\\u2010-\\u2015\\u2212.)]+\\s*)?limite\\s+(?:cheque|especial|dispon[ií]vel|utilizado|contratado|de\\s+cr[eé]dito|total|empresa|investidor|rotativo|pr[eé][- ]?aprovado)\\b',
    // Balance summary rows (all variants across Santander, Itaú, Bradesco, BB, Caixa, Sicredi, Inter, Nubank)
    '^(?:[A-Z]\\s*[-\\u00AD\\u2010-\\u2015\\u2212.)]+\\s*)?saldo\\s+(?:anterior|inicial|final|atual|do\\s+dia|parcial|total|consolidado|l[ií]quido|em\\s+conta|de\\s+conta(?:\\s+corrente)?|dispon[ií]vel|bloqueado|provis[oó]rio|vinculado|de\\s+investimentos?|de\\s+aplica[çc][oõ]es?|aplicado|investido)\\b',
    '^s\\s*a\\s*l\\s*d\\s*o(?:\\s+(?:anterior|do\\s+dia|final|atual|dispon[ií]vel))?\\b',
    // Period / section totals
    '^total\\s+(?:de\\s+)?(?:cr[eé]ditos?|d[eé]bitos?|entradas?|sa[ií]das?|movimenta[çc][oõ]es?|lan[çc]amentos?|do\\s+m[eê]s|do\\s+per[ií]odo|geral|dispon[ií]vel)\\b',
    // Position / composition captions
    '^posi[çc][aã]o\\s+em\\s*:',
    'entenda\\s+a\\s+composi[çc][aã]o\\s+do\\s+(?:seu\\s+)?saldo',
  ].join('|'),
  'i',
);

const CREDIT_PATTERN =
  /\b(?:estorno|cr[eé]d(?:ito)?|pix\s+receb(?:ido)?|transf(?:er[eê]ncia)?\s+receb(?:ida)?|ted\s+receb(?:ida)?|doc\s+receb(?:ido)?|dep[oó]sito|desbloq(?:ueio\s+judicial|\s+valor)?|resgate|rendimento|recebimento|remunera[çc][aã]o|reembolso|devolu[çc][aã]o|liq(?:uida[çc][aã]o)?\s+cobran[çc]a)\b/i;

const DEBIT_PATTERN =
  /\b(?:deb(?:ito)?|d[eé]b(?:ito)?|pix\s+enviado|transf(?:er[eê]ncia)?\s+enviada|ted\s+enviada|doc\s+enviado|saque|pag(?:amento|to)|boleto|tarifa|tar\s+|iof\b|juros\b|encargo|compra|darf|das\b|fgts|gps\b|inss|aplica[çc][aã]o|sispag|folha\s+pag)\b/i;

const OPENING_BALANCE_PATTERN =
  /\b(?:saldo\s+(?:anterior|inicial)|s\s*a\s*l\s*d\s*o\s+anterior)\b/i;

const BANK_MATCHERS: Array<{ pattern: RegExp; name: string }> = [
  { pattern: /\bcaixa\s+econ[oô]mica|\bcef\b|\bcaixa\b.*extrato|0104\b/i, name: 'Caixa Econômica Federal' },
  { pattern: /\bbanco\s+do\s+brasil|\bbb\.com\.br|sisbb/i, name: 'Banco do Brasil' },
  { pattern: /\bita[uú](?:\s+unibanco|\s+empresas)?\b/i, name: 'Itaú Unibanco' },
  { pattern: /\bbradesco\b/i, name: 'Bradesco' },
  { pattern: /\bsantander\b/i, name: 'Santander' },
  { pattern: /\bnubank\b|\bnu\s+pagamentos\b/i, name: 'Nubank' },
  { pattern: /\bbanco\s+inter\b|\binter\.co\b/i, name: 'Banco Inter' },
  { pattern: /\bsicoob\b|\bbancoob\b/i, name: 'Sicoob' },
  { pattern: /\bsicredi\b/i, name: 'Sicredi' },
  { pattern: /\bc6\s*bank\b/i, name: 'C6 Bank' },
  { pattern: /\bcora\s+(?:scd|sociedade|banco)?\b/i, name: 'Cora' },
  { pattern: /\bbtg\s*pactual\b/i, name: 'BTG Pactual' },
  { pattern: /\bbanco\s+safra\b/i, name: 'Banco Safra' },
  { pattern: /\bbanrisul\b/i, name: 'Banrisul' },
  { pattern: /\bmercado\s*pago\b/i, name: 'Mercado Pago' },
  { pattern: /\bpagbank\b|\bpagseguro\b/i, name: 'PagBank' },
];

export function detectFileFormat(file: File): FileFormat {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx')) return 'ofx';
  if (lower.endsWith('.csv') || lower.endsWith('.txt')) return 'csv';
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return 'xlsx';
  return 'pdf';
}

export function detectBankName(text: string): string {
  for (const matcher of BANK_MATCHERS) {
    if (matcher.pattern.test(text)) return matcher.name;
  }
  return 'Extrato Bancário';
}

function normalizeSpaces(value: string): string {
  return value.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').trim();
}

function normalizeHistoryParts(parts: string[]): string {
  const seen = new Set<string>();
  return parts
    .map((part) =>
      normalizeSpaces(part)
        .replace(/about:blank/gi, '')
        .replace(/\b(?:p[aá]gina|page)\s*\d+(?:\s*(?:de|of|\/)\s*\d+)?\b/gi, '')
        .trim(),
    )
    .filter((part) => part.length > 0)
    .filter((part) => {
      const key = part.toLocaleLowerCase('pt-BR');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(' ');
}

function buildIsoDate(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

export function readDate(raw: string): string | null {
  const trimmed = raw.trim();
  const numeric = trimmed.replace(/[-.]/g, '/');
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

  return buildIsoDate(year, month, day);
}

function readShortOrWrittenDate(text: string, period: StatementPeriod): string | null {
  const clean = text.trim();
  if (isEffectiveDateLine(clean)) return null;

  const written = clean.match(WRITTEN_DATE_LEADING_PATTERN) ?? clean.match(WRITTEN_DATE_LINE_PATTERN);
  if (written) {
    const day = Number(written[1]);
    const month = PT_MONTHS[written[2].toLowerCase()];
    if (!month) return null;
    let year = written[3] ? Number(written[3]) : period.yearByMonth.get(month) ?? period.defaultYear;
    if (year < 100) year += 2000;
    return buildIsoDate(year, month, day);
  }

  const shortMatch = clean.match(SHORT_DATE_LEADING_PATTERN);
  if (shortMatch) {
    const day = Number(shortMatch[1]);
    const month = Number(shortMatch[2]);
    const year = period.yearByMonth.get(month) ?? period.defaultYear;
    return buildIsoDate(year, month, day);
  }

  return null;
}

function isSectionStopLine(text: string): boolean {
  const trimmed = normalizeSpaces(text);
  if (!trimmed) return false;
  return SECTION_STOP_PATTERN.test(trimmed);
}

/**
 * Recognizes an explicit transaction table header (e.g. "Data | Histórico | Docto. | Valor (R$) | Saldo (R$)")
 * which cleanly (re-)opens transaction reading on a new page or new account block.
 */
function isTransactionTableHeader(line: PdfLine): boolean {
  const t = line.text;
  if (moneyTokens(t).length > 0 || getDateMatches(t).length > 0) return false;
  const hasDateCol = /\bdata(?:\s+mov\.?|\s+de\s+lan[çc]amento|\s+de\s+movimento)?\b/i.test(t);
  const hasDescCol = /\b(?:hist[oó]rico|descri[çc][aã]o|lan[çc]amentos?|movimenta[çc][aã]o)\b/i.test(t);
  const hasValCol = /\b(?:valor|d[eé]bitos?|cr[eé]ditos?|sa[ií]das?|entradas?)\b/i.test(t);
  return hasDateCol && (hasDescCol || hasValCol);
}

/**
 * Pre-filters pages through the Section State Machine so summary boxes (`Saldo / Posição em / Limites / Futuros`)
 * never pollute period year inference, numeric column X-clustering, or opening balance detection.
 */
function filterActiveStatementLinesPerPage(allPagesLines: PdfLine[][]): PdfLine[][] {
  let excluded = false;
  return allPagesLines.map((pageLines) => {
    const kept: PdfLine[] = [];
    for (const line of pageLines) {
      if (isTransactionTableHeader(line)) {
        excluded = false;
        kept.push(line);
        continue;
      }
      if (isSectionStopLine(line.text)) {
        excluded = true;
        continue;
      }
      if (excluded) continue;
      if (SUMMARY_OR_NON_TX_LINE_PATTERN.test(line.text.trim()) && !OPENING_BALANCE_PATTERN.test(line.text)) {
        continue;
      }
      kept.push(line);
    }
    return kept;
  });
}

function inferStatementPeriod(allPagesLines: PdfLine[][]): StatementPeriod {
  const yearCounts = new Map<number, number>();
  const yearByMonth = new Map<number, number>();

  for (const lines of allPagesLines) {
    for (const line of lines.slice(0, 30)) {
      const isEmissionOrPosLine =
        /\bemitido\s+em\b|\bdata\s+da\s+emiss[aã]o\b|\bposi[çc][aã]o\s+em\b/i.test(line.text);
      const weight = isEmissionOrPosLine ? 1 : 4;

      for (const match of line.text.matchAll(FULL_DATE_PATTERN)) {
        const iso = readDate(match[1]);
        if (!iso) continue;
        const [y, m] = iso.split('-').map(Number);
        yearCounts.set(y, (yearCounts.get(y) ?? 0) + weight);
        if (!isEmissionOrPosLine) yearByMonth.set(m, y);
      }

      const monthYearMatch = line.text.match(
        /\b(jan(?:eiro)?|fev(?:ereiro)?|mar(?:[çc]o)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)\s*(?:\/|de\s+|\s+-\s+|\s+)(\d{4})\b/i,
      );
      if (monthYearMatch) {
        const m = PT_MONTHS[monthYearMatch[1].toLowerCase()];
        const y = Number(monthYearMatch[2]);
        if (m && y >= 1995 && y <= 2100) {
          yearCounts.set(y, (yearCounts.get(y) ?? 0) + 5);
          yearByMonth.set(m, y);
        }
      }
    }
  }

  let defaultYear = new Date().getFullYear();
  let bestScore = -1;
  for (const [year, score] of yearCounts.entries()) {
    if (score > bestScore) {
      bestScore = score;
      defaultYear = year;
    }
  }

  return { defaultYear, yearByMonth };
}

function detectDateAndSignStyles(activePagesLines: PdfLine[][]): {
  dateStyle: LearnedLayoutModel['dateStyle'];
  signStyle: LearnedLayoutModel['signStyle'];
} {
  const sampleText = activePagesLines
    .flatMap((page) => page.map((l) => l.text))
    .slice(0, 180)
    .join('\n');

  let dateStyle: LearnedLayoutModel['dateStyle'] = 'DD/MM/YYYY';
  if (/\b\d{1,2}\s+(?:jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i.test(sampleText)) {
    dateStyle = 'WRITTEN_PT';
  } else if (/^\s*\d{2}[/.-]\d{2}(?=\s)/m.test(sampleText) && !/^\s*\d{2}[/.-]\d{2}[/.-]\d{2,4}/m.test(sampleText)) {
    dateStyle = 'DD/MM';
  } else if (/^\s*\d{4}-\d{2}-\d{2}/m.test(sampleText)) {
    dateStyle = 'ISO';
  }

  let signStyle: LearnedLayoutModel['signStyle'] = 'BALANCE_INFERRED';
  if (/\d[,.]\d{2}\s+[DC]\b/.test(sampleText)) signStyle = 'DC_SUFFIX';
  else if (/\d[,.]\d{2}\s*\([+-]\)/.test(sampleText)) signStyle = 'PAREN_SIGN';
  else if (/\d[,.]\d{2}-(?:\s|$)/m.test(sampleText)) signStyle = 'TRAILING_MINUS';
  else if (/[-−–]\s*(?:R\$\s*)?\d/.test(sampleText)) signStyle = 'LEADING_SIGN';

  return { dateStyle, signStyle };
}

/**
 * Unsupervised 1D X-coordinate clustering of monetary columns exclusively within active transaction lines.
 */
function discoverNumericColumnClusters(activePagesLines: PdfLine[][]): LearnedColumns {
  const xs: number[] = [];
  for (const lines of activePagesLines) {
    for (const line of lines) {
      if (OPENING_BALANCE_PATTERN.test(line.text)) continue;
      if (SUMMARY_OR_NON_TX_LINE_PATTERN.test(line.text.trim())) continue;
      for (const chunk of line.chunks) {
        if (chunk.x > 160 && parseMonetaryValue(chunk.text)) {
          xs.push(chunk.x);
        }
      }
    }
  }
  if (xs.length < 3) return {};

  const sorted = [...xs].sort((a, b) => a - b);
  const clusters: Array<{ center: number; values: number[] }> = [];
  for (const x of sorted) {
    const hit = clusters.find((c) => Math.abs(c.center - x) <= 36);
    if (hit) {
      hit.values.push(x);
      hit.center = hit.values.reduce((s, v) => s + v, 0) / hit.values.length;
    } else {
      clusters.push({ center: x, values: [x] });
    }
  }

  const significant = clusters
    .filter((c) => c.values.length >= Math.max(2, Math.floor(xs.length * 0.1)))
    .sort((a, b) => a.center - b.center);

  if (significant.length === 1) {
    return { amountX: Math.round(significant[0].center) };
  }
  if (significant.length === 2) {
    return {
      amountX: Math.round(significant[0].center),
      balanceX: Math.round(significant[1].center),
    };
  }
  if (significant.length >= 3) {
    return {
      debitX: Math.round(significant[0].center),
      creditX: Math.round(significant[1].center),
      balanceX: Math.round(significant[significant.length - 1].center),
    };
  }
  return {};
}

function formatDate(date: string): string {
  const [year, month, day] = date.split('-');
  return `${day}/${month}/${year}`;
}

function getDateMatches(text: string): Array<{ raw: string; index: number; date: string }> {
  return Array.from(text.matchAll(FULL_DATE_PATTERN)).flatMap((match) => {
    const date = readDate(match[1]);
    return date && match.index !== undefined ? [{ raw: match[1], index: match.index, date }] : [];
  });
}

function dateCandidatesAtPosition(line: PdfLine, period: StatementPeriod): Array<{ date: string; x: number }> {
  const candidates = line.chunks.flatMap((chunk) => {
    // Only treat a date token in the left/date columns (x < 175) as a row date, avoiding dates inside free-text descriptions when X coordinates are available
    const match = Array.from(chunk.text.matchAll(FULL_DATE_PATTERN))[0];
    const date = match?.[1] ? readDate(match[1]) : null;
    if (date && (chunk.x < 175 || line.chunks.length === 1)) {
      return [{ date, x: chunk.x }];
    }
    if (chunk.x < 135) {
      const shortDate = readShortOrWrittenDate(chunk.text, period);
      if (shortDate) return [{ date: shortDate, x: chunk.x }];
    }
    return [];
  });
  if (candidates.length > 0) return candidates;

  // Fallback when chunks were merged into one line (e.g. OCR)
  const leadingFull = line.text.trim().match(/^(\d{2}[/.\-]\d{2}[/.\-]\d{2,4}|\d{4}[/.\-]\d{2}[/.\-]\d{2})(?=\s|$)/);
  if (leadingFull) {
    const iso = readDate(leadingFull[1]);
    if (iso) return [{ date: iso, x: 0 }];
  }

  const shortLeading = readShortOrWrittenDate(line.text, period);
  return shortLeading ? [{ date: shortLeading, x: 0 }] : [];
}

export function parseMonetaryValue(raw: string): ValueToken | null {
  const compact = raw.replace(/\s+/g, ' ').trim();
  const hasDebitMarker =
    /^[-−–]/.test(compact) ||
    /[-−–]$/.test(compact) ||
    /\(-\)$/.test(compact) ||
    (/^\(/.test(compact) && /\)$/.test(compact)) ||
    /\b(?:D|DR)\s*$/i.test(compact);

  const hasCreditMarker =
    /^\+/.test(compact) ||
    /\(\+\)$/.test(compact) ||
    /\b(?:C|CR)\s*$/i.test(compact);

  const signHint: SignHint = hasDebitMarker ? 'debit' : hasCreditMarker ? 'credit' : 'none';
  const negative = signHint === 'debit';

  const numberText = compact
    .replace(/\([+-]\)\s*$/g, '')
    .replace(/\b(?:CR|DR|C|D)\s*$/i, '')
    .replace(/^[+]/, '')
    .replace(/[-−–()R$BRL\s]/gi, '');

  if (!numberText || !/[,.]\d{2}$/.test(numberText)) return null;
  let normalized: string;
  if (numberText.includes(',') && numberText.includes('.')) {
    normalized =
      numberText.lastIndexOf(',') > numberText.lastIndexOf('.')
        ? numberText.replace(/\./g, '').replace(',', '.')
        : numberText.replace(/,/g, '');
  } else if (numberText.includes(',')) {
    normalized = numberText.replace(/\./g, '').replace(',', '.');
  } else {
    normalized = numberText.replace(/,/g, '');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  const absValue = Math.abs(parsed);
  return {
    raw: compact,
    value: negative ? -absValue : absValue,
    absValue,
    currency: /R\$|BRL|\$/i.test(compact),
    negative,
    signHint,
  };
}

function moneyTokens(text: string): ValueToken[] {
  return Array.from(text.matchAll(MONEY_PATTERN))
    .map((match) => parseMonetaryValue(match[0]))
    .filter((value): value is ValueToken => value !== null);
}

function valuesAtPosition(lines: PdfLine[]): Array<ValueToken & { x: number }> {
  return lines.flatMap((line) =>
    line.chunks.flatMap((chunk) => {
      const value = parseMonetaryValue(chunk.text);
      return value ? [{ ...value, x: chunk.x }] : [];
    }),
  );
}

function mergeAdjacentSignChunks(sortedChunks: TextChunk[]): TextChunk[] {
  const merged: TextChunk[] = [];
  for (let i = 0; i < sortedChunks.length; i += 1) {
    const cur = { ...sortedChunks[i] };

    if (
      /^(?:[-−–]\s*)?(?:R\$|BRL|\$)$|^[-−–]$/i.test(cur.text.trim()) &&
      i + 1 < sortedChunks.length &&
      /^\d/.test(sortedChunks[i + 1].text.trim()) &&
      sortedChunks[i + 1].x - (cur.x + cur.width) < 48
    ) {
      const next = sortedChunks[i + 1];
      cur.text = `${cur.text.trim()} ${next.text.trim()}`;
      cur.width = next.x + next.width - cur.x;
      i += 1;
    }

    if (
      /[,.]\d{2}$/.test(cur.text.trim()) &&
      i + 1 < sortedChunks.length &&
      /^(?:CR|DR|C|D|\([+-]\)|[-−–])$/i.test(sortedChunks[i + 1].text.trim()) &&
      sortedChunks[i + 1].x - (cur.x + cur.width) < 42
    ) {
      const signChunk = sortedChunks[i + 1];
      const sep = signChunk.text.trim() === '-' ? '' : ' ';
      cur.text = `${cur.text.trim()}${sep}${signChunk.text.trim()}`;
      cur.width = signChunk.x + signChunk.width - cur.x;
      i += 1;
    }

    merged.push(cur);
  }
  return merged;
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
      const sorted = mergeAdjacentSignChunks(group.sort((a, b) => a.x - b.x));
      const text = normalizeSpaces(sorted.map((chunk) => chunk.text).join(' '));
      return { text, y: sorted[0].y, chunks: sorted };
    })
    .filter((line) => line.text.length > 0)
    .sort((a, b) => b.y - a.y);
}

function makeOcrLines(text: string): PdfLine[] {
  return text
    .split(/\r?\n/)
    .map((value) => normalizeSpaces(value))
    .filter(Boolean)
    .map((value, index) => ({
      text: value,
      y: -index * 14,
      chunks: [{ text: value, x: 0, y: -index * 14, width: 0 }],
    }));
}

async function readPageWithOcr(
  page: pdfjsLib.PDFPageProxy,
  workerRef: { worker: TesseractWorker | null },
): Promise<PdfLine[]> {
  if (typeof globalThis.document === 'undefined') return [];
  const viewport = page.getViewport({ scale: 2 });
  const canvas = globalThis.document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const context = canvas.getContext('2d');
  if (!context) return [];
  await page.render({ canvas, canvasContext: context, viewport }).promise;
  if (!workerRef.worker) {
    workerRef.worker = await createWorker('por');
  }
  const result = await workerRef.worker.recognize(canvas);
  return makeOcrLines(result.data.text);
}

function inferColumns(lines: PdfLine[], learned?: LearnedColumns, swapDebitCredit = false): ColumnHints {
  const dates: DateColumn[] = [];
  const labels: Array<{ x: number; label: string }> = [];
  let docX: number | undefined;
  let amountX = learned?.amountX;
  let debitX = learned?.debitX;
  let creditX = learned?.creditX;
  let balanceX = learned?.balanceX;

  for (const line of lines.slice(0, 26)) {
    if (moneyTokens(line.text).length > 0) continue;
    for (const chunk of line.chunks) {
      const label = chunk.text.toLocaleLowerCase('pt-BR').trim();
      if (
        /^data(?:\s+de)?(?:\s+mov\.?)?$/i.test(chunk.text.trim()) ||
        /data\s+(?:de\s+)?(?:lan[çc]|movimento|vencimento|transa)/i.test(chunk.text)
      ) {
        dates.push({ x: chunk.x, label });
      }
      if (/(lan[çc]amento|movimento|compet[eê]ncia|efetiva[çc]|vencimento|transa[çc])/i.test(label)) {
        labels.push({ x: chunk.x, label });
      }
      if (/^(?:n[ºo°r.]*\s*)?doc(?:to|umento)?\.?$/i.test(label)) {
        docX = chunk.x;
      }
      if (/^valor(?:\s*\(.*\))?$/i.test(label)) amountX = chunk.x;
      if (/^(?:d[eé]bito|sa[ií]da)s?(?:\s*\(.*\))?$/i.test(label)) debitX = chunk.x;
      if (/^(?:cr[eé]dito|entrada)s?(?:\s*\(.*\))?$/i.test(label)) creditX = chunk.x;
      if (/^saldo(?:\s*\(.*\))?$/i.test(label)) balanceX = chunk.x;
    }
  }

  if (swapDebitCredit && debitX !== undefined && creditX !== undefined) {
    [debitX, creditX] = [creditX, debitX];
  }

  const enrichedDates = dates.map((date) => {
    const nearest = labels.reduce<{ x: number; label: string } | null>((selected, item) => {
      if (!selected || Math.abs(item.x - date.x) < Math.abs(selected.x - date.x)) return item;
      return selected;
    }, null);
    return { ...date, label: `${date.label} ${nearest?.label ?? ''}` };
  });

  return {
    dates: enrichedDates,
    docX,
    amountX,
    debitX,
    creditX,
    balanceX,
    splitDateLayout: lines.some((line) => /data\s+efetiva/i.test(line.text)),
  };
}

function selectedDate(line: PdfLine, hints: ColumnHints, period: StatementPeriod): string | null {
  const candidates = dateCandidatesAtPosition(line, period);
  if (!candidates.length) return null;
  const ranked = candidates.map((candidate) => {
    const nearest = hints.dates.reduce<DateColumn | null>((selected, column) => {
      if (!selected || Math.abs(column.x - candidate.x) < Math.abs(selected.x - candidate.x)) {
        return column;
      }
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

function extractOpeningBalanceFromLines(lines: PdfLine[]): number | null {
  for (const line of lines) {
    if (isSectionStopLine(line.text)) break;
    if (OPENING_BALANCE_PATTERN.test(line.text)) {
      const vals = moneyTokens(line.text);
      if (vals.length > 0) {
        return vals[vals.length - 1].value;
      }
    }
  }
  return null;
}

function isIgnoredByLearnedModel(text: string, ignoredPatterns: string[]): boolean {
  if (!ignoredPatterns.length) return false;
  const upper = text.toUpperCase();
  return ignoredPatterns.some((pat) => pat.length >= 3 && upper.includes(pat.toUpperCase()));
}

/**
 * Checks if a single-value line actually placed its ONLY number inside the `Saldo` column
 * while leaving `Valor / Débito / Crédito` completely blank (e.g. balance-only rows & summary tables).
 */
function hasOnlyBalanceColumnValue(
  positionedValues: Array<ValueToken & { x: number }>,
  hints: ColumnHints,
): boolean {
  if (positionedValues.length !== 1 || hints.balanceX === undefined) return false;
  const txCols = [hints.amountX, hints.debitX, hints.creditX].filter(
    (x): x is number => x !== undefined,
  );
  if (txCols.length === 0) return false;

  const onlyVal = positionedValues[0];
  const distToBalance = Math.abs(onlyVal.x - hints.balanceX);
  const nearestTxColDist = Math.min(...txCols.map((colX) => Math.abs(onlyVal.x - colX)));

  // If `Saldo` column is clearly distinct from `Valor` column and the single number sits on `Saldo`:
  return distToBalance <= 34 && nearestTxColDist >= distToBalance + 28;
}

function isNoise(line: PdfLine, ignoredPatterns: string[] = []): boolean {
  const value = line.text.trim();
  if (!value || FOOTER_PATTERN.test(value)) return true;
  if (isIgnoredByLearnedModel(value, ignoredPatterns)) return true;
  if (SUMMARY_OR_NON_TX_LINE_PATTERN.test(value)) return true;
  if (/about:blank|^(?:p[aá]gina|page)\s*\d+(?:\s*(?:de|of|\/)\s*\d+)?$/i.test(value)) {
    return true;
  }
  const noDates = getDateMatches(value).length === 0;
  const noMoney = moneyTokens(value).length === 0;
  if (noDates && noMoney && HEADER_PATTERN.test(value)) return true;
  return /(?:lan[çc]amentos\s+de|extrato\s+(?:banc[aá]rio|da\s+conta|mensal|por\s+per[ií]odo|conta\s+corrente)|emitido\s+em|per[ií]odo\s*(?:de|da|:))/i.test(
    value,
  );
}

function isEffectiveDateLine(text: string): boolean {
  return /^\d{2}[/.-]\d{2}\s+\d{2}:\d{2}/.test(text.trim());
}

function lineHasDate(line: PdfLine, period: StatementPeriod): boolean {
  if (isEffectiveDateLine(line.text)) return false;
  return dateCandidatesAtPosition(line, period).length > 0;
}

function looksLikeStart(line: PdfLine, period: StatementPeriod, hints: ColumnHints): boolean {
  if (!lineHasDate(line, period)) return false;
  const vals = valuesAtPosition([line]);
  if (vals.length === 0 && moneyTokens(line.text).length === 0) return false;
  if (hasOnlyBalanceColumnValue(vals, hints)) return false;
  return true;
}

function isDateAnchor(line: PdfLine, period: StatementPeriod): boolean {
  const trimmed = line.text.trim();
  if ((line.chunks[0]?.x ?? 0) >= 120) return false;
  if (/^\d{2}[/.-]\d{2}[/.-]\d{2,4}$/.test(trimmed)) return true;
  return WRITTEN_DATE_LINE_PATTERN.test(trimmed) && readShortOrWrittenDate(trimmed, period) !== null;
}

function isTrackingCode(text: string): boolean {
  if (/R\$|BRL|\$/.test(text)) return false;
  const compact = text.replace(/\s+/g, '');
  return compact.length >= 18 && /[A-Za-z]/.test(compact) && /\d/.test(compact) && !/\s/.test(text.trim());
}

function nearestValueWithin(
  values: Array<ValueToken & { x: number }>,
  x: number | undefined,
  maxDistance = 52,
): (ValueToken & { x: number }) | undefined {
  if (x === undefined || values.length === 0) return undefined;
  const best = values.reduce<(ValueToken & { x: number }) | undefined>((selected, value) => {
    if (!selected || Math.abs(value.x - x) < Math.abs(selected.x - x)) return value;
    return selected;
  }, undefined);
  return best && Math.abs(best.x - x) <= maxDistance ? best : undefined;
}

function stripLeadingDates(text: string): string {
  return text
    .replace(FULL_DATE_PATTERN, ' ')
    .replace(WRITTEN_DATE_LEADING_PATTERN, ' ')
    .replace(SHORT_DATE_LEADING_PATTERN, ' ');
}

function extractLineDescriptionAndDoc(
  line: PdfLine,
  hints: ColumnHints,
): { description: string; document: string } {
  const firstMoneyCol = Math.min(
    hints.debitX ?? Number.POSITIVE_INFINITY,
    hints.creditX ?? Number.POSITIVE_INFINITY,
    hints.amountX ?? Number.POSITIVE_INFINITY,
  );

  // If chunk X positions and money column X exist, separate chunks cleanly by geometry!
  if (Number.isFinite(firstMoneyCol) && line.chunks.length > 1) {
    let extractedDoc = '';
    const descChunks: string[] = [];

    for (const chunk of line.chunks) {
      if (chunk.x >= firstMoneyCol - 22 && parseMonetaryValue(chunk.text)) {
        continue;
      }
      if (
        hints.docX !== undefined &&
        Math.abs(chunk.x - hints.docX) <= 28 &&
        /^[\d./-]{1,20}$/.test(chunk.text.trim()) &&
        !readDate(chunk.text.trim())
      ) {
        if (!extractedDoc) extractedDoc = chunk.text.trim();
        continue;
      }
      descChunks.push(chunk.text);
    }

    let cleaned = normalizeSpaces(stripLeadingDates(descChunks.join(' ')));
    if (WRITTEN_DATE_LINE_PATTERN.test(cleaned)) {
      return { description: '', document: extractedDoc };
    }

    if (!extractedDoc) {
      const leadDoc = cleaned.match(/^(?:(?:doc(?:to|umento)?\.?\s*[:#-]?\s*)?)(\d{1,20})(?=\s|$)/i);
      if (leadDoc) {
        extractedDoc = leadDoc[1];
        cleaned = normalizeSpaces(cleaned.slice(leadDoc[0].length));
      } else if (hints.docX !== undefined) {
        const trailDoc = cleaned.match(/\s+(\d{4,14})$/);
        if (trailDoc) {
          extractedDoc = trailDoc[1];
          cleaned = normalizeSpaces(cleaned.slice(0, -trailDoc[0].length));
        }
      }
    }

    return { description: cleaned, document: extractedDoc };
  }

  // Text fallback (single-chunk / OCR)
  const values = Array.from(line.text.matchAll(MONEY_PATTERN));
  const cutoff = values[0]?.index ?? line.text.length;
  let beforeValue = line.text.slice(0, cutoff);
  beforeValue = normalizeSpaces(stripLeadingDates(beforeValue));

  if (WRITTEN_DATE_LINE_PATTERN.test(beforeValue)) {
    return { description: '', document: '' };
  }

  const documentMatch = beforeValue.match(/^(?:(?:doc(?:to|umento)?\.?\s*[:#-]?\s*)?)(\d{1,20})(?=\s|$)/i);
  const document = documentMatch?.[1] ?? '';
  if (documentMatch) beforeValue = beforeValue.slice(documentMatch[0].length);

  return { description: normalizeSpaces(beforeValue), document };
}

function isPureValueFragment(line: PdfLine): boolean {
  const compact = line.text.replace(/[R$BRL\s\-−–+().,\dCD]/gi, '');
  return compact.length === 0 && (moneyTokens(line.text).length > 0 || /^[-−–]$/.test(line.text.trim()));
}

function hasSaldoDia(description: string): boolean {
  return (
    /^(?:saldo\s+(?:do\s+)?dia|saldo\s+anterior|saldo\s+inicial|saldo\s+final|s\s*a\s*l\s*d\s*o)$/i.test(
      description.trim(),
    ) || SUMMARY_OR_NON_TX_LINE_PATTERN.test(description.trim())
  );
}

function lineDistance(first: PdfLine, second: PdfLine): number {
  return Math.abs(first.y - second.y);
}

function recordAlreadyComplete(record: WorkingRecord, hints: ColumnHints): boolean {
  const allLines = [record.line, ...record.continuations];
  const hasMoney = allLines.some((l) => moneyTokens(l.text).length > 0);
  if (!hasMoney) return false;
  const hasDesc = allLines.some((l) => {
    if (isPureValueFragment(l) || isEffectiveDateLine(l.text)) return false;
    const { description } = extractLineDescriptionAndDoc(l, hints);
    return description.length >= 3;
  });
  return hasDesc;
}

type RawParsedTx = {
  tx: Transaction;
  signWasAmbiguous: boolean;
};

function applyLearnedHistoryReplacements(
  history: string,
  model: LearnedLayoutModel,
): string {
  let result = history;
  for (const rule of model.historyReplacements) {
    if (!rule.from.trim()) continue;
    const escaped = rule.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    result = result.replace(new RegExp(escaped, 'gi'), rule.to);
  }
  return normalizeSpaces(result);
}

function parseRecord(
  record: WorkingRecord,
  fileName: string,
  bankName: string,
  layoutModel: LearnedLayoutModel,
  sourceId: string,
  page: number,
  index: number,
  hints: ColumnHints,
  period: StatementPeriod,
): RawParsedTx | null {
  const dateFromMain = selectedDate(record.line, hints, period);
  const dateFromCont = record.continuations
    .map((line) => selectedDate(line, hints, period))
    .find((d): d is string => d !== null);
  const date = dateFromMain ?? dateFromCont ?? record.inheritedDate ?? null;
  if (!date) return null;

  const detailLines = [record.line, ...record.continuations];
  const mainValues = moneyTokens(record.line.text);
  const continuationText = record.continuations.map((item) => item.text).join(' ');
  const fragmentValues = moneyTokens(continuationText);
  const allValues = [...mainValues, ...fragmentValues];
  if (allValues.length === 0) return null;

  const positionedValues = valuesAtPosition(detailLines);
  if (hasOnlyBalanceColumnValue(positionedValues, hints)) {
    return null;
  }

  let amountToken: ValueToken & { x?: number };
  let balanceToken: ValueToken | undefined;
  const splitLayout = hints.splitDateLayout || isDateAnchor(record.line, period);
  const structuredHints = splitLayout
    ? { ...hints, amountX: hints.amountX ?? 500, balanceX: hints.balanceX ?? 700 }
    : hints;

  const hasDualColumns = hints.debitX !== undefined && hints.creditX !== undefined;
  const positionedAmount = nearestValueWithin(positionedValues, structuredHints.amountX);
  const positionedBalance = nearestValueWithin(positionedValues, structuredHints.balanceX);

  if (hasDualColumns && positionedValues.length >= 1) {
    const nonBalance = positionedValues.filter(
      (v) =>
        hints.balanceX === undefined ||
        Math.abs(v.x - hints.balanceX) >
          Math.min(Math.abs(v.x - hints.debitX!), Math.abs(v.x - hints.creditX!)),
    );
    const candidate = nonBalance[0] ?? positionedValues[0];
    amountToken = candidate;
    balanceToken =
      positionedBalance && positionedBalance !== candidate
        ? positionedBalance
        : allValues.length > 1
          ? allValues[allValues.length - 1]
          : undefined;
  } else if (positionedAmount && positionedAmount !== positionedBalance) {
    amountToken = positionedAmount;
    balanceToken =
      positionedBalance ?? (allValues.length > 1 ? allValues[allValues.length - 1] : undefined);
  } else if (mainValues.length === 1 && mainValues[0].currency && fragmentValues.length > 0) {
    amountToken = fragmentValues[0];
    balanceToken = mainValues[0];
  } else {
    amountToken = positionedValues[0] ?? allValues[0];
    balanceToken = allValues.length > 1 ? allValues[allValues.length - 1] : undefined;
  }

  // Strictly ignore 0,00 informational status lines (Saldo Bloqueado 0,00, Limite 0,00, Juros 0,00, etc.)
  if (amountToken.absValue < 0.005) {
    return null;
  }

  let document = '';
  const descriptions = detailLines
    .filter(
      (line) =>
        !isPureValueFragment(line) &&
        !isEffectiveDateLine(line.text) &&
        !isTrackingCode(line.text) &&
        !isSectionStopLine(line.text),
    )
    .map((line) => {
      const parsed = extractLineDescriptionAndDoc(line, structuredHints);
      if (!document && parsed.document) document = parsed.document;
      return parsed.description;
    })
    .filter(
      (text) =>
        text.length > 0 &&
        !/^(?:data(?:\s+\w+)?\s*)?(?:nr\.?\s*doc\.?|doc(?:to)?\.?|documento)?\s*(?:hist[oó]rico(?:\s+operacional)?|descri[çc][aã]o|lan[çc]amentos?)(?:\s+(?:docto\.?|documento|valor|d[eé]bito|cr[eé]dito|saldo))?$/i.test(
          text.trim(),
        ) &&
        !FOOTER_PATTERN.test(text) &&
        !SUMMARY_OR_NON_TX_LINE_PATTERN.test(text.trim()) &&
        !isIgnoredByLearnedModel(text, layoutModel.ignoredPatterns),
    );

  const joinedHistory = normalizeHistoryParts(descriptions);
  if (!joinedHistory || hasSaldoDia(joinedHistory)) return null;
  if (isIgnoredByLearnedModel(joinedHistory, layoutModel.ignoredPatterns)) return null;

  const history = applyLearnedHistoryReplacements(joinedHistory, layoutModel);
  if (!history || hasSaldoDia(history)) return null;

  const upperHistory = history.toUpperCase();
  const learnedCreditHit = layoutModel.creditKeywords.some((kw) => upperHistory.includes(kw.toUpperCase()));
  const learnedDebitHit = layoutModel.debitKeywords.some((kw) => upperHistory.includes(kw.toUpperCase()));

  const separateMinus = record.continuations.some((line) => /^[-−–]$/.test(line.text.trim()));
  let amount: number;
  let signWasAmbiguous = false;

  if (learnedCreditHit && !learnedDebitHit) {
    amount = amountToken.absValue;
  } else if (learnedDebitHit && !learnedCreditHit) {
    amount = -amountToken.absValue;
  } else if (amountToken.signHint === 'debit' || separateMinus) {
    amount = -amountToken.absValue;
  } else if (amountToken.signHint === 'credit') {
    amount = amountToken.absValue;
  } else if (hasDualColumns && amountToken.x !== undefined) {
    const distDebit = Math.abs(amountToken.x - hints.debitX!);
    const distCredit = Math.abs(amountToken.x - hints.creditX!);
    amount = distDebit <= distCredit ? -amountToken.absValue : amountToken.absValue;
  } else {
    signWasAmbiguous = true;
    const isCred = CREDIT_PATTERN.test(history);
    const isDeb = DEBIT_PATTERN.test(history);
    if (isCred && !isDeb) {
      amount = amountToken.absValue;
    } else if (isDeb && !isCred) {
      amount = -amountToken.absValue;
    } else {
      amount = amountToken.value;
    }
  }

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
    signWasAmbiguous,
    tx: {
      id: `${sourceId}-${page}-${index}-${date}-${amount.toFixed(2)}`,
      date,
      document,
      history,
      accountCode: '',
      amount,
      debit: amount < 0 ? Math.abs(amount) : 0,
      credit: amount > 0 ? amount : 0,
      balance: balanceToken?.value ?? null,
      sourceId,
      sourceFile: fileName,
      sourceBank: bankName,
      layoutModelId: layoutModel.id,
      sourcePage: page,
      confidence: Math.max(0.35, Math.min(0.99, confidence)),
      warnings,
    },
  };
}

function reconcileSignsByBalance(
  items: RawParsedTx[],
  openingBalance: number | null,
): Transaction[] {
  let prevBalance = openingBalance;

  return items.map(({ tx, signWasAmbiguous }) => {
    let adjustedAmount = tx.amount;
    if (prevBalance !== null && tx.balance !== null) {
      const absAmt = Math.abs(tx.amount);
      const ifDebit = Math.round((prevBalance - absAmt) * 100) / 100;
      const ifCredit = Math.round((prevBalance + absAmt) * 100) / 100;
      const matchesDebit = Math.abs(ifDebit - tx.balance) <= 0.02;
      const matchesCredit = Math.abs(ifCredit - tx.balance) <= 0.02;

      if (signWasAmbiguous && matchesDebit && !matchesCredit) {
        adjustedAmount = -absAmt;
      } else if (signWasAmbiguous && matchesCredit && !matchesDebit) {
        adjustedAmount = absAmt;
      }
    }

    if (tx.balance !== null) {
      prevBalance = tx.balance;
    } else if (prevBalance !== null) {
      prevBalance = Math.round((prevBalance + adjustedAmount) * 100) / 100;
    }

    if (adjustedAmount !== tx.amount) {
      return {
        ...tx,
        amount: adjustedAmount,
        debit: adjustedAmount < 0 ? Math.abs(adjustedAmount) : 0,
        credit: adjustedAmount > 0 ? adjustedAmount : 0,
      };
    }

    return tx;
  });
}

function recordsFromLines(
  lines: PdfLine[],
  period: StatementPeriod,
  hints: ColumnHints,
  ignoredPatterns: string[],
  sectionState: SectionParserState,
): WorkingRecord[] {
  const MAX_CONTINUATION_STEP_Y = 30;
  const MAX_INHERITED_ROW_GAP_Y = 44;

  const records: WorkingRecord[] = [];
  let current: WorkingRecord | null = null;
  let pending: PdfLine[] = [];

  const attachClosePendingLines = (next: WorkingRecord | null) => {
    if (pending.length === 0) return;

    if (!current) {
      if (next) {
        next.continuations.push(
          ...pending.filter((line) => lineDistance(line, next.line) <= MAX_CONTINUATION_STEP_Y),
        );
      }
      pending = [];
      return;
    }

    let prevBottomY =
      current.continuations.length > 0
        ? current.continuations[current.continuations.length - 1].y
        : current.line.y;

    for (const line of pending) {
      const gapFromCurrent = Math.abs(prevBottomY - line.y);
      const gapToNext = next ? Math.abs(line.y - next.line.y) : Number.POSITIVE_INFINITY;

      if (gapFromCurrent <= MAX_CONTINUATION_STEP_Y && gapFromCurrent <= gapToNext) {
        current.continuations.push(line);
        prevBottomY = line.y;
      } else if (next && gapToNext <= MAX_CONTINUATION_STEP_Y) {
        next.continuations.push(line);
      }
    }
    pending = [];
  };

  for (const line of lines) {
    // 1. Explicit Transaction Table Header re-opens active transaction parsing
    if (isTransactionTableHeader(line)) {
      attachClosePendingLines(null);
      sectionState.inExcludedSection = false;
      current = null;
      pending = [];
      continue;
    }

    // 2. Non-transaction section boundary ("Saldo", "Posição em: ...", "Limites", "Lançamentos Futuros", etc.)
    if (isSectionStopLine(line.text)) {
      attachClosePendingLines(null);
      sectionState.inExcludedSection = true;
      sectionState.activeDate = null;
      current = null;
      pending = [];
      continue;
    }

    if (sectionState.inExcludedSection) {
      continue;
    }

    // 3. Summary / noise filtering
    if (isNoise(line, ignoredPatterns)) {
      continue;
    }

    // 4. Dated transaction row start
    if (looksLikeStart(line, period, hints)) {
      const next: WorkingRecord = { line, continuations: [] };
      attachClosePendingLines(next);
      const lineDate = selectedDate(line, hints, period);
      if (lineDate) sectionState.activeDate = lineDate;
      records.push(next);
      current = next;
      continue;
    }

    // 5. Standalone date header anchor (e.g. Nubank / Inter "05 MAR 2026" on left margin)
    if (isDateAnchor(line, period)) {
      const anchorDate = selectedDate(line, hints, period);
      if (anchorDate) sectionState.activeDate = anchorDate;
      const next: WorkingRecord = { line, continuations: [], inheritedDate: anchorDate ?? undefined };
      attachClosePendingLines(next);
      records.push(next);
      current = next;
      continue;
    }

    // 6. Same-day dateless transaction row inside an active date group
    // Must have non-zero transaction value (not balance-only column), valid non-summary description,
    // and close vertical proximity to the preceding transaction row (never across separate boxes!).
    const lastAnchorY =
      current && current.continuations.length > 0
        ? current.continuations[current.continuations.length - 1].y
        : current?.line.y;
    const verticalGap = lastAnchorY !== undefined ? Math.abs(lastAnchorY - line.y) : 0;

    if (
      sectionState.activeDate &&
      moneyTokens(line.text).length > 0 &&
      !isPureValueFragment(line) &&
      !isEffectiveDateLine(line.text) &&
      !hasOnlyBalanceColumnValue(valuesAtPosition([line]), hints) &&
      (current === null || verticalGap <= MAX_INHERITED_ROW_GAP_Y)
    ) {
      const { description } = extractLineDescriptionAndDoc(line, hints);
      if (
        description.length >= 3 &&
        !HEADER_PATTERN.test(description) &&
        !SUMMARY_OR_NON_TX_LINE_PATTERN.test(description)
      ) {
        if (pending.length > 0) {
          attachClosePendingLines(null);
        }
        if (!current || recordAlreadyComplete(current, hints)) {
          const next: WorkingRecord = {
            line,
            continuations: [],
            inheritedDate: sectionState.activeDate,
          };
          records.push(next);
          current = next;
          continue;
        }
      }
    }

    // If a large vertical break occurs without starting a transaction, close current so bottom boxes don't merge
    if (current && verticalGap > MAX_INHERITED_ROW_GAP_Y) {
      attachClosePendingLines(null);
      current = null;
      continue;
    }

    pending.push(line);
  }

  attachClosePendingLines(null);
  return records;
}

export async function parseBankStatement(
  file: File,
  onPage?: (current: number, total: number) => void,
  sourceId = file.name,
  password?: string,
  signal?: AbortSignal,
  learnedModels: LearnedLayoutModel[] = [],
  aiConfig: AiProviderConfig | null = null,
): Promise<ParseFileResult> {
  const data = new Uint8Array((await file.arrayBuffer()).slice(0));
  let document: pdfjsLib.PDFDocumentProxy;
  try {
    document = await pdfjsLib.getDocument({
      data,
      password: password || undefined,
    }).promise;
  } catch (err: unknown) {
    const errorObj = err as { name?: string };
    if (errorObj?.name === 'PasswordException') {
      throw new PasswordRequiredError(Boolean(password));
    }
    throw err;
  }

  const warnings: string[] = [];
  const agentNotes: string[] = [];
  const allPagesLines: PdfLine[][] = [];
  const ocrWorkerRef: { worker: TesseractWorker | null } = { worker: null };

  try {
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      if (signal?.aborted) {
        throw new Error('Processamento cancelado pelo usuário.');
      }
      onPage?.(pageNumber, document.numPages);
      const page = await document.getPage(pageNumber);
      const textContent = await page.getTextContent();
      let lines = makeLines(textContent.items);
      if (lines.length === 0) {
        warnings.push(`Página ${pageNumber} processada por OCR local.`);
        lines = await readPageWithOcr(page, ocrWorkerRef);
      }
      allPagesLines.push(lines);
    }
  } finally {
    if (ocrWorkerRef.worker) {
      await ocrWorkerRef.worker.terminate();
    }
  }

  const activePagesLines = filterActiveStatementLinesPerPage(allPagesLines);
  const headerLines = allPagesLines[0]?.slice(0, 22).map((l) => l.text) ?? [];
  const headerSample = allPagesLines
    .slice(0, 2)
    .flatMap((l) => l.slice(0, 25).map((item) => item.text))
    .join('\n');
  let bankName = detectBankName(headerSample);
  const headerTokens = normalizeHeaderTokens(headerLines);
  const { dateStyle, signStyle } = detectDateAndSignStyles(activePagesLines);
  const discoveredColumns = discoverNumericColumnClusters(activePagesLines);
  const period = inferStatementPeriod(activePagesLines);

  const matchResult = findMatchingLayoutModel(
    learnedModels,
    bankName,
    headerTokens,
    dateStyle,
    signStyle,
    discoveredColumns,
  );

  const nowIso = new Date().toISOString();
  const wasKnownModel = matchResult.model !== null;

  let activeModel: LearnedLayoutModel = matchResult.model
    ? {
        ...matchResult.model,
        columns: blendColumns(matchResult.model.columns, discoveredColumns),
      }
    : {
        id: crypto.randomUUID(),
        fingerprint: computeLayoutFingerprint(bankName, headerTokens, dateStyle, signStyle),
        name:
          bankName !== 'Extrato Bancário'
            ? `${bankName} · Layout ${dateStyle}`
            : `Layout Personalizado (${file.name.replace(/\.[^.]+$/, '').slice(0, 22)})`,
        bankName,
        headerTokens,
        dateStyle,
        signStyle,
        columns: discoveredColumns,
        creditKeywords: [],
        debitKeywords: [],
        ignoredPatterns: [],
        historyReplacements: [],
        timesSeen: 0,
        totalTransactions: 0,
        accuracyScore: 92,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

  if (wasKnownModel) {
    agentNotes.push(
      `Layout reconhecido na memória da I.A.: "${activeModel.name}" (${Math.round(
        matchResult.similarity * 100,
      )}% compatível, ${activeModel.creditKeywords.length + activeModel.debitKeywords.length + activeModel.ignoredPatterns.length} regra(s) aplicada(s)).`,
    );
  } else {
    agentNotes.push(
      `Novo modelo de layout catalogado pela I.A.: "${activeModel.name}" (formato ${dateStyle}, sinal ${signStyle}).`,
    );
  }

  let openingBalance: number | null = null;
  for (const pageLines of allPagesLines) {
    const found = extractOpeningBalanceFromLines(pageLines);
    if (found !== null) {
      openingBalance = found;
      break;
    }
  }

  const sectionState: SectionParserState = {
    inExcludedSection: false,
    activeDate: null,
  };

  const baseDocHints = inferColumns(
    allPagesLines[0] ?? [],
    activeModel.columns,
    Boolean(activeModel.swapDebitCreditColumns),
  );
  const effectiveColumns: LearnedColumns = {
    ...activeModel.columns,
    amountX: baseDocHints.amountX ?? activeModel.columns.amountX,
    debitX: baseDocHints.debitX ?? activeModel.columns.debitX,
    creditX: baseDocHints.creditX ?? activeModel.columns.creditX,
    balanceX: baseDocHints.balanceX ?? activeModel.columns.balanceX,
  };
  activeModel = {
    ...activeModel,
    columns: effectiveColumns,
  };

  const rawParsed: RawParsedTx[] = [];
  allPagesLines.forEach((lines, idx) => {
    const pageNumber = idx + 1;
    const pageHints = inferColumns(
      lines,
      effectiveColumns,
      Boolean(activeModel.swapDebitCreditColumns),
    );
    const hints: ColumnHints = {
      ...pageHints,
      dates: pageHints.dates.length > 0 ? pageHints.dates : baseDocHints.dates,
      docX: pageHints.docX ?? baseDocHints.docX,
    };
    const records = recordsFromLines(
      lines,
      period,
      hints,
      activeModel.ignoredPatterns,
      sectionState,
    );
    const parsedPage = records
      .map((record, rIndex) =>
        parseRecord(
          record,
          file.name,
          bankName,
          activeModel,
          sourceId,
          pageNumber,
          rIndex,
          hints,
          period,
        ),
      )
      .filter((entry): entry is RawParsedTx => entry !== null);
    rawParsed.push(...parsedPage);
  });

  let transactions = reconcileSignsByBalance(rawParsed, openingBalance);

  // External Generative AI fallback/enhancement if configured and layout yielded 0 rows
  if (transactions.length === 0 && aiConfig?.apiKey?.trim()) {
    const flatRaw = activePagesLines.flatMap((p) => p.map((l) => l.text));
    const llmResult = await queryExternalAiForRawLines(flatRaw, aiConfig);
    if (llmResult.bankName) bankName = llmResult.bankName;
    activeModel = {
      ...activeModel,
      bankName,
      creditKeywords: [...new Set([...activeModel.creditKeywords, ...(llmResult.creditKeywords ?? [])])],
      debitKeywords: [...new Set([...activeModel.debitKeywords, ...(llmResult.debitKeywords ?? [])])],
      ignoredPatterns: [...new Set([...activeModel.ignoredPatterns, ...(llmResult.ignoredPatterns ?? [])])],
    };
    transactions = (llmResult.transactions ?? [])
      .filter((item) => Math.abs(item.amount) >= 0.005)
      .map((item, idx) => ({
        id: `${sourceId}-ai-${idx}-${item.date}-${item.amount.toFixed(2)}`,
        date: item.date,
        document: item.document ?? '',
        history: item.history,
        accountCode: '',
        amount: item.amount,
        debit: item.amount < 0 ? Math.abs(item.amount) : 0,
        credit: item.amount > 0 ? item.amount : 0,
        balance: item.balance ?? null,
        sourceId,
        sourceFile: file.name,
        sourceBank: bankName,
        layoutModelId: activeModel.id,
        sourcePage: 1,
        confidence: 0.95,
        warnings: [],
      }));
    agentNotes.push(
      `Agente de I.A. Generativa extraiu ${transactions.length} lançamento(s) e salvou padrões do layout.`,
    );
  }

  // Autonomous Combinatorial Self-Correction pass
  const initialRec = computeReconciliation(transactions, openingBalance);
  if (initialRec.divergentDaysCount > 0) {
    const autoFixes = diagnoseAndSolveDivergences(transactions, initialRec);
    if (autoFixes.length > 0) {
      const removeIds = new Set(
        autoFixes.filter((f) => f.action === 'remove-noise').map((f) => f.transactionId),
      );
      const flipIds = new Set(
        autoFixes.filter((f) => f.action === 'invert-sign').map((f) => f.transactionId),
      );

      for (const fix of autoFixes) {
        const stem = extractReusablePatternStem(fix.history);
        if (fix.action === 'remove-noise' && stem.length >= 4) {
          activeModel.ignoredPatterns = [...new Set([stem, ...activeModel.ignoredPatterns])];
        } else if (fix.action === 'invert-sign' && stem.length >= 3) {
          if (fix.newAmount > 0) {
            activeModel.creditKeywords = [...new Set([stem, ...activeModel.creditKeywords])];
          } else {
            activeModel.debitKeywords = [...new Set([stem, ...activeModel.debitKeywords])];
          }
        }
      }

      transactions = transactions
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
        });

      agentNotes.push(
        `Auto-calibração de saldo da I.A.: ${autoFixes.length} ajuste(s) aplicado(s) automaticamente e memorizado(s) para este modelo.`,
      );
    }
  }

  const finalRec = computeReconciliation(transactions, openingBalance);
  const measuredAccuracy =
    finalRec.checkedDaysCount > 0
      ? Math.round(
          ((finalRec.checkedDaysCount - finalRec.divergentDaysCount) /
            finalRec.checkedDaysCount) *
            100,
        )
      : transactions.length > 0
        ? 95
        : 50;

  const updatedModel: LearnedLayoutModel = {
    ...activeModel,
    timesSeen: activeModel.timesSeen + 1,
    totalTransactions: activeModel.totalTransactions + transactions.length,
    accuracyScore:
      activeModel.timesSeen > 0
        ? Math.round(activeModel.accuracyScore * 0.4 + measuredAccuracy * 0.6)
        : measuredAccuracy,
    updatedAt: nowIso,
  };

  const closingBalance =
    [...transactions].reverse().find((tx) => tx.balance !== null)?.balance ?? null;

  if (transactions.length === 0) {
    warnings.push(
      'Nenhum lançamento estruturado foi localizado. Use o Agente de I.A. abaixo para calibrar este layout.',
    );
  }

  return {
    transactions,
    pages: document.numPages,
    warnings,
    bankName,
    openingBalance,
    closingBalance,
    updatedModel,
    wasKnownModel,
    agentNotes,
  };
}

function decodeTextBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  if (utf8.includes('\uFFFD')) {
    return new TextDecoder('windows-1252', { fatal: false }).decode(bytes);
  }
  return utf8;
}

function buildOrUpdateTabularModel(
  learnedModels: LearnedLayoutModel[],
  bankName: string,
  formatLabel: string,
  headerTokens: string[],
  txCount: number,
): { model: LearnedLayoutModel; wasKnown: boolean } {
  const nowIso = new Date().toISOString();
  const fp = computeLayoutFingerprint(bankName, headerTokens, 'DD/MM/YYYY', 'LEADING_SIGN');
  const existing = learnedModels.find((m) => m.fingerprint === fp);
  if (existing) {
    return {
      wasKnown: true,
      model: {
        ...existing,
        timesSeen: existing.timesSeen + 1,
        totalTransactions: existing.totalTransactions + txCount,
        updatedAt: nowIso,
      },
    };
  }
  return {
    wasKnown: false,
    model: {
      id: crypto.randomUUID(),
      fingerprint: fp,
      name: `${bankName} · ${formatLabel}`,
      bankName,
      headerTokens,
      dateStyle: 'DD/MM/YYYY',
      signStyle: 'LEADING_SIGN',
      columns: {},
      creditKeywords: [],
      debitKeywords: [],
      ignoredPatterns: [],
      historyReplacements: [],
      timesSeen: 1,
      totalTransactions: txCount,
      accuracyScore: 99,
      createdAt: nowIso,
      updatedAt: nowIso,
    },
  };
}

export async function parseOfxStatement(
  file: File,
  sourceId = file.name,
  learnedModels: LearnedLayoutModel[] = [],
): Promise<ParseFileResult> {
  const text = decodeTextBuffer(await file.arrayBuffer());
  const orgMatch = text.match(/<ORG>([^<\r\n]+)/i);
  const bankIdMatch = text.match(/<BANKID>([^<\r\n]+)/i);
  const bankName = detectBankName(`${orgMatch?.[1] ?? ''} ${bankIdMatch?.[1] ?? ''} ${file.name}`);

  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const { model, wasKnown } = buildOrUpdateTabularModel(
    learnedModels,
    bankName,
    'Modelo OFX',
    ['ofx', bankName.toLowerCase()],
    blocks.length,
  );

  const transactions: Transaction[] = [];

  blocks.forEach((rawBlock, index) => {
    const block = rawBlock.split(/<\/STMTTRN>/i)[0] ?? rawBlock;
    const tag = (name: string) => {
      const m = block.match(new RegExp(`<${name}>([^<\\r\\n]+)`, 'i'));
      return m ? m[1].trim() : '';
    };

    const dtPosted = tag('DTPOSTED').replace(/\D/g, '');
    if (dtPosted.length < 8) return;
    const isoDate = buildIsoDate(
      Number(dtPosted.slice(0, 4)),
      Number(dtPosted.slice(4, 6)),
      Number(dtPosted.slice(6, 8)),
    );
    if (!isoDate) return;

    const amtRaw = tag('TRNAMT').replace(',', '.');
    const amount = Number(amtRaw);
    if (!Number.isFinite(amount) || Math.abs(amount) < 0.005) return;

    const namePart = tag('NAME');
    const memoPart = tag('MEMO');
    const combinedHistory = normalizeHistoryParts([namePart, memoPart]);
    const history = applyLearnedHistoryReplacements(combinedHistory || 'LANÇAMENTO OFX', model);
    if (hasSaldoDia(history) || isIgnoredByLearnedModel(history, model.ignoredPatterns)) return;

    const document = tag('CHECKNUM') || tag('REFNUM') || tag('FITID').slice(-10);

    transactions.push({
      id: `${sourceId}-ofx-${index}-${isoDate}-${amount.toFixed(2)}`,
      date: isoDate,
      document,
      history,
      accountCode: '',
      amount,
      debit: amount < 0 ? Math.abs(amount) : 0,
      credit: amount > 0 ? amount : 0,
      balance: null,
      sourceId,
      sourceFile: file.name,
      sourceBank: bankName,
      layoutModelId: model.id,
      sourcePage: 1,
      confidence: 0.99,
      warnings: [],
    });
  });

  const ledgerBalMatch = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]+)/i);
  const closingBalance = ledgerBalMatch ? Number(ledgerBalMatch[1].trim().replace(',', '.')) : null;
  if (transactions.length > 0 && closingBalance !== null && Number.isFinite(closingBalance)) {
    transactions[transactions.length - 1].balance = closingBalance;
  }

  return {
    transactions,
    pages: 1,
    warnings: transactions.length === 0 ? ['Nenhum bloco STMTTRN encontrado neste arquivo OFX.'] : [],
    bankName,
    openingBalance: null,
    closingBalance: closingBalance !== null && Number.isFinite(closingBalance) ? closingBalance : null,
    updatedModel: { ...model, totalTransactions: model.totalTransactions - blocks.length + transactions.length },
    wasKnownModel: wasKnown,
    agentNotes: [
      wasKnown
        ? `Modelo OFX reconhecido na memória: "${model.name}".`
        : `Modelo OFX registrado na memória: "${model.name}".`,
    ],
  };
}

function parseTabularRows(
  rows: string[][],
  fileName: string,
  sourceId: string,
  learnedModels: LearnedLayoutModel[],
): ParseFileResult {
  const bankName = detectBankName(fileName);
  const headerIdx = rows.findIndex(
    (row) =>
      row.some((cell) => /\bdata\b/i.test(cell)) &&
      row.some((cell) => /(valor|d[eé]bito|cr[eé]dito|hist[oó]rico|descri[çc][aã]o|lan[çc]amento)/i.test(cell)),
  );

  const headerTokens = headerIdx !== -1 ? normalizeHeaderTokens([rows[headerIdx].join(' ')]) : ['tabular'];
  const { model, wasKnown } = buildOrUpdateTabularModel(
    learnedModels,
    bankName,
    'Planilha / CSV',
    headerTokens,
    0,
  );

  if (headerIdx === -1) {
    return {
      transactions: [],
      pages: 1,
      warnings: ['Cabeçalho tabular (Data / Histórico / Valor) não identificado no arquivo.'],
      bankName,
      openingBalance: null,
      closingBalance: null,
      updatedModel: model,
      wasKnownModel: wasKnown,
      agentNotes: [],
    };
  }

  const headers = rows[headerIdx].map((h) => h.toLocaleLowerCase('pt-BR').trim());
  const findCol = (regex: RegExp) => headers.findIndex((h) => regex.test(h));

  const dateCol = findCol(/\bdata\b/);
  const docCol = findCol(/^(?:doc|docto|documento|n[ºo°]\s*doc|identificador)/);
  const histCol = findCol(/(hist[oó]rico|descri[çc][aã]o|lan[çc]amento|detalhe|memo)/);
  const valCol = findCol(/^valor/);
  const debCol = findCol(/^(?:d[eé]bito|sa[ií]da)/);
  const credCol = findCol(/^(?:cr[eé]dito|entrada)/);
  const balCol = findCol(/^saldo/);

  let openingBalance: number | null = null;
  const transactions: Transaction[] = [];

  for (let r = headerIdx + 1; r < rows.length; r += 1) {
    const row = rows[r];
    const joinedLine = row.join(' ').trim();
    if (!joinedLine) continue;
    if (isSectionStopLine(joinedLine)) break;

    const rawHistory = normalizeSpaces(histCol !== -1 ? row[histCol] ?? '' : 'LANÇAMENTO IMPORTADO');
    if (OPENING_BALANCE_PATTERN.test(rawHistory) && balCol !== -1) {
      const balTok = parseMonetaryValue(row[balCol] ?? '');
      if (balTok && openingBalance === null) openingBalance = balTok.value;
      continue;
    }

    const rawDate = (row[dateCol] ?? '').trim();
    const isoDate = readDate(rawDate);
    if (!isoDate) continue;

    let amount: number | null = null;
    if (debCol !== -1 || credCol !== -1) {
      const debToken = debCol !== -1 ? parseMonetaryValue(row[debCol] ?? '') : null;
      const credToken = credCol !== -1 ? parseMonetaryValue(row[credCol] ?? '') : null;
      const debVal = debToken ? Math.abs(debToken.value) : 0;
      const credVal = credToken ? Math.abs(credToken.value) : 0;
      if (debVal > 0 || credVal > 0) {
        amount = credVal - debVal;
      }
    }
    if (amount === null && valCol !== -1) {
      const valToken = parseMonetaryValue(row[valCol] ?? '');
      if (valToken) amount = valToken.value;
    }
    if (amount === null || Math.abs(amount) < 0.005) continue;

    if (!rawHistory || hasSaldoDia(rawHistory)) continue;
    if (isIgnoredByLearnedModel(rawHistory, model.ignoredPatterns)) continue;

    const history = applyLearnedHistoryReplacements(rawHistory, model);
    if (!history || hasSaldoDia(history)) continue;

    const document = normalizeSpaces(docCol !== -1 ? row[docCol] ?? '' : '');
    const balToken = balCol !== -1 ? parseMonetaryValue(row[balCol] ?? '') : null;

    transactions.push({
      id: `${sourceId}-row-${r}-${isoDate}-${amount.toFixed(2)}`,
      date: isoDate,
      document,
      history,
      accountCode: '',
      amount,
      debit: amount < 0 ? Math.abs(amount) : 0,
      credit: amount > 0 ? amount : 0,
      balance: balToken ? balToken.value : null,
      sourceId,
      sourceFile: fileName,
      sourceBank: bankName,
      layoutModelId: model.id,
      sourcePage: 1,
      confidence: 0.99,
      warnings: [],
    });
  }

  const closingBalance =
    [...transactions].reverse().find((tx) => tx.balance !== null)?.balance ?? null;

  return {
    transactions,
    pages: 1,
    warnings: transactions.length === 0 ? ['Nenhuma linha válida de transação encontrada.'] : [],
    bankName,
    openingBalance,
    closingBalance,
    updatedModel: { ...model, totalTransactions: model.totalTransactions + transactions.length },
    wasKnownModel: wasKnown,
    agentNotes: [
      wasKnown
        ? `Layout tabular reconhecido: "${model.name}".`
        : `Novo layout tabular memorizado: "${model.name}".`,
    ],
  };
}

export async function parseCsvStatement(
  file: File,
  sourceId = file.name,
  learnedModels: LearnedLayoutModel[] = [],
): Promise<ParseFileResult> {
  const text = decodeTextBuffer(await file.arrayBuffer()).replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const sample = lines.slice(0, 10).join('\n');
  const delimiter =
    (sample.match(/;/g)?.length ?? 0) >= (sample.match(/,/g)?.length ?? 0) ? ';' : ',';

  const parseLine = (line: string): string[] => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === delimiter && !inQuotes) {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  };

  return parseTabularRows(lines.map(parseLine), file.name, sourceId, learnedModels);
}

export async function parseSpreadsheetStatement(
  file: File,
  sourceId = file.name,
  learnedModels: LearnedLayoutModel[] = [],
): Promise<ParseFileResult> {
  const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('Planilha sem abas legíveis.');
  }
  const sheet = workbook.Sheets[sheetName];
  const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false });
  const stringRows = rawRows.map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? '')) : []));
  return parseTabularRows(stringRows, file.name, sourceId, learnedModels);
}

export async function parseUnifiedStatement(
  file: File,
  options: ParseFileOptions = {},
): Promise<ParseFileResult> {
  const format = detectFileFormat(file);
  const sourceId = options.sourceId ?? file.name;
  const models = options.learnedModels ?? [];
  if (format === 'ofx') {
    options.onPage?.(1, 1);
    return parseOfxStatement(file, sourceId, models);
  }
  if (format === 'csv') {
    options.onPage?.(1, 1);
    return parseCsvStatement(file, sourceId, models);
  }
  if (format === 'xlsx') {
    options.onPage?.(1, 1);
    return parseSpreadsheetStatement(file, sourceId, models);
  }
  return parseBankStatement(
    file,
    options.onPage,
    sourceId,
    options.password,
    options.signal,
    models,
    options.aiConfig ?? null,
  );
}

export function humanDate(date: string): string {
  return formatDate(date);
}

export function amountLabel(value: number | null): string {
  if (value === null) return '—';
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
