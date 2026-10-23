import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  parseBankStatement,
  parseCsvStatement,
  parseMonetaryValue,
  parseOfxStatement,
} from './bankParser';
import { mergeWithSmartDedup } from './dedup';
import { computeReconciliation } from './reconciliation';
import { buildCsvContent, buildOfxContent, buildWorkbook } from './exporters';

async function createMockPdf(
  name: string,
  pages: Array<Array<{ x: number; y: number; text: string }>>,
): Promise<File> {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

  for (const items of pages) {
    const page = pdfDoc.addPage([842, 595]);
    for (const item of items) {
      page.drawText(item.text, {
        x: item.x,
        y: item.y,
        size: 10,
        font,
      });
    }
  }

  const bytes = await pdfDoc.save();
  const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return {
    name,
    type: 'application/pdf',
    size: bytes.byteLength,
    lastModified: Date.now(),
    arrayBuffer: async () => ab,
  } as unknown as File;
}

describe('parseMonetaryValue', () => {
  it('parses Caixa D/C, Banco do Brasil (-)/(+), Itaú trailing minus, and BRL values accurately', () => {
    expect(parseMonetaryValue('12.555,84 D')?.value).toBe(-12555.84);
    expect(parseMonetaryValue('13.421,68 C')?.value).toBe(13421.68);
    expect(parseMonetaryValue('1.250,00 (-)')?.value).toBe(-1250.00);
    expect(parseMonetaryValue('3.400,50 (+)')?.value).toBe(3400.50);
    expect(parseMonetaryValue('890,25-')?.value).toBe(-890.25);
    expect(parseMonetaryValue('-R$ 250,00')?.value).toBe(-250.00);
  });
});

