import * as XLSX from 'xlsx';
import type { ExportLayout, ReconciliationSummary, Transaction } from '../types';

function toExcelDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function formatDateBr(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  return `${day}/${month}/${year}`;
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

export function buildWorkbook(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  layout: ExportLayout,
): XLSX.WorkBook {
  const workbook = XLSX.utils.book_new();
  const currencyFmt = 'R$ #,##0.00;[Red]-R$ #,##0.00';

  if (layout === 'contabil') {
    const rows: unknown[][] = [
      ['Data', 'Débito', 'Crédito', 'Histórico'],
      ...transactions.map((tx) => [
        toExcelDate(tx.date),
        tx.debit === 0 ? '' : tx.debit,
        tx.credit === 0 ? '' : tx.credit,
        tx.document ? `${tx.history} · Doc. ${tx.document}` : tx.history,
      ]),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    ws['!cols'] = [{ wch: 13 }, { wch: 16 }, { wch: 16 }, { wch: 62 }];
    for (let r = 2; r <= transactions.length + 1; r += 1) {
      if (ws[`A${r}`]) ws[`A${r}`].z = 'dd/mm/yyyy';
      if (ws[`B${r}`] && typeof ws[`B${r}`].v === 'number') ws[`B${r}`].z = currencyFmt;
      if (ws[`C${r}`] && typeof ws[`C${r}`].v === 'number') ws[`C${r}`].z = currencyFmt;
    }
    const totalRow = transactions.length + 2;
    const totalDebit = transactions.reduce((sum, tx) => sum + tx.debit, 0);
    const totalCredit = transactions.reduce((sum, tx) => sum + tx.credit, 0);
    ws[`A${totalRow}`] = { t: 's', v: 'TOTAL' };
    ws[`B${totalRow}`] = { t: 'n', f: `SUM(B2:B${transactions.length + 1})`, v: totalDebit, z: currencyFmt };
    ws[`C${totalRow}`] = { t: 'n', f: `SUM(C2:C${transactions.length + 1})`, v: totalCredit, z: currencyFmt };
    ws[`D${totalRow}`] = {
      t: 's',
      v: `Resultado Líquido: ${(totalCredit - totalDebit).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}`,
    };
    ws['!ref'] = `A1:D${totalRow}`;
    ws['!autofilter'] = { ref: `A1:D${transactions.length + 1}` };
    XLSX.utils.book_append_sheet(workbook, ws, 'Lançamentos');
  } else {
    const rows: unknown[][] = [
      [
        'Data',
        'Documento',
        'Histórico',
        'Conta Contábil',
        'Débito',
        'Crédito',
        'Valor Líquido',
        'Saldo PDF',
        'Saldo Calculado',
        'Status Conciliação',
        'Banco / Arquivo',
      ],
      ...transactions.map((tx) => {
        const calcBal = reconciliation.rowCalculatedBalance[tx.id] ?? '';
        const isEod = reconciliation.endOfDayRowIds.has(tx.id);
        const delta = reconciliation.dayDeltaByRowId[tx.id];
        let status = '';
        if (isEod && delta !== undefined) {
          status = Math.abs(delta) <= 0.02 ? 'Conciliado' : `Divergência (${delta.toFixed(2)})`;
        }
        return [
          toExcelDate(tx.date),
          tx.document,
          tx.history,
          tx.accountCode,
          tx.debit === 0 ? '' : tx.debit,
          tx.credit === 0 ? '' : tx.credit,
          tx.amount,
          tx.balance === null ? '' : tx.balance,
          calcBal === null ? '' : calcBal,
          status,
          tx.sourceBank ? `${tx.sourceBank} · ${tx.sourceFile}` : tx.sourceFile,
        ];
      }),
    ];
    const ws = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    ws['!cols'] = [
      { wch: 13 },
      { wch: 15 },
      { wch: 56 },
      { wch: 15 },
      { wch: 15 },
      { wch: 15 },
      { wch: 16 },
      { wch: 16 },
      { wch: 16 },
      { wch: 22 },
      { wch: 34 },
    ];
    for (let r = 2; r <= transactions.length + 1; r += 1) {
      if (ws[`A${r}`]) ws[`A${r}`].z = 'dd/mm/yyyy';
      for (const col of ['E', 'F', 'G', 'H', 'I']) {
        if (ws[`${col}${r}`] && typeof ws[`${col}${r}`].v === 'number') {
          ws[`${col}${r}`].z = currencyFmt;
        }
      }
    }
    const totalRow = transactions.length + 2;
    const totalDebit = transactions.reduce((sum, tx) => sum + tx.debit, 0);
    const totalCredit = transactions.reduce((sum, tx) => sum + tx.credit, 0);
    const totalNet = transactions.reduce((sum, tx) => sum + tx.amount, 0);
    ws[`A${totalRow}`] = { t: 's', v: 'TOTAL' };
    ws[`E${totalRow}`] = { t: 'n', f: `SUM(E2:E${transactions.length + 1})`, v: totalDebit, z: currencyFmt };
    ws[`F${totalRow}`] = { t: 'n', f: `SUM(F2:F${transactions.length + 1})`, v: totalCredit, z: currencyFmt };
    ws[`G${totalRow}`] = { t: 'n', f: `SUM(G2:G${transactions.length + 1})`, v: totalNet, z: currencyFmt };
    ws['!ref'] = `A1:K${totalRow}`;
    ws['!autofilter'] = { ref: `A1:K${transactions.length + 1}` };
    XLSX.utils.book_append_sheet(workbook, ws, 'Lançamentos');
  }

  // Aba 2: Resumo Mensal
  const monthMap = new Map<string, { count: number; credits: number; debits: number }>();
  for (const tx of transactions) {
    const ym = tx.date.slice(0, 7);
    const cur = monthMap.get(ym) ?? { count: 0, credits: 0, debits: 0 };
    cur.count += 1;
    cur.credits += tx.credit;
    cur.debits += tx.debit;
    monthMap.set(ym, cur);
  }
  const monthRows: unknown[][] = [
    ['Competência (AAAA-MM)', 'Qtd. Lançamentos', 'Total Créditos', 'Total Débitos', 'Resultado Líquido'],
    ...Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([ym, stats]) => [
        ym,
        stats.count,
        Math.round(stats.credits * 100) / 100,
        Math.round(stats.debits * 100) / 100,
        Math.round((stats.credits - stats.debits) * 100) / 100,
      ]),
  ];
  const monthSheet = XLSX.utils.aoa_to_sheet(monthRows);
  monthSheet['!cols'] = [{ wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 20 }];
  for (let r = 2; r <= monthRows.length; r += 1) {
    for (const col of ['C', 'D', 'E']) {
      if (monthSheet[`${col}${r}`]) monthSheet[`${col}${r}`].z = currencyFmt;
    }
  }
  XLSX.utils.book_append_sheet(workbook, monthSheet, 'Resumo Mensal');

  // Aba 3: Conciliação Diária
  if (reconciliation.days.length > 0) {
    const recRows: unknown[][] = [
      [
        'Data',
        'Qtd. Dia',
        'Saldo Inicial Dia',
        'Créditos Dia',
        'Débitos Dia',
        'Saldo Esperado',
        'Saldo Informado PDF',
        'Diferença',
        'Situação',
      ],
      ...reconciliation.days.map((day) => [
        toExcelDate(day.date),
        day.count,
        day.openingBalance ?? '',
        day.credits,
        day.debits,
        day.expectedClosing ?? '',
        day.reportedClosing ?? '',
        day.delta ?? '',
        day.reconciled === null ? 'Sem saldo PDF no dia' : day.reconciled ? 'Conciliado' : 'Divergente',
      ]),
    ];
    const recSheet = XLSX.utils.aoa_to_sheet(recRows, { cellDates: true });
    recSheet['!cols'] = [
      { wch: 13 },
      { wch: 11 },
      { wch: 18 },
      { wch: 16 },
      { wch: 16 },
      { wch: 18 },
      { wch: 19 },
      { wch: 15 },
      { wch: 22 },
    ];
    for (let r = 2; r <= recRows.length; r += 1) {
      if (recSheet[`A${r}`]) recSheet[`A${r}`].z = 'dd/mm/yyyy';
      for (const col of ['C', 'D', 'E', 'F', 'G', 'H']) {
        if (recSheet[`${col}${r}`] && typeof recSheet[`${col}${r}`].v === 'number') {
          recSheet[`${col}${r}`].z = currencyFmt;
        }
      }
    }
    XLSX.utils.book_append_sheet(workbook, recSheet, 'Conciliação Diária');
  }

  return workbook;
}

export function downloadXlsx(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
  layout: ExportLayout,
  filename = 'extrato-consolidado.xlsx',
): void {
  const workbook = buildWorkbook(transactions, reconciliation, layout);
  XLSX.writeFileXLSX(workbook, filename);
}

export function buildCsvContent(transactions: Transaction[], layout: ExportLayout): string {
  const escape = (value: string | number | null | undefined) =>
    `"${String(value ?? '').replaceAll('"', '""')}"`;
  const fmtMoney = (val: number) =>
    val.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const rows =
    layout === 'contabil'
      ? [
          ['Data', 'Débito', 'Crédito', 'Histórico'],
          ...transactions.map((tx) => [
            formatDateBr(tx.date),
            tx.debit === 0 ? '' : fmtMoney(tx.debit),
            tx.credit === 0 ? '' : fmtMoney(tx.credit),
            tx.document ? `${tx.history} · Doc. ${tx.document}` : tx.history,
          ]),
        ]
      : [
          [
            'Data',
            'Documento',
            'Histórico',
            'Conta Contábil',
            'Débito',
            'Crédito',
            'Valor Líquido',
            'Saldo PDF',
            'Arquivo Origem',
          ],
          ...transactions.map((tx) => [
            formatDateBr(tx.date),
            tx.document,
            tx.history,
            tx.accountCode,
            tx.debit === 0 ? '' : fmtMoney(tx.debit),
            tx.credit === 0 ? '' : fmtMoney(tx.credit),
            fmtMoney(tx.amount),
            tx.balance === null ? '' : fmtMoney(tx.balance),
            tx.sourceFile,
          ]),
        ];

  return `\ufeff${rows.map((row) => row.map(escape).join(';')).join('\n')}`;
}

export function downloadCsv(
  transactions: Transaction[],
  layout: ExportLayout,
  filename = 'extrato-consolidado.csv',
): void {
  const csv = buildCsvContent(transactions, layout);
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
  filename = 'extrato-consolidado.ofx',
): void {
  const ofx = buildOfxContent(transactions, reconciliation);
  downloadBlob(new Blob([ofx], { type: 'application/x-ofx;charset=utf-8;' }), filename);
}
