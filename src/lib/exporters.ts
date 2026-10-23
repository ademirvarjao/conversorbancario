import ExcelJS from 'exceljs';
import type { ExportLayout, ReconciliationSummary, Transaction } from '../types';

/** Pure accounting decimal format — strictly WITHOUT any currency symbol ($ / R$). */
export const PURE_DECIMAL_FMT = '#,##0.00;-#,##0.00';

const MAX_AUTO_COL_WIDTH = 105;
const MIN_COL_WIDTH = 12;

function toExcelDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
}

function formatDateBr(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
}

function formatPureDecimalBr(val: number): string {
  return val.toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatOfxDate(isoDate: string): string {
  return `${isoDate.replace(/-/g, '')}120000[-3:BRT]`;
}

function hashFitId(tx: Transaction, index: number): string {
  const raw = `${tx.date}|${tx.document}|${tx.amount.toFixed(2)}|${tx.history}|${index}`;
  let hash = 2166136261;
  for (let i = 0; i < raw.length; i += 1) {
    hash ^= raw.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const hex = (hash >>> 0).toString(16).toUpperCase().padStart(8, '0');
  return `${tx.date.replace(/-/g, '')}${hex}${String(index + 1).padStart(4, '0')}`;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

function colLetter(colNumber: number): string {
  let n = colNumber;
  let letters = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

function measureCellDisplayLength(cell: ExcelJS.Cell, isHeader: boolean): number {
  const val = cell.value;
  if (val === null || val === undefined || val === '') return 0;

  let text = '';
  if (val instanceof Date) {
    text = 'DD/MM/AAAA';
  } else if (typeof val === 'number') {
    text = formatPureDecimalBr(val);
  } else if (typeof val === 'object' && 'formula' in val) {
    const res = val.result;
    text = typeof res === 'number' ? formatPureDecimalBr(res) : String(res ?? '');
  } else {
    text = String(val);
  }

  const longestLine = text
    .split(/\r?\n/)
    .reduce((max, part) => Math.max(max, part.trim().length), 0);

  if (isHeader) {
    // Extra room for bold header glyphs + AutoFilter dropdown button icon
    return Math.ceil(longestLine * 1.16) + 5;
  }

  const isBold = Boolean(cell.font?.bold);
  const scale = isBold ? 1.14 : 1.06;
  return Math.ceil(longestLine * scale) + 4;
}

function autoFitWorksheetColumns(worksheet: ExcelJS.Worksheet): void {
  const colCount = worksheet.columnCount;

  for (let c = 1; c <= colCount; c += 1) {
    const column = worksheet.getColumn(c);
    let maxWidth = MIN_COL_WIDTH;

    column.eachCell({ includeEmpty: false }, (cell, rowNumber) => {
      const needed = measureCellDisplayLength(cell, rowNumber === 1);
      if (needed > maxWidth) {
        maxWidth = needed;
      }
    });

    column.width = Math.min(MAX_AUTO_COL_WIDTH, Math.max(MIN_COL_WIDTH, maxWidth));
  }

  // Adjust row height gracefully when any text cell exceeds MAX_AUTO_COL_WIDTH
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    let maxWrappedLines = 1;
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (typeof cell.value === 'string' && cell.value.length > 0) {
        const colW = worksheet.getColumn(colNumber).width ?? MAX_AUTO_COL_WIDTH;
        const lines = Math.ceil(cell.value.length / Math.max(20, colW - 4));
        if (lines > 1) {
          cell.alignment = { ...(cell.alignment ?? {}), wrapText: true };
          maxWrappedLines = Math.max(maxWrappedLines, lines);
        }
      }
    });
    if (maxWrappedLines > 1) {
      row.height = Math.max(row.height ?? 21, maxWrappedLines * 15 + 8);
    }
  });
}

