import { describe, expect, it } from 'vitest';
import { parseMonetaryValue, parseUnifiedStatement, readDate } from './bankParser';
import { mergeWithSmartDedup } from './dedup';
import { recordIgnoredRowInModel, recordSignCorrectionInModel } from './layoutAgent';
import { computeReconciliation } from './reconciliation';

interface PdfTextOp {
  text: string;
  x: number;
  y: number;
}

/**
 * Generates a valid binary PDF 1.4 file with positioned text chunks (zero external dependencies).
 */
function buildPositionedPdfFile(
  name: string,
  draw: (put: (text: string, x: number, yFromTop: number) => void) => void,
): File {
  const ops: PdfTextOp[] = [];
  draw((text, x, yFromTop) => {
    ops.push({ text, x, y: 842 - yFromTop });
  });

  const escapePdfString = (str: string) =>
    str.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

  const streamContent = [
    'BT',
    '/F1 9 Tf',
    ...ops.map((op) => `1 0 0 1 ${op.x} ${op.y} Tm (${escapePdfString(op.text)}) Tj`),
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${streamContent.length} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
  ];

  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${offsets[i].toString().padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;

  const bytes = new TextEncoder().encode(pdf);
  return new File([bytes], name, { type: 'application/pdf' });
}

describe('Conversor de Extratos + Agente de I.A. Evolutivo', () => {
  it('normaliza formatos monetários brasileiros com D/C, (+)/(-), sinal posterior e parênteses', () => {
    expect(parseMonetaryValue('1.520,40 C')?.value).toBe(1520.4);
    expect(parseMonetaryValue('320,15 D')?.value).toBe(-320.15);
    expect(parseMonetaryValue('890,00 (-)')?.value).toBe(-890);
    expect(parseMonetaryValue('2.100,00 (+)')?.value).toBe(2100);
    expect(parseMonetaryValue('450,90-')?.value).toBe(-450.9);
    expect(parseMonetaryValue('- R$ 99,99')?.value).toBe(-99.99);
    expect(parseMonetaryValue('(1.234,56)')?.value).toBe(-1234.56);
    expect(readDate('05/03/2026')).toBe('2026-03-05');
    expect(readDate('2026-03-05')).toBe('2026-03-05');
  });

  it('lê extrato PDF estilo Caixa Econômica Federal (sufixos C/D + Saldo Anterior) e concilia 100%', async () => {
    const file = buildPositionedPdfFile('extrato-caixa.pdf', (text) => {
      text('CAIXA ECONOMICA FEDERAL - EXTRATO CONTA CORRENTE', 40, 40);
      text('Periodo: 01/03/2026 a 31/03/2026', 40, 56);
      text('Data Mov.', 40, 80);
      text('Nr. Doc.', 110, 80);
      text('Historico', 180, 80);
      text('Valor', 420, 80);
      text('Saldo', 510, 80);

      text('01/03/2026', 40, 100);
      text('000000', 110, 100);
      text('SALDO ANTERIOR', 180, 100);
      text('1.000,00 C', 510, 100);

      text('03/03/2026', 40, 118);
      text('102938', 110, 118);
      text('CRED PIX CLIENTE ALFA', 180, 118);
      text('2.500,00 C', 420, 118);
      text('3.500,00 C', 510, 118);

      text('05/03/2026', 40, 136);
      text('482910', 110, 136);
      text('PAG BOLETO ENERGIA', 180, 136);
      text('400,00 D', 420, 136);
      text('3.100,00 C', 510, 136);
    });

    const result = await parseUnifiedStatement(file);
    expect(result.bankName).toBe('Caixa Econômica Federal');
    expect(result.openingBalance).toBe(1000);
    expect(result.transactions).toHaveLength(2);
    expect(result.updatedModel.bankName).toBe('Caixa Econômica Federal');
    expect(result.updatedModel.accuracyScore).toBe(100);

    const rec = computeReconciliation(result.transactions, result.openingBalance);
    expect(rec.divergentDaysCount).toBe(0);
    expect(rec.calculatedClosingBalance).toBe(3100);
  });

  it('lê extrato PDF estilo Banco do Brasil com datas curtas DD/MM e sinais (+)/(-)', async () => {
    const file = buildPositionedPdfFile('extrato-bb.pdf', (text) => {
      text('BANCO DO BRASIL S.A. - SISBB', 40, 40);
      text('Periodo do extrato: 01/02/2026 a 28/02/2026', 40, 56);
      text('Data', 40, 80);
      text('Historico', 120, 80);
      text('Valor', 420, 80);
      text('Saldo', 510, 80);

      text('02/02', 40, 102);
      text('TED RECEBIDA MATRIZ', 120, 102);
      text('5.000,00 (+)', 415, 102);
      text('5.000,00 (+)', 505, 102);

      text('10/02', 40, 120);
      text('TARIFA PACOTE PJ', 120, 120);
      text('89,90 (-)', 415, 120);
      text('4.910,10 (+)', 505, 120);
    });

    const result = await parseUnifiedStatement(file);
    expect(result.bankName).toBe('Banco do Brasil');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].date).toBe('2026-02-02');
    expect(result.transactions[0].amount).toBe(5000);
    expect(result.transactions[1].date).toBe('2026-02-10');
    expect(result.transactions[1].amount).toBe(-89.9);
  });

  it('lê extrato PDF estilo Nubank com datas por extenso ("05 MAR 2026") e múltiplas transações no mesmo dia', async () => {
    const file = buildPositionedPdfFile('extrato-nubank.pdf', (text) => {
      text('Nu Pagamentos S.A. - Extrato de Conta', 40, 40);
      text('01 MAR 2026 a 31 MAR 2026', 40, 56);

      text('05 MAR 2026', 40, 90);
      text('Transferencia recebida pelo Pix - JOAO SILVA', 140, 90);
      text('1.200,00', 460, 90);

      text('Pagamento de boleto efetuado - INTERNET FIBRA', 140, 108);
      text('-149,90', 460, 108);
    });

    const result = await parseUnifiedStatement(file);
    expect(result.bankName).toBe('Nubank');
    expect(result.transactions).toHaveLength(2);
    expect(result.transactions[0].date).toBe('2026-03-05');
    expect(result.transactions[0].amount).toBe(1200);
    expect(result.transactions[1].date).toBe('2026-03-05');
    expect(result.transactions[1].amount).toBe(-149.9);
  });

  it('aprende continuamente com correções e evolui nos meses seguintes do mesmo banco', async () => {
    // Mês 1: Layout de banco regional com linha de ruído proprietária e rubrica sem sinal explícito
    const month1Pdf = buildPositionedPdfFile('banco-regional-jan.pdf', (text) => {
      text('BANCO SAFRA S.A. - EXTRATO EMPRESARIAL', 40, 40);
      text('Periodo: 01/01/2026 a 31/01/2026', 40, 56);
      text('Data', 40, 80);
      text('Historico Operacional', 120, 80);
      text('Valor', 450, 80);

      text('10/01/2026', 40, 102);
      text('RESUMO PARCIAL CARTEIRA VINCULADA', 120, 102);
      text('9.999,00', 450, 102);

      text('12/01/2026', 40, 120);
      text('LIQ COBRANCA VINCULADA 00419', 120, 120);
      text('850,00', 450, 120);

      text('15/01/2026', 40, 138);
      text('TAXA CUSTODIA ESPECIAL 8821', 120, 138);
      text('125,00', 450, 138);
    });

    const pass1 = await parseUnifiedStatement(month1Pdf);
    expect(pass1.wasKnownModel).toBe(false);
    expect(pass1.transactions).toHaveLength(3);

    // Usuário exclui a linha de resumo parcial e inverte a taxa de custódia para Débito (-)
    let memory = [pass1.updatedModel];
    memory = recordIgnoredRowInModel(memory, pass1.transactions[0]).models;
    memory = recordSignCorrectionInModel(memory, pass1.transactions[2], -125).models;

    // Mês 2: Novo PDF do mesmo banco com datas, números de contrato e valores totalmente diferentes
    const month2Pdf = buildPositionedPdfFile('banco-regional-fev.pdf', (text) => {
      text('BANCO SAFRA S.A. - EXTRATO EMPRESARIAL', 40, 40);
      text('Periodo: 01/02/2026 a 28/02/2026', 40, 56);
      text('Data', 40, 80);
      text('Historico Operacional', 120, 80);
      text('Valor', 450, 80);

      text('08/02/2026', 40, 102);
      text('RESUMO PARCIAL CARTEIRA VINCULADA', 120, 102);
      text('14.320,00', 450, 102);

      text('14/02/2026', 40, 120);
      text('LIQ COBRANCA VINCULADA 00987', 120, 120);
      text('1.400,00', 450, 120);

      text('19/02/2026', 40, 138);
      text('TAXA CUSTODIA ESPECIAL 9954', 120, 138);
      text('210,50', 450, 138);
    });

    const pass2 = await parseUnifiedStatement(month2Pdf, { learnedModels: memory });
    expect(pass2.wasKnownModel).toBe(true);
    expect(pass2.updatedModel.timesSeen).toBe(2);
    expect(pass2.transactions).toHaveLength(2);
    expect(pass2.transactions[0].amount).toBe(1400);
    expect(pass2.transactions[1].amount).toBe(-210.5);
  });

  it('auto-corrige divergência combinatória de saldo durante a leitura e memoriza o padrão', async () => {
    const trickyPdf = buildPositionedPdfFile('layout-subtotal-oculto.pdf', (text) => {
      text('SICREDI - EXTRATO CONTA CORRENTE', 40, 40);
      text('Data', 40, 80);
      text('Historico', 120, 80);
      text('Valor', 420, 80);
      text('Saldo', 510, 80);

      text('01/04/2026', 40, 100);
      text('SALDO ANTERIOR', 120, 100);
      text('1.000,00', 510, 100);

      text('04/04/2026', 40, 118);
      text('SUBTOTAL CONTA VINCULADA', 120, 118);
      text('500,00', 420, 118);

      text('04/04/2026', 40, 136);
      text('CRED PIX CPF 12345678900 CONTA CORRENTE', 120, 136);
      text('300,00', 420, 136);
      text('1.300,00', 510, 136);
    });

    const res = await parseUnifiedStatement(trickyPdf);
    expect(res.transactions).toHaveLength(1);
    expect(res.transactions[0].history).toContain('CRED PIX CPF 12345678900 CONTA CORRENTE');
    expect(res.updatedModel.ignoredPatterns).toContain('SUBTOTAL CONTA VINCULADA');
    expect(res.updatedModel.accuracyScore).toBe(100);
  });

  it('lê arquivos OFX e CSV nativamente e deduplica extratos sobrepostos sem perder transferências legítimas', async () => {
    const ofxContent = `
OFXHEADER:100
<OFX>
  <BANKMSGSRSV1>
    <STMTTRNRS>
      <STMTRS>
        <BANKACCTFROM><BANKID>0341</BANKID></BANKACCTFROM>
        <BANKTRANLIST>
          <STMTTRN>
            <TRNTYPE>CREDIT
            <DTPOSTED>20260310000000
            <TRNAMT>750.25
            <FITID>20260310001
            <MEMO>PIX RECEBIDO CLIENTE BETA
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT
            <DTPOSTED>20260310000000
            <TRNAMT>-120.00
            <FITID>20260310002
            <MEMO>PIX ENVIADO FORNECEDOR
          </STMTTRN>
          <STMTTRN>
            <TRNTYPE>DEBIT
            <DTPOSTED>20260310000000
            <TRNAMT>-120.00
            <FITID>20260310003
            <MEMO>PIX ENVIADO FORNECEDOR
          </STMTTRN>
        </BANKTRANLIST>
        <LEDGERBAL><BALAMT>510.25</BALAMT></LEDGERBAL>
      </STMTRS>
    </STMTTRNRS>
  </BANKMSGSRSV1>
</OFX>`;

    const ofxFile = new File([ofxContent], 'itau-marco.ofx', { type: 'application/x-ofx' });
    const parsedOfx = await parseUnifiedStatement(ofxFile, { sourceId: 'file-1' });
    expect(parsedOfx.transactions).toHaveLength(3);

    const csvOverlap = [
      'Data;Histórico;Valor',
      '10/03/2026;PIX RECEBIDO CLIENTE BETA;750,25',
      '12/03/2026;TARIFA BANCARIA;-29,90',
    ].join('\n');
    const csvFile = new File([csvOverlap], 'itau-complemento.csv', { type: 'text/csv' });
    const parsedCsv = await parseUnifiedStatement(csvFile, { sourceId: 'file-2' });

    const merged = mergeWithSmartDedup(parsedOfx.transactions, parsedCsv.transactions, true);
    expect(merged.duplicatesCount).toBe(1);
    expect(merged.records).toHaveLength(4);
  });
});
