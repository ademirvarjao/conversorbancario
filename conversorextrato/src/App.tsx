import { useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import * as XLSX from 'xlsx';
import { amountLabel, humanDate, parseBankStatement } from './lib/bankParser';
import type { ImportedFile, ProcessSummary, Transaction } from './types';

const PAGE_SIZE = 100;

type Filter = 'all' | 'attention';
type EditableTransactionField = 'date' | 'history' | 'amount' | 'debit' | 'credit' | 'balance';
type Theme = 'dark' | 'light';

function fileKey(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function mergeUnique(existing: Transaction[], incoming: Transaction[]): { records: Transaction[]; duplicates: number } {
  const duplicateKeys = new Set(existing.map((transaction) => [transaction.date, transaction.document, transaction.amount.toFixed(2), transaction.history.toLocaleLowerCase('pt-BR')].join('|')));
  let duplicates = 0;
  for (const transaction of incoming) {
    const key = [transaction.date, transaction.document, transaction.amount.toFixed(2), transaction.history.toLocaleLowerCase('pt-BR')].join('|');
    if (duplicateKeys.has(key)) duplicates += 1;
    duplicateKeys.add(key);
  }
  const records = [...existing, ...incoming];
  return {
    records: records.sort((a, b) => a.date.localeCompare(b.date) || a.sourceFile.localeCompare(b.sourceFile) || a.sourcePage - b.sourcePage),
    duplicates,
  };
}

function formatDecimal(value: number | null): string {
  return value === null ? '' : value.toFixed(2);
}

function formatOptionalDecimal(value: number): string {
  return value === 0 ? '' : value.toFixed(2);
}

function parseEditableNumber(value: string): number | null {
  const compact = value.trim();
  if (!compact) return null;
  const normalized = compact.includes(',')
    ? compact.replace(/\./g, '').replace(',', '.')
    : compact;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function reviewWarnings(transaction: Transaction): string[] {
  const warnings = [...transaction.warnings];
  if (!isValidIsoDate(transaction.date)) warnings.push('Data inválida ou ausente; corrija antes de exportar.');
  if (!Number.isFinite(transaction.amount)) warnings.push('Valor inválido; corrija antes de exportar.');
  if (!transaction.history.trim()) warnings.push('Histórico vazio; confirme antes de exportar.');
  return [...new Set(warnings)];
}

function reviewConfidence(transaction: Transaction): number {
  return reviewWarnings(transaction).length ? Math.min(transaction.confidence, 0.66) : transaction.confidence;
}

function toExcelDate(isoDate: string): Date {
  const [year, month, day] = isoDate.split('-').map(Number);
  return new Date(year, month - 1, day);
}

function confidenceLabel(confidence: number): string {
  if (confidence >= 0.9) return 'Alta';
  if (confidence >= 0.7) return 'Média';
  return 'Atenção';
}

function confidenceClass(confidence: number): string {
  if (confidence >= 0.9) return 'status-good';
  if (confidence >= 0.7) return 'status-mid';
  return 'status-alert';
}

export default function App() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return localStorage.getItem('conversor-extrato-theme') === 'light' ? 'light' : 'dark';
    } catch {
      return 'dark';
    }
  });
  const [files, setFiles] = useState<ImportedFile[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState('');
  const [processSummary, setProcessSummary] = useState<ProcessSummary | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(0);
  const [columnFilters, setColumnFilters] = useState({ date: '', debit: '', credit: '', history: '', balance: '' });
  const [columnWidths, setColumnWidths] = useState({ date: 130, debit: 130, credit: 130, history: 460, balance: 150 });
  const [cookiesAccepted, setCookiesAccepted] = useState(() => localStorage.getItem('conversor-extrato-cookies') === 'accepted');

  const readyFiles = files.filter((file) => file.state === 'ready');
  const completeFiles = files.filter((file) => file.state === 'done');
  const hasAttention = (transaction: Transaction) => reviewConfidence(transaction) < 0.7 || reviewWarnings(transaction).length > 0;
  const filteredTransactions = useMemo(
    () => transactions.filter((transaction) => {
      const matchesStatus = filter === 'all' || hasAttention(transaction);
      const matches = (value: string | number | null, query: string) => !query || String(value ?? '').toLocaleLowerCase('pt-BR').includes(query.toLocaleLowerCase('pt-BR'));
      return matchesStatus
        && matches(transaction.date, columnFilters.date)
        && matches(transaction.debit === 0 ? '' : transaction.debit, columnFilters.debit)
        && matches(transaction.credit === 0 ? '' : transaction.credit, columnFilters.credit)
        && matches(transaction.history, columnFilters.history)
        && matches(transaction.balance, columnFilters.balance);
    }),
    [filter, transactions, columnFilters],
  );
  const pageCount = Math.max(1, Math.ceil(filteredTransactions.length / PAGE_SIZE));
  const visibleTransactions = filteredTransactions.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);
  const isEndOfDay = (transaction: Transaction) => {
    for (let index = transactions.length - 1; index >= 0; index -= 1) {
      if (transactions[index].date === transaction.date) return transactions[index] === transaction;
    }
    return false;
  };
  const credits = useMemo(() => transactions.filter((item) => item.amount > 0).reduce((sum, item) => sum + item.amount, 0), [transactions]);
  const debits = useMemo(() => transactions.filter((item) => item.amount < 0).reduce((sum, item) => sum + item.amount, 0), [transactions]);
  const attentionCount = transactions.filter(hasAttention).length;

  const acceptCookies = () => {
    localStorage.setItem('conversor-extrato-cookies', 'accepted');
    setCookiesAccepted(true);
  };

  useEffect(() => {
    if (page >= pageCount) setPage(Math.max(0, pageCount - 1));
  }, [page, pageCount]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem('conversor-extrato-theme', theme);
    } catch {
      // A preferência continua funcionando nesta sessão mesmo quando o navegador bloqueia o armazenamento.
    }
  }, [theme]);

  const addFiles = (candidateFiles: FileList | File[]) => {
    const selected = Array.from(candidateFiles);
    const pdfs = selected.filter((file) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name));
    const invalidCount = selected.length - pdfs.length;
    if (invalidCount > 0) setMessage(`${invalidCount} arquivo(s) ignorado(s): envie apenas PDFs de extrato.`);

    setFiles((current) => {
      const known = new Set(current.map((item) => fileKey(item.file)));
      const additions = pdfs
        .filter((file) => !known.has(fileKey(file)))
        .map((file) => ({
          id: crypto.randomUUID(),
          file,
          state: 'ready' as const,
          transactions: 0,
        }));
      if (additions.length === 0 && pdfs.length > 0) setMessage('Esses arquivos já estão na fila.');
      if (additions.length > 0) setMessage(`${additions.length} PDF(s) adicionado(s). Nada foi enviado para servidores.`);
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

  const removeFile = (id: string) => {
    if (processing) return;
    setFiles((current) => current.filter((item) => item.id !== id));
    setTransactions((current) => current.filter((transaction) => transaction.sourceId !== id));
    setMessage('Arquivo removido; os lançamentos dele também foram retirados da conferência.');
  };

  const processFiles = async () => {
    const queue = files.filter((file) => file.state === 'ready');
    if (!queue.length || processing) return;

    setProcessing(true);
    setMessage('Leitura inteligente local: interpretando datas, documentos e históricos…');
    let extracted: Transaction[] = [];
    let errors = 0;

    for (let index = 0; index < queue.length; index += 1) {
      const item = queue[index];
      setFiles((current) => current.map((file) => file.id === item.id ? { ...file, state: 'processing' } : file));
      try {
        const result = await parseBankStatement(item.file, (currentPage, totalPages) => {
          setMessage(`Leitura adaptativa local de ${item.file.name}: página ${currentPage} de ${totalPages}. Unificando históricos…`);
        }, item.id);
        extracted = [...extracted, ...result.transactions];
        setFiles((current) => current.map((file) => file.id === item.id
          ? { ...file, state: 'done', transactions: result.transactions.length, pages: result.pages, error: result.warnings[0] }
          : file));
      } catch (error) {
        errors += 1;
        const detail = error instanceof Error ? error.message : 'Não foi possível abrir este PDF.';
        setFiles((current) => current.map((file) => file.id === item.id
          ? { ...file, state: 'error', error: detail }
          : file));
      }
    }

    setTransactions((current) => {
      const merged = mergeUnique(current, extracted);
      setProcessSummary({
        processedFiles: queue.length,
        totalFiles: files.length,
        extracted: extracted.length,
        duplicates: merged.duplicates,
        attention: merged.records.filter(hasAttention).length,
        errors,
      });
      setMessage(errors
        ? 'Processamento concluído com arquivos que precisam de atenção. Confira a lista e a tabela.'
        : 'Processamento concluído com leitura adaptativa local. Revise os históricos antes de exportar.');
      return merged.records;
    });
    setProcessing(false);
  };

  const updateTransaction = (id: string, field: EditableTransactionField, rawValue: string) => {
    setTransactions((current) => current.map((transaction) => {
      if (transaction.id !== id) return transaction;
      if (field === 'amount' || field === 'debit' || field === 'credit') {
        const amount = parseEditableNumber(rawValue);
        if (amount === null) return transaction;
        if (field === 'debit') return { ...transaction, debit: amount, amount: transaction.credit - amount };
        if (field === 'credit') return { ...transaction, credit: amount, amount: amount - transaction.debit };
        return { ...transaction, amount, debit: amount < 0 ? Math.abs(amount) : 0, credit: amount > 0 ? amount : 0 };
      }
      if (field === 'balance') {
        return { ...transaction, balance: parseEditableNumber(rawValue) };
      }
      return { ...transaction, [field]: rawValue };
    }));
  };

  const exportXlsx = () => {
    if (!transactions.length) return;
    const invalid = transactions.filter((transaction) => !isValidIsoDate(transaction.date) || !Number.isFinite(transaction.amount) || !transaction.history.trim());
    if (invalid.length) {
      setFilter('attention');
      setPage(0);
      setMessage(`Corrija ${invalid.length} lançamento(s) com data, valor ou histórico inválido antes de exportar.`);
      return;
    }
    const rows = [
      ['Data', 'Débito', 'Crédito', 'Histórico'],
      ...transactions.map((transaction) => [
        toExcelDate(transaction.date),
        transaction.debit === 0 ? '' : transaction.debit,
        transaction.credit === 0 ? '' : transaction.credit,
        transaction.document ? `${transaction.history} · Doc. ${transaction.document}` : transaction.history,
      ]),
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(rows, { cellDates: true });
    worksheet['!cols'] = [
      { wch: 12 }, { wch: 15 }, { wch: 15 }, { wch: 56 },
    ];
    for (let row = 2; row <= transactions.length + 1; row += 1) {
      const dateCell = worksheet[`A${row}`];
      const debitCell = worksheet[`B${row}`];
      const creditCell = worksheet[`C${row}`];
      if (dateCell) dateCell.z = 'dd/mm/yyyy';
      if (debitCell) debitCell.z = 'R$ #,##0.00;[Red]-R$ #,##0.00';
      if (creditCell) creditCell.z = 'R$ #,##0.00;[Red]-R$ #,##0.00';
    }
    worksheet['!autofilter'] = { ref: `A1:D${transactions.length + 1}` };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Lançamentos');
    XLSX.writeFileXLSX(workbook, 'extrato-consolidado.xlsx');
  };

  const exportCsv = () => {
    if (!transactions.length) return;
    const invalid = transactions.filter((transaction) => !isValidIsoDate(transaction.date) || !Number.isFinite(transaction.amount) || !transaction.history.trim());
    if (invalid.length) {
      setFilter('attention');
      setPage(0);
      setMessage(`Corrija ${invalid.length} lançamento(s) com data, valor ou histórico inválido antes de exportar.`);
      return;
    }
    const escape = (value: string | number | null) => `"${String(value ?? '').replaceAll('"', '""')}"`;
    const rows = [
      ['Data', 'Débito', 'Crédito', 'Histórico'],
      ...transactions.map((transaction) => [
        humanDate(transaction.date),
        transaction.debit === 0 ? '' : transaction.debit.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        transaction.credit === 0 ? '' : transaction.credit.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        transaction.document ? `${transaction.history} · Doc. ${transaction.document}` : transaction.history,
      ]),
    ];
    const csv = `\ufeff${rows.map((row) => row.map(escape).join(';')).join('\n')}`;
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'extrato-consolidado.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="shell">
      <section className="hero" id="inicio">
        <div className="theme-actions">
          <button
            className="theme-toggle"
            type="button"
            aria-label={`Trocar para o tema ${theme === 'dark' ? 'claro' : 'escuro'}`}
            aria-pressed={theme === 'light'}
            onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}
          >
            <span aria-hidden="true">{theme === 'dark' ? '☼' : '☾'}</span>
            {theme === 'dark' ? 'Tema claro' : 'Tema escuro'}
          </button>
        </div>
        <h1>Conversor de Extrato <em>Bancário</em></h1>
        <p>Ferramenta interna para importar extratos em PDF, organizar lançamentos, unir históricos quebrados e revisar os dados antes da exportação.</p>
        <div className="flow-line" aria-label="Fluxo de três etapas">
          <span><b>01</b> Importar PDFs</span><i />
          <span><b>02</b> Ler e normalizar</span><i />
          <span><b>03</b> Conferir e exportar</span>
        </div>
      </section>

      <section className="workspace" aria-label="Conversor de extratos">
        <div className="workspace-title">
          <div><span className="section-index">01</span><h2>Arquivos de extrato</h2></div>
          <span className="file-counter">{files.length} arquivo{files.length === 1 ? '' : 's'} na fila</span>
        </div>

        <div
          className={`drop-zone ${dragging ? 'is-dragging' : ''}`}
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { event.preventDefault(); setDragging(false); }}
          onDrop={handleDrop}
        >
          <div className="upload-symbol" aria-hidden="true">↥</div>
          <div>
            <h3>Solte os PDFs aqui</h3>
            <p>Extratos de vários meses ou bancos entram em uma única conferência.</p>
          </div>
          <button className="button secondary" type="button" onClick={() => inputRef.current?.click()}>Selecionar PDFs</button>
          <input ref={inputRef} className="visually-hidden" type="file" accept="application/pdf,.pdf" multiple onChange={handleInput} />
        </div>

        {message && <p className="live-message" role="status">{message}</p>}

        {files.length > 0 && (
          <div className="file-list">
            {files.map((item) => (
              <article className="file-row" key={item.id}>
                <div className="pdf-tag">PDF</div>
                <div className="file-meta">
                  <strong>{item.file.name}</strong>
                  <span>{(item.file.size / 1024 / 1024).toFixed(2)} MB {item.pages ? `· ${item.pages} páginas` : ''} {item.transactions ? `· ${item.transactions} lançamentos` : ''}</span>
                  {item.error && <small className={item.state === 'error' ? 'error-text' : 'subtle-warning'}>{item.error}</small>}
                </div>
                <span className={`file-state state-${item.state}`}>
                  {item.state === 'ready' && 'Na fila'}
                  {item.state === 'processing' && 'Lendo…'}
                  {item.state === 'done' && 'Lido'}
                  {item.state === 'error' && 'Atenção'}
                </span>
                <button className="icon-button" type="button" aria-label={`Remover ${item.file.name}`} onClick={() => removeFile(item.id)} disabled={processing}>×</button>
              </article>
            ))}
          </div>
        )}

        <div className="action-bar">
          <div><strong>{readyFiles.length ? `${readyFiles.length} pronto(s) para ler` : completeFiles.length ? 'Todos os arquivos foram lidos' : 'Adicione pelo menos um PDF'}</strong><span>Arquivos e conteúdo permanecem nesta aba.</span></div>
          <button className="button primary" type="button" onClick={processFiles} disabled={!readyFiles.length || processing}>
            {processing ? 'Processando localmente…' : 'Ler extratos'}
          </button>
        </div>
      </section>

      {transactions.length > 0 && (
        <section className="review" aria-labelledby="review-title">
          <div className="workspace-title review-title">
            <div><span className="section-index">02</span><h2 id="review-title">Conferência antes da planilha</h2></div>
            <div className="export-actions">
              <button type="button" className="button secondary" onClick={exportCsv}>Baixar CSV</button>
              <button type="button" className="button primary" onClick={exportXlsx}>Baixar Excel</button>
            </div>
          </div>

          <div className="summary-grid">
            <div><span>Lançamentos</span><strong>{transactions.length}</strong><small>{processSummary?.duplicates ?? 0} duplicidade(s) preservada(s)</small></div>
            <div><span>Créditos</span><strong className="positive">{amountLabel(credits)}</strong><small>valores positivos identificados</small></div>
            <div><span>Débitos</span><strong className="negative">{amountLabel(debits)}</strong><small>valores negativos identificados</small></div>
            <div><span>Para conferir</span><strong className={attentionCount ? 'attention-number' : ''}>{attentionCount}</strong><small>linhas com aviso de leitura</small></div>
          </div>

          <div className="review-toolbar">
            <p><strong>Edite diretamente na tabela</strong> — os downloads refletem os ajustes feitos aqui.</p>
            <div className="filter-switch" role="group" aria-label="Filtrar lançamentos">
              <button type="button" className={filter === 'all' ? 'active' : ''} onClick={() => { setFilter('all'); setPage(0); }}>Todos ({transactions.length})</button>
              <button type="button" className={filter === 'attention' ? 'active' : ''} onClick={() => { setFilter('attention'); setPage(0); }}>Atenção ({attentionCount})</button>
            </div>
          </div>

          <div className="column-tools">
            <label>Filtrar data<input value={columnFilters.date} onChange={(event) => setColumnFilters((current) => ({ ...current, date: event.target.value }))} placeholder="AAAA-MM-DD" /></label>
            <label>Filtrar débito<input value={columnFilters.debit} onChange={(event) => setColumnFilters((current) => ({ ...current, debit: event.target.value }))} /></label>
            <label>Filtrar crédito<input value={columnFilters.credit} onChange={(event) => setColumnFilters((current) => ({ ...current, credit: event.target.value }))} /></label>
            <label className="history-filter">Filtrar histórico<input value={columnFilters.history} onChange={(event) => setColumnFilters((current) => ({ ...current, history: event.target.value }))} /></label>
            <label>Filtrar saldo<input value={columnFilters.balance} onChange={(event) => setColumnFilters((current) => ({ ...current, balance: event.target.value }))} /></label>
          </div>
          <details className="resize-tools"><summary>Redimensionar colunas</summary><div>
            {(['date', 'debit', 'credit', 'history', 'balance'] as const).map((column) => <label key={column}>{column === 'history' ? 'Histórico' : column === 'balance' ? 'Saldo' : column[0].toUpperCase() + column.slice(1)}<input type="range" min={90} max={620} value={columnWidths[column]} onChange={(event) => setColumnWidths((current) => ({ ...current, [column]: Number(event.target.value) }))} /></label>)}
          </div></details>

          <div className="table-frame">
            <table>
              <colgroup><col style={{ width: columnWidths.date }} /><col style={{ width: columnWidths.debit }} /><col style={{ width: columnWidths.credit }} /><col style={{ width: columnWidths.history }} /><col style={{ width: columnWidths.balance }} /></colgroup>
              <thead><tr><th>Data</th><th>Débito</th><th>Crédito</th><th>Histórico</th><th>Saldo conf.</th></tr></thead>
              <tbody>
                {visibleTransactions.map((transaction) => {
                  const warnings = reviewWarnings(transaction);
                  const confidence = reviewConfidence(transaction);
                  return (
                  <tr key={transaction.id} className={hasAttention(transaction) ? 'needs-review' : ''}>
                    <td><input aria-label="Data" type="date" value={transaction.date} onChange={(event) => updateTransaction(transaction.id, 'date', event.target.value)} /></td>
                    <td><input aria-label="Débito" className="input-negative" inputMode="decimal" value={formatOptionalDecimal(transaction.debit)} onChange={(event) => updateTransaction(transaction.id, 'debit', event.target.value)} /></td>
                    <td><input aria-label="Crédito" className="input-positive" inputMode="decimal" value={formatOptionalDecimal(transaction.credit)} onChange={(event) => updateTransaction(transaction.id, 'credit', event.target.value)} /></td>
                    <td className="history-cell"><input aria-label="Histórico" value={transaction.document ? `${transaction.history} · Doc. ${transaction.document}` : transaction.history} onChange={(event) => updateTransaction(transaction.id, 'history', event.target.value)} />{warnings[0] && <small title={warnings.join(' ')}>{warnings[0]}</small>}</td>
                    <td>{isEndOfDay(transaction) && <input aria-label="Saldo para conferência" inputMode="decimal" value={formatDecimal(transaction.balance)} onChange={(event) => updateTransaction(transaction.id, 'balance', event.target.value)} />}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="pagination">
            <span>Mostrando {filteredTransactions.length ? page * PAGE_SIZE + 1 : 0}–{Math.min((page + 1) * PAGE_SIZE, filteredTransactions.length)} de {filteredTransactions.length} lançamento(s)</span>
            <div><button type="button" onClick={() => setPage((value) => Math.max(0, value - 1))} disabled={page === 0}>Anterior</button><span>Página {page + 1} de {pageCount}</span><button type="button" onClick={() => setPage((value) => Math.min(pageCount - 1, value + 1))} disabled={page + 1 >= pageCount}>Próxima</button></div>
          </div>
        </section>
      )}

      <footer>Feito por Ademir Varjão</footer>
      {!cookiesAccepted && <aside className="cookie-notice" role="dialog" aria-label="Aviso de cookies"><strong>Uso de cookies</strong><span>Usamos apenas armazenamento local para guardar tema, filtros e preferências desta ferramenta. Os PDFs permanecem no navegador.</span><button type="button" className="button primary" onClick={acceptCookies}>Entendi</button></aside>}
    </main>
  );
}