export async function buildWorkbook(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  layout: ExportLayout,
): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Conversor de Extratos';
  workbook.created = new Date();

  // Single clean worksheet ONLY: "Lançamentos" (no extra Resumo or Conciliação tabs)
  const ws = workbook.addWorksheet('Lançamentos', {
    views: [{ state: 'frozen', ySplit: 1, showGridLines: true }],
    pageSetup: {
      paperSize: 9, // A4
      orientation: 'landscape',
      fitToPage: true,
      fitToWidth: 1,
      fitToHeight: 0,
      horizontalCentered: true,
      printTitlesRow: '1:1',
    },
  });

  const hasAccountCode = transactions.some((tx) => tx.accountCode.trim().length > 0);

  type ColumnSpec = {
    header: string;
    align: 'left' | 'center' | 'right';
    kind: 'date' | 'text' | 'debit' | 'credit' | 'balance';
    valueOf: (tx: Transaction) => Date | string | number | null;
  };

  const columnsSpec: ColumnSpec[] =
    layout === 'contabil'
      ? [
          {
            header: 'Data',
            align: 'center',
            kind: 'date',
            valueOf: (tx) => toExcelDate(tx.date),
          },
          ...(hasAccountCode
            ? [
                {
                  header: 'Conta Contábil',
                  align: 'center' as const,
                  kind: 'text' as const,
                  valueOf: (tx: Transaction) => tx.accountCode.trim(),
                },
              ]
            : []),
          {
            header: 'Débito',
            align: 'right',
            kind: 'debit',
            valueOf: (tx) => (tx.debit === 0 ? null : Math.round(tx.debit * 100) / 100),
          },
          {
            header: 'Crédito',
            align: 'right',
            kind: 'credit',
            valueOf: (tx) => (tx.credit === 0 ? null : Math.round(tx.credit * 100) / 100),
          },
          {
            header: 'Histórico',
            align: 'left',
            kind: 'text',
            valueOf: (tx) => (tx.document ? `${tx.history} · Doc. ${tx.document}` : tx.history),
          },
        ]
      : [
          {
            header: 'Data',
            align: 'center',
            kind: 'date',
            valueOf: (tx) => toExcelDate(tx.date),
          },
          {
            header: 'Documento',
            align: 'center',
            kind: 'text',
            valueOf: (tx) => tx.document,
          },
          {
            header: 'Histórico',
            align: 'left',
            kind: 'text',
            valueOf: (tx) => tx.history,
          },
          ...(hasAccountCode
            ? [
                {
                  header: 'Conta Contábil',
                  align: 'center' as const,
                  kind: 'text' as const,
                  valueOf: (tx: Transaction) => tx.accountCode.trim(),
                },
              ]
            : []),
          {
            header: 'Débito',
            align: 'right',
            kind: 'debit',
            valueOf: (tx) => (tx.debit === 0 ? null : Math.round(tx.debit * 100) / 100),
          },
          {
            header: 'Crédito',
            align: 'right',
            kind: 'credit',
            valueOf: (tx) => (tx.credit === 0 ? null : Math.round(tx.credit * 100) / 100),
          },
          {
            header: 'Saldo',
            align: 'right',
            kind: 'balance',
            valueOf: (tx) => {
              const bal = tx.balance ?? reconciliation.rowCalculatedBalance[tx.id] ?? null;
              return bal === null ? null : Math.round(bal * 100) / 100;
            },
          },
        ];

  // Header Row (Row 1)
  const headerRow = ws.addRow(columnsSpec.map((col) => col.header));
  headerRow.height = 28;
  headerRow.eachCell((cell, colNumber) => {
    const spec = columnsSpec[colNumber - 1];
    cell.font = {
      name: 'Segoe UI',
      size: 10.5,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF132B2D' },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: spec.align,
      indent: spec.align === 'left' ? 1 : 0,
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF132B2D' } },
      bottom: { style: 'medium', color: { argb: 'FF168C7B' } },
      left: { style: 'thin', color: { argb: 'FF25474A' } },
      right: { style: 'thin', color: { argb: 'FF25474A' } },
    };
  });

  // Data Rows (Rows 2 .. N+1)
  transactions.forEach((tx, index) => {
    const rowValues = columnsSpec.map((col) => col.valueOf(tx));
    const row = ws.addRow(rowValues);
    row.height = 21;
    const isEven = index % 2 === 1;
    const rowBg = isEven ? 'FFF6FAF9' : 'FFFFFFFF';

    columnsSpec.forEach((spec, cIdx) => {
      const cell = row.getCell(cIdx + 1);
      cell.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: rowBg },
      };
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE2ECEB' } },
        left: { style: 'thin', color: { argb: 'FFEDF4F3' } },
        right: { style: 'thin', color: { argb: 'FFEDF4F3' } },
      };
      cell.alignment = {
        vertical: 'middle',
        horizontal: spec.align,
        indent: spec.align === 'left' ? 1 : 0,
      };

      if (spec.kind === 'date') {
        cell.numFmt = 'dd/mm/yyyy';
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF1E293B' } };
      } else if (spec.kind === 'debit') {
        cell.numFmt = PURE_DECIMAL_FMT;
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FFB42318' } };
      } else if (spec.kind === 'credit') {
        cell.numFmt = PURE_DECIMAL_FMT;
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF067647' } };
      } else if (spec.kind === 'balance') {
        cell.numFmt = PURE_DECIMAL_FMT;
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF334155' } };
      } else {
        cell.font = { name: 'Segoe UI', size: 10, color: { argb: 'FF1D2939' } };
      }
    });
  });

  // Totals Footer Row (Row N+2)
  const lastDataRow = Math.max(2, transactions.length + 1);
  const totalDebit = Math.round(transactions.reduce((sum, tx) => sum + tx.debit, 0) * 100) / 100;
  const totalCredit = Math.round(transactions.reduce((sum, tx) => sum + tx.credit, 0) * 100) / 100;
  const netResult = Math.round((totalCredit - totalDebit) * 100) / 100;

  const totalRowValues = columnsSpec.map((spec, cIdx) => {
    if (cIdx === 0) return 'TOTAL';
    const letter = colLetter(cIdx + 1);
    if (spec.kind === 'debit') {
      return { formula: `SUM(${letter}2:${letter}${lastDataRow})`, result: totalDebit };
    }
    if (spec.kind === 'credit') {
      return { formula: `SUM(${letter}2:${letter}${lastDataRow})`, result: totalCredit };
    }
    if (spec.header === 'Histórico') {
      return `Resultado líquido do período: ${formatPureDecimalBr(netResult)}`;
    }
    return null;
  });

  const totalRow = ws.addRow(totalRowValues);
  totalRow.height = 26;
  columnsSpec.forEach((spec, cIdx) => {
    const cell = totalRow.getCell(cIdx + 1);
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE7F2F0' },
    };
    cell.border = {
      top: { style: 'thin', color: { argb: 'FF168C7B' } },
      bottom: { style: 'double', color: { argb: 'FF132B2D' } },
      left: { style: 'thin', color: { argb: 'FFD5E5E2' } },
      right: { style: 'thin', color: { argb: 'FFD5E5E2' } },
    };
    cell.alignment = {
      vertical: 'middle',
      horizontal: spec.align,
      indent: spec.align === 'left' ? 1 : 0,
    };

    if (spec.kind === 'debit') {
      cell.numFmt = PURE_DECIMAL_FMT;
      cell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FFB42318' } };
    } else if (spec.kind === 'credit') {
      cell.numFmt = PURE_DECIMAL_FMT;
      cell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FF067647' } };
    } else {
      cell.font = { name: 'Segoe UI', size: 10.5, bold: true, color: { argb: 'FF132B2D' } };
    }
  });

  ws.autoFilter = `A1:${colLetter(columnsSpec.length)}${lastDataRow}`;

  // Dynamic auto-sizing across every column (headers + rows + totals)
  autoFitWorksheetColumns(ws);

  return workbook;
}

