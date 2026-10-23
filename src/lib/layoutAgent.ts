import type {
  AiProviderConfig,
  AutoRepairFix,
  LearnedColumns,
  LearnedLayoutModel,
  LearningEvent,
  ReconciliationSummary,
  Transaction,
} from '../types';

const LS_MODELS_KEY = 'conversor-extratos-layout-models-v1';
const LS_EVENTS_KEY = 'conversor-extratos-ai-events-v1';
const LS_AI_CONFIG_KEY = 'conversor-extratos-ai-provider-v1';
const IDB_NAME = 'conversor_extratos_ai_memory';
const IDB_STORE = 'kv';

export function extractReusablePatternStem(text: string): string {
  const cleaned = text
    .replace(/\b\d{1,2}[/.-]\d{1,2}(?:[/.-]\d{2,4})?\b/g, ' ')
    .replace(/\b(?:doc(?:umento)?\.?|nr\.?|lote|aut|cpf|cnpj|nf)\s*[:#-]?\s*[\d./-]+/gi, ' ')
    .replace(/\b[\d./-]{3,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const words = cleaned.split(' ').filter((w) => w.length >= 2);
  const stem = words.slice(0, 4).join(' ').trim();
  return stem.length >= 3 ? stem.toUpperCase() : text.trim().slice(0, 32).toUpperCase();
}

function openMemoryDb(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function idbSet(key: string, value: unknown): Promise<void> {
  const db = await openMemoryDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openMemoryDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

export function loadModelsSync(): LearnedLayoutModel[] {
  try {
    const raw = localStorage.getItem(LS_MODELS_KEY);
    return raw ? (JSON.parse(raw) as LearnedLayoutModel[]) : [];
  } catch {
    return [];
  }
}

export function loadEventsSync(): LearningEvent[] {
  try {
    const raw = localStorage.getItem(LS_EVENTS_KEY);
    return raw ? (JSON.parse(raw) as LearningEvent[]) : [];
  } catch {
    return [];
  }
}

export async function hydrateMemoryFromIndexedDb(): Promise<{
  models: LearnedLayoutModel[];
  events: LearningEvent[];
}> {
  const [idbModels, idbEvents] = await Promise.all([
    idbGet<LearnedLayoutModel[]>('models'),
    idbGet<LearningEvent[]>('events'),
  ]);
  const lsModels = loadModelsSync();
  const lsEvents = loadEventsSync();
  return {
    models: (idbModels && idbModels.length >= lsModels.length ? idbModels : lsModels) ?? [],
    events: (idbEvents && idbEvents.length >= lsEvents.length ? idbEvents : lsEvents) ?? [],
  };
}

export function persistMemory(models: LearnedLayoutModel[], events: LearningEvent[]): void {
  const trimmedEvents = events.slice(0, 60);
  try {
    localStorage.setItem(LS_MODELS_KEY, JSON.stringify(models));
    localStorage.setItem(LS_EVENTS_KEY, JSON.stringify(trimmedEvents));
  } catch {
    // Ignore storage quota issues; IndexedDB handles larger payloads below
  }
  void idbSet('models', models);
  void idbSet('events', trimmedEvents);
}

export function loadAiConfig(): AiProviderConfig | null {
  try {
    const raw = localStorage.getItem(LS_AI_CONFIG_KEY);
    return raw ? (JSON.parse(raw) as AiProviderConfig) : null;
  } catch {
    return null;
  }
}

export function saveAiConfig(config: AiProviderConfig | null): void {
  try {
    if (!config || !config.apiKey.trim()) {
      localStorage.removeItem(LS_AI_CONFIG_KEY);
    } else {
      localStorage.setItem(LS_AI_CONFIG_KEY, JSON.stringify(config));
    }
  } catch {
    // Ignore storage error
  }
}

export function normalizeHeaderTokens(headerLines: string[]): string[] {
  const stopWords = new Set(['de', 'da', 'do', 'em', 'para', 'por', 'a', 'o', 'e']);
  const tokens = new Set<string>();

  for (const line of headerLines.slice(0, 20)) {
    const clean = line
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\b\d+\b/g, '')
      .replace(/[^a-z\s]/g, ' ');

    for (const word of clean.split(/\s+/)) {
      if (word.length >= 3 && !stopWords.has(word) && tokens.size < 24) {
        tokens.add(word);
      }
    }
  }

  return Array.from(tokens).sort();
}

export function computeLayoutFingerprint(
  bankName: string,
  headerTokens: string[],
  dateStyle: LearnedLayoutModel['dateStyle'],
  signStyle: LearnedLayoutModel['signStyle'],
): string {
  const base = `${bankName.toLowerCase()}|${dateStyle}|${signStyle}|${headerTokens.slice(0, 12).join(',')}`;
  let hash = 2166136261;
  for (let i = 0; i < base.length; i += 1) {
    hash ^= base.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `layout-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0.5;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection += 1;
  }
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}

function columnSimilarity(a: LearnedColumns, b: LearnedColumns): number {
  const pairs: Array<[number | undefined, number | undefined]> = [
    [a.amountX, b.amountX],
    [a.debitX, b.debitX],
    [a.creditX, b.creditX],
    [a.balanceX, b.balanceX],
  ];
  const comparable = pairs.filter(([x, y]) => x !== undefined && y !== undefined) as Array<
    [number, number]
  >;
  if (comparable.length === 0) return 0.5;
  const avgDiff =
    comparable.reduce((sum, [x, y]) => sum + Math.abs(x - y), 0) / comparable.length;
  return Math.max(0, 1 - avgDiff / 140);
}

export function findMatchingLayoutModel(
  models: LearnedLayoutModel[],
  bankName: string,
  headerTokens: string[],
  dateStyle: LearnedLayoutModel['dateStyle'],
  signStyle: LearnedLayoutModel['signStyle'],
  columns: LearnedColumns,
): { model: LearnedLayoutModel | null; similarity: number } {
  const exactFp = computeLayoutFingerprint(bankName, headerTokens, dateStyle, signStyle);
  const direct = models.find((m) => m.fingerprint === exactFp);
  if (direct) return { model: direct, similarity: 1 };

  let bestModel: LearnedLayoutModel | null = null;
  let bestScore = 0;

  for (const candidate of models) {
    let score = 0;
    if (candidate.bankName === bankName && bankName !== 'Extrato Bancário') {
      score += 0.42;
    } else if (candidate.bankName === bankName) {
      score += 0.18;
    }
    score += tokenSimilarity(candidate.headerTokens, headerTokens) * 0.36;
    score += columnSimilarity(candidate.columns, columns) * 0.14;
    if (candidate.dateStyle === dateStyle) score += 0.04;
    if (candidate.signStyle === signStyle) score += 0.04;

    if (score > bestScore) {
      bestScore = score;
      bestModel = candidate;
    }
  }

  return bestScore >= 0.62 ? { model: bestModel, similarity: bestScore } : { model: null, similarity: bestScore };
}

export function blendColumns(existing: LearnedColumns, incoming: LearnedColumns): LearnedColumns {
  const ema = (oldVal?: number, newVal?: number) => {
    if (oldVal !== undefined && newVal !== undefined) {
      return Math.round(oldVal * 0.65 + newVal * 0.35);
    }
    return newVal ?? oldVal;
  };
  return {
    dateX: ema(existing.dateX, incoming.dateX),
    debitX: ema(existing.debitX, incoming.debitX),
    creditX: ema(existing.creditX, incoming.creditX),
    amountX: ema(existing.amountX, incoming.amountX),
    balanceX: ema(existing.balanceX, incoming.balanceX),
    maxLineGapY: ema(existing.maxLineGapY, incoming.maxLineGapY),
  };
}

export function upsertModelInList(
  models: LearnedLayoutModel[],
  updated: LearnedLayoutModel,
): LearnedLayoutModel[] {
  const exists = models.some((m) => m.id === updated.id);
  const next = exists
    ? models.map((m) => (m.id === updated.id ? updated : m))
    : [updated, ...models];
  return next.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function recordSignCorrectionInModel(
  models: LearnedLayoutModel[],
  tx: Transaction,
  newAmount: number,
): { models: LearnedLayoutModel[]; event: LearningEvent | null } {
  const stem = extractReusablePatternStem(tx.history);
  if (!stem || newAmount === 0) return { models, event: null };

  const targetModel =
    models.find((m) => m.id === tx.layoutModelId) ??
    models.find((m) => m.bankName === tx.sourceBank) ??
    models[0];

  if (!targetModel) return { models, event: null };

  const isCredit = newAmount > 0;
  const creditKeywords = isCredit
    ? [...new Set([stem, ...targetModel.creditKeywords])]
    : targetModel.creditKeywords.filter((k) => k !== stem);
  const debitKeywords = !isCredit
    ? [...new Set([stem, ...targetModel.debitKeywords])]
    : targetModel.debitKeywords.filter((k) => k !== stem);

  const updated: LearnedLayoutModel = {
    ...targetModel,
    creditKeywords,
    debitKeywords,
    updatedAt: new Date().toISOString(),
  };

  return {
    models: upsertModelInList(models, updated),
    event: {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      modelName: updated.name,
      kind: 'learned-sign',
      detail: `Padrão "${stem}" salvo como ${isCredit ? 'CRÉDITO (+)' : 'DÉBITO (-)'} no modelo ${updated.name}.`,
    },
  };
}

export function recordIgnoredRowInModel(
  models: LearnedLayoutModel[],
  tx: Transaction,
): { models: LearnedLayoutModel[]; event: LearningEvent | null } {
  const stem = extractReusablePatternStem(tx.history);
  if (!stem || stem.length < 4) return { models, event: null };

  const targetModel =
    models.find((m) => m.id === tx.layoutModelId) ??
    models.find((m) => m.bankName === tx.sourceBank) ??
    models[0];

  if (!targetModel) return { models, event: null };

  const updated: LearnedLayoutModel = {
    ...targetModel,
    ignoredPatterns: [...new Set([stem, ...targetModel.ignoredPatterns])],
    updatedAt: new Date().toISOString(),
  };

  return {
    models: upsertModelInList(models, updated),
    event: {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      modelName: updated.name,
      kind: 'learned-ignore',
      detail: `Ruído/subtotal "${stem}" memorizado para ser ignorado automaticamente nos próximos extratos de ${updated.name}.`,
    },
  };
}

/**
 * Combinatorial Balance Auditor:
 * Examines each day with a balance discrepancy (expectedClosing != reportedClosing)
 * and searches for exact 1-row/2-row sign inversions or noise/subtotal lines that explain the exact delta to the cent.
 */
export function diagnoseAndSolveDivergences(
  transactions: Transaction[],
  reconciliation: ReconciliationSummary,
): AutoRepairFix[] {
  const fixes: AutoRepairFix[] = [];
  if (reconciliation.divergentDaysCount === 0) return fixes;

  const byDate = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const arr = byDate.get(tx.date) ?? [];
    arr.push(tx);
    byDate.set(tx.date, arr);
  }

  // Note: fixing day D changes opening balance of day D+1 unless day D had its own anchor!
  // So we compute exact per-day delta comparing day's net movement against previous reported closing -> current reported closing!
  let prevKnownClosing = reconciliation.inferredOpeningBalance;

  for (const day of reconciliation.days) {
    const dayTxs = byDate.get(day.date) ?? [];
    if (prevKnownClosing !== null && day.reportedClosing !== null && dayTxs.length > 0) {
      const actualNetNeeded = Math.round((day.reportedClosing - prevKnownClosing) * 100) / 100;
      const currentNet = Math.round(dayTxs.reduce((s, t) => s + t.amount, 0) * 100) / 100;
      const diff = Math.round((currentNet - actualNetNeeded) * 100) / 100;

      if (Math.abs(diff) > 0.02) {
        let solved = false;

        // Check 1: Single inverted sign -> flipping tx changes sum by -2 * tx.amount, so we want 2 * tx.amount === diff
        for (const tx of dayTxs) {
          if (Math.abs(2 * tx.amount - diff) <= 0.02) {
            fixes.push({
              transactionId: tx.id,
              action: 'invert-sign',
              date: tx.date,
              history: tx.history,
              oldAmount: tx.amount,
              newAmount: -tx.amount,
              reason: `Inversão exata detectada pela soma do dia (${tx.amount > 0 ? 'Crédito → Débito' : 'Débito → Crédito'} fecha o saldo de ${day.date} com erro R$ 0,00).`,
            });
            solved = true;
            break;
          }
        }

        // Check 2: Single subtotal/noise line included -> removing tx changes sum by -tx.amount, so tx.amount === diff
        if (!solved && dayTxs.length > 1) {
          for (const tx of dayTxs) {
            if (Math.abs(tx.amount - diff) <= 0.02) {
              fixes.push({
                transactionId: tx.id,
                action: 'remove-noise',
                date: tx.date,
                history: tx.history,
                oldAmount: tx.amount,
                newAmount: 0,
                reason: `Linha excedente/subtotal detectada (${tx.history}): sua remoção concilia exatamente o saldo de ${day.date}.`,
              });
              solved = true;
              break;
            }
          }
        }

        // Check 3: Two inverted signs on the same day -> 2 * (txA.amount + txB.amount) === diff
        if (!solved && dayTxs.length >= 2 && dayTxs.length <= 25) {
          for (let i = 0; i < dayTxs.length && !solved; i += 1) {
            for (let j = i + 1; j < dayTxs.length; j += 1) {
              if (Math.abs(2 * (dayTxs[i].amount + dayTxs[j].amount) - diff) <= 0.02) {
                for (const target of [dayTxs[i], dayTxs[j]]) {
                  fixes.push({
                    transactionId: target.id,
                    action: 'invert-sign',
                    date: target.date,
                    history: target.history,
                    oldAmount: target.amount,
                    newAmount: -target.amount,
                    reason: `Par de sinais invertidos identificado matematicamente no fechamento de ${day.date}.`,
                  });
                }
                solved = true;
                break;
              }
            }
          }
        }
      }
    }

    if (day.reportedClosing !== null) {
      prevKnownClosing = day.reportedClosing;
    } else if (prevKnownClosing !== null) {
      prevKnownClosing = Math.round((prevKnownClosing + day.netChange) * 100) / 100;
    }
  }

  return fixes;
}

export function exportMemoryPayload(models: LearnedLayoutModel[], events: LearningEvent[]): string {
  return JSON.stringify(
    {
      schema: 'conversor-de-extratos-ai-memory',
      version: 1,
      exportedAt: new Date().toISOString(),
      models,
      events,
    },
    null,
    2,
  );
}

export function parseImportedMemoryPayload(raw: string): {
  models: LearnedLayoutModel[];
  events: LearningEvent[];
} {
  const data = JSON.parse(raw) as {
    models?: LearnedLayoutModel[];
    events?: LearningEvent[];
  };
  if (!Array.isArray(data.models)) {
    throw new Error('Arquivo JSON inválido: lista de modelos não encontrada.');
  }
  return {
    models: data.models,
    events: Array.isArray(data.events) ? data.events : [],
  };
}

export async function queryExternalAiForRawLines(
  rawLines: string[],
  config: AiProviderConfig,
): Promise<{
  bankName?: string;
  transactions: Array<{
    date: string;
    document: string;
    history: string;
    amount: number;
    balance: number | null;
  }>;
  creditKeywords: string[];
  debitKeywords: string[];
  ignoredPatterns: string[];
}> {
  const systemPrompt = `Você é um especialista contábil em extratos bancários brasileiros de qualquer layout.
Analise as linhas brutas extraídas de um extrato e retorne APENAS um JSON válido (sem markdown) no formato:
{
  "bankName": "Nome do Banco",
  "creditKeywords": ["TERMO CREDITO 1"],
  "debitKeywords": ["TERMO DEBITO 1"],
  "ignoredPatterns": ["CABECALHO OU SUBTOTAL"],
  "transactions": [
    { "date": "YYYY-MM-DD", "document": "", "history": "HISTORICO UNIFICADO", "amount": -123.45, "balance": 1000.00 }
  ]
}
Regras estritas:
- Débitos/saídas DEVEM ter "amount" negativo; créditos/entradas DEVEM ter "amount" positivo.
- Una descrições quebradas em múltiplas linhas e ignore cabeçalhos, rodapés, saldo anterior e saldo do dia.
- Use null em "balance" quando a linha não trouxer saldo.`;

  const sampleText = rawLines.slice(0, 350).join('\n');

  if (config.provider === 'gemini') {
    const modelName = config.model.trim() || 'gemini-2.5-flash';
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        modelName,
      )}:generateContent?key=${encodeURIComponent(config.apiKey.trim())}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${systemPrompt}\n\nLINHAS DO EXTRATO:\n${sampleText}` }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 },
        }),
      },
    );
    if (!resp.ok) {
      throw new Error(`Falha na API Gemini (${resp.status}). Verifique a chave configurada.`);
    }
    const json = (await resp.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';
    return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
  }

  const endpoint =
    config.provider === 'openrouter'
      ? 'https://openrouter.ai/api/v1/chat/completions'
      : 'https://api.openai.com/v1/chat/completions';
  const modelName =
    config.model.trim() ||
    (config.provider === 'openrouter' ? 'google/gemini-2.5-flash' : 'gpt-4o-mini');

  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey.trim()}`,
    },
    body: JSON.stringify({
      model: modelName,
      temperature: 0.1,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: sampleText },
      ],
    }),
  });
  if (!resp.ok) {
    throw new Error(`Falha na API de I.A. (${resp.status}). Verifique sua chave e modelo.`);
  }
  const json = (await resp.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = json.choices?.[0]?.message?.content ?? '{}';
  return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
}