describe('Multi-bank real PDF parsing & reconciliation', () => {
  it('reconstructs Caixa Econômica multi-line descriptions, split D/C chunks, and opening/closing balances', async () => {
    const pdf = await createMockPdf('EXTRATOCAIXASET26.pdf', [
      [
        { x: 40, y: 550, text: 'CAIXA ECONOMICA FEDERAL - EXTRATO POR PERIODO' },
        { x: 40, y: 525, text: 'Data Mov.' },
        { x: 130, y: 525, text: 'Nr. Doc.' },
        { x: 210, y: 525, text: 'Historico' },
        { x: 520, y: 525, text: 'Valor' },
        { x: 660, y: 525, text: 'Saldo' },
        { x: 40, y: 500, text: '01/09/2026' },
        { x: 210, y: 500, text: 'SALDO ANTERIOR' },
        { x: 660, y: 500, text: '25.977,52' },
        { x: 718, y: 500, text: 'C' },
        { x: 40, y: 472, text: '05/09/2026' },
        { x: 130, y: 472, text: '31422' },
        { x: 210, y: 472, text: 'PAGAMENTO GAS' },
        { x: 520, y: 472, text: '12.555,84' },
        { x: 578, y: 472, text: 'D' },
        { x: 660, y: 472, text: '13.421,68' },
        { x: 718, y: 472, text: 'C' },
        { x: 210, y: 458, text: 'DO POVO' },
        { x: 40, y: 430, text: '08/09/2026' },
        { x: 130, y: 430, text: '90451' },
        { x: 210, y: 430, text: 'DEPOSITO CHEQUE' },
        { x: 520, y: 430, text: '1.578,32' },
        { x: 578, y: 430, text: 'C' },
        { x: 660, y: 430, text: '15.000,00' },
        { x: 718, y: 430, text: 'C' },
        { x: 210, y: 416, text: 'CAIXA AG' },
      ],
    ]);

    const parsed = await parseBankStatement(pdf);
    expect(parsed.bankName).toBe('Caixa Econômica Federal');
    expect(parsed.openingBalance).toBe(25977.52);
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0].document).toBe('31422');
    expect(parsed.transactions[0].history).toBe('PAGAMENTO GAS DO POVO');
    expect(parsed.transactions[0].amount).toBe(-12555.84);
    expect(parsed.transactions[0].balance).toBe(13421.68);
    expect(parsed.transactions[1].history).toBe('DEPOSITO CHEQUE CAIXA AG');
    expect(parsed.transactions[1].amount).toBe(1578.32);

    const rec = computeReconciliation(parsed.transactions, parsed.openingBalance);
    expect(rec.divergentDaysCount).toBe(0);
    expect(rec.calculatedClosingBalance).toBe(15000);
  });

  it('parses Itaú short DD/MM dates using header period year and trailing minus sign', async () => {
    const pdf = await createMockPdf('extrato-itau.pdf', [
      [
        { x: 40, y: 550, text: 'ITAU UNIBANCO S.A. - Extrato de Conta Corrente' },
        { x: 40, y: 530, text: 'Periodo: 01/09/2026 a 30/09/2026' },
        { x: 40, y: 495, text: '10/09' },
        { x: 110, y: 495, text: 'PIX TRANSF JOAO SILVA' },
        { x: 500, y: 495, text: '450,00-' },
        { x: 40, y: 472, text: '14/09' },
        { x: 110, y: 472, text: 'TED RECEBIDA CLIENTE SUL' },
        { x: 500, y: 472, text: '2.200,00' },
      ],
    ]);

    const parsed = await parseBankStatement(pdf);
    expect(parsed.bankName).toBe('Itaú Unibanco');
    expect(parsed.transactions).toHaveLength(2);
    expect(parsed.transactions[0].date).toBe('2026-09-10');
    expect(parsed.transactions[0].amount).toBe(-450);
    expect(parsed.transactions[1].date).toBe('2026-09-14');
    expect(parsed.transactions[1].amount).toBe(2200);
  });

  it('parses Bradesco same-day rows without repeated date and preserves legitimate identical fees while deduplicating overlapping PDFs', async () => {
    const pdfA = await createMockPdf('bradesco-parte1.pdf', [
      [
        { x: 40, y: 550, text: 'BANCO BRADESCO S.A. Extrato Mensal' },
        { x: 40, y: 505, text: '12/09/2026' },
        { x: 140, y: 505, text: 'TARIFA BANCARIA PIX' },
        { x: 500, y: 505, text: '-5,50' },
        // Second identical fee on same day without repeating date!
        { x: 140, y: 485, text: 'TARIFA BANCARIA PIX' },
        { x: 500, y: 485, text: '-5,50' },
      ],
    ]);

    const resA = await parseBankStatement(pdfA, undefined, 'src-a');
    expect(resA.transactions).toHaveLength(2);
    expect(resA.transactions[0].date).toBe('2026-09-12');
    expect(resA.transactions[1].date).toBe('2026-09-12');

    const step1 = mergeWithSmartDedup([], resA.transactions, true);
    expect(step1.records).toHaveLength(2);
    expect(step1.duplicatesCount).toBe(0);

    // Re-importing the overlapping PDF removes the 2 cross-file duplicates while keeping the original 2!
    const resB = await parseBankStatement(pdfA, undefined, 'src-b');
    const step2 = mergeWithSmartDedup(step1.records, resB.transactions, true);
    expect(step2.records).toHaveLength(2);
    expect(step2.duplicatesCount).toBe(2);
  });

  it('parses Banco do Brasil (+)/(-) suffixes with HH:MM timestamp continuations and Nubank written date headers', async () => {
    const bbPdf = await createMockPdf('extrato-bb.pdf', [
      [
        { x: 40, y: 550, text: 'BANCO DO BRASIL S.A. - SISBB' },
        { x: 40, y: 500, text: '06/09/2026' },
        { x: 130, y: 500, text: '88201' },
        { x: 210, y: 500, text: 'PIX ENVIADO' },
        { x: 520, y: 500, text: '1.250,00 (-)' },
        { x: 210, y: 486, text: '06/09 14:32' },
        { x: 210, y: 472, text: 'FORNECEDOR ALFA LTDA' },
        { x: 40, y: 444, text: '07/09/2026' },
        { x: 130, y: 444, text: '88299' },
        { x: 210, y: 444, text: 'PIX RECEBIDO' },
        { x: 520, y: 444, text: '3.900,00 (+)' },
        { x: 210, y: 430, text: 'CLIENTE BETA SA' },
      ],
    ]);

    const bbRes = await parseBankStatement(bbPdf);
    expect(bbRes.bankName).toBe('Banco do Brasil');
    expect(bbRes.transactions).toHaveLength(2);
    expect(bbRes.transactions[0].history).toBe('PIX ENVIADO FORNECEDOR ALFA LTDA');
    expect(bbRes.transactions[0].amount).toBe(-1250);
    expect(bbRes.transactions[1].history).toBe('PIX RECEBIDO CLIENTE BETA SA');
    expect(bbRes.transactions[1].amount).toBe(3900);

    const nuPdf = await createMockPdf('extrato-nubank.pdf', [
      [
        { x: 40, y: 550, text: 'Nu Pagamentos S.A. - Extrato Setembro 2026' },
        { x: 40, y: 505, text: '18 SET 2026' },
        { x: 140, y: 488, text: 'Transferencia recebida pelo Pix - Carla Souza' },
        { x: 520, y: 488, text: 'R$ 850,00' },
        { x: 140, y: 468, text: 'Compra no debito - Posto Avenida' },
        { x: 520, y: 468, text: '-R$ 210,40' },
      ],
    ]);

    const nuRes = await parseBankStatement(nuPdf);
    expect(nuRes.bankName).toBe('Nubank');
    expect(nuRes.transactions).toHaveLength(2);
    expect(nuRes.transactions[0].date).toBe('2026-09-18');
    expect(nuRes.transactions[0].amount).toBe(850);
    expect(nuRes.transactions[1].date).toBe('2026-09-18');
    expect(nuRes.transactions[1].amount).toBe(-210.4);
  });

  it('supports full roundtrip export & re-import for CSV, OFX, and multi-sheet XLSX', async () => {
    const pdf = await createMockPdf('roundtrip.pdf', [
      [
        { x: 40, y: 500, text: '15/09/2026  44120  PIX RECEBIDO LOJA NORTE  3.100,00 C  3.100,00 C' },
        { x: 40, y: 475, text: '16/09/2026  44121  DARF SIMPLES NACIONAL  610,00 D  2.490,00 C' },
      ],
    ]);
    const parsed = await parseBankStatement(pdf);
    const rec = computeReconciliation(parsed.transactions, 0);

    const wb = buildWorkbook(parsed.transactions, rec, 'completo');
    expect(wb.SheetNames).toEqual([
      'Lançamentos',
      'Resumo Mensal',
      'Por Categoria',
      'Conciliação Diária',
    ]);

    const ofxText = buildOfxContent(parsed.transactions, rec);
    const ofxBytes = new TextEncoder().encode(ofxText);
    const ofxFile = {
      name: 'teste.ofx',
      arrayBuffer: async () => ofxBytes.buffer,
    } as unknown as File;
    const reimportedOfx = await parseOfxStatement(ofxFile);
    expect(reimportedOfx.transactions).toHaveLength(2);
    expect(reimportedOfx.transactions[1].amount).toBe(-610);

    const csvText = buildCsvContent(parsed.transactions, 'contabil');
    const csvBytes = new TextEncoder().encode(csvText);
    const csvFile = {
      name: 'teste.csv',
      arrayBuffer: async () => csvBytes.buffer,
    } as unknown as File;
    const reimportedCsv = await parseCsvStatement(csvFile);
    expect(reimportedCsv.transactions).toHaveLength(2);
    expect(reimportedCsv.transactions[0].credit).toBe(3100);
    expect(reimportedCsv.transactions[1].debit).toBe(610);
  });
});