export async function downloadXlsx(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  layout: ExportLayout,
  filename = 'extrato-lancamentos.xlsx',
): Promise<void> {
  const workbook = await buildWorkbook(transactions, reconciliation, layout);
  const buffer = await workbook.xlsx.writeBuffer();
  downloadBlob(
    new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
    filename,
  );
}

export function buildCsvContent(
  transactions: Transaction[],
  layout: ExportLayout,
  reconciliation?: ReconciliationSummary,
): string {
  const escape = (value: string | number | null | undefined) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;

  const hasAccountCode = transactions.some((tx) => tx.accountCode.trim().length > 0);

  const rows =
    layout === 'contabil'
      ? [
          ['Data', ...(hasAccountCode ? ['Conta Contábil'] : []), 'Débito', 'Crédito', 'Histórico'],
          ...transactions.map((tx) => [
            formatDateBr(tx.date),
            ...(hasAccountCode ? [tx.accountCode.trim()] : []),
            tx.debit === 0 ? '' : formatPureDecimalBr(tx.debit),
            tx.credit === 0 ? '' : formatPureDecimalBr(tx.credit),
            tx.document ? `${tx.history} · Doc. ${tx.document}` : tx.history,
          ]),
        ]
      : [
          [
            'Data',
            'Documento',
            'Histórico',
            ...(hasAccountCode ? ['Conta Contábil'] : []),
            'Débito',
            'Crédito',
            'Saldo',
          ],
          ...transactions.map((tx) => {
            const bal = tx.balance ?? reconciliation?.rowCalculatedBalance[tx.id] ?? null;
            return [
              formatDateBr(tx.date),
              tx.document,
              tx.history,
              ...(hasAccountCode ? [tx.accountCode.trim()] : []),
              tx.debit === 0 ? '' : formatPureDecimalBr(tx.debit),
              tx.credit === 0 ? '' : formatPureDecimalBr(tx.credit),
              bal === null ? '' : formatPureDecimalBr(bal),
            ];
          }),
        ];

  return `\ufeff${rows.map((row) => row.map(escape).join(';')).join('\n')}`;
}

export function downloadCsv(
  transactions: Transaction[],
  layout: ExportLayout,
  reconciliation?: ReconciliationSummary,
  filename = 'extrato-lancamentos.csv',
): void {
  const csv = buildCsvContent(transactions, layout, reconciliation);
  downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8;' }), filename);
}

export function buildOfxContent(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  accountId = '00001-0',
  bankId = '0104',
): string {
  const sorted = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const dtStart = sorted[0]?.date ? formatOfxDate(sorted[0].date) : '20260101120000[-3:BRT]';
  const dtEnd = sorted[sorted.length - 1]?.date
    ? formatOfxDate(sorted[sorted.length - 1].date)
    : dtStart;
  const finalBalance =
    reconciliation.reportedClosingBalance ?? reconciliation.calculatedClosingBalance ?? 0;

  const sanitizeOfx = (text: string) =>
    text
      .replace(/[<>&]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240);

  const trnBlocks = sorted
    .map((tx, idx) => {
      const trnType = tx.amount >= 0 ? 'CREDIT' : 'DEBIT';
      const checkLine = tx.document ? `\n<CHECKNUM>${sanitizeOfx(tx.document)}</CHECKNUM>` : '';
      return `<STMTTRN>
<TRNTYPE>${trnType}</TRNTYPE>
<DTPOSTED>${formatOfxDate(tx.date)}</DTPOSTED>
<TRNAMT>${tx.amount.toFixed(2)}</TRNAMT>
<FITID>${hashFitId(tx, idx)}</FITID>${checkLine}
<MEMO>${sanitizeOfx(tx.history)}</MEMO>
</STMTTRN>`;
    })
    .join('\n');

  return `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:UTF-8
CHARSET:NONE
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0</CODE>
<SEVERITY>INFO</SEVERITY>
</STATUS>
<DTSERVER>${dtEnd}</DTSERVER>
<LANGUAGE>POR</LANGUAGE>
</SONRS>
</SIGNONMSGSRSV1>
<BANKMSGSRSV1>
<STMTTRNRS>
<TRNUID>1</TRNUID>
<STATUS>
<CODE>0</CODE>
<SEVERITY>INFO</SEVERITY>
</STATUS>
<STMTRS>
<CURDEF>BRL</CURDEF>
<BANKACCTFROM>
<BANKID>${bankId}</BANKID>
<ACCTID>${accountId}</ACCTID>
<ACCTTYPE>CHECKING</ACCTTYPE>
</BANKACCTFROM>
<BANKTRANLIST>
<DTSTART>${dtStart}</DTSTART>
<DTEND>${dtEnd}</DTEND>
${trnBlocks}
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>${finalBalance.toFixed(2)}</BALAMT>
<DTASOF>${dtEnd}</DTASOF>
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;
}

export function downloadOfx(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  filename = 'extrato-lancamentos.ofx',
): void {
  const ofx = buildOfxContent(transactions, reconciliation);
  downloadBlob(new Blob([ofx], { type: 'application/x-ofx;charset=utf-8;' }), filename);
}
