import type { Transaction } from '../types';

function canonicalHistory(history: string): string {
  return history
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function transactionBaseSignature(transaction: Transaction): string {
  const balancePart = transaction.balance !== null ? transaction.balance.toFixed(2) : 'na';
  return [
    transaction.date,
    transaction.document.trim(),
    transaction.amount.toFixed(2),
    canonicalHistory(transaction.history),
    balancePart,
  ].join('|');
}

export function fallbackSignature(transaction: Transaction): string {
  return [
    transaction.date,
    transaction.document.trim(),
    transaction.amount.toFixed(2),
    canonicalHistory(transaction.history),
  ].join('|');
}

export function stampSourceOccurrences(transactions: Transaction[]): Transaction[] {
  const counts = new Map<string, number>();
  return transactions.map((transaction) => {
    const key = fallbackSignature(transaction);
    const next = (counts.get(key) ?? 0) + 1;
    counts.set(key, next);
    return { ...transaction, occurrenceInSource: next };
  });
}

export function mergeWithSmartDedup(
  existing: Transaction[],
  incoming: Transaction[],
  removeDuplicates = true,
): { records: Transaction[]; duplicatesCount: number } {
  const stampedIncoming = stampSourceOccurrences(incoming);

  // Within existing list, register every unique (signature + intra-file occurrence index)
  const seenKeys = new Set<string>();
  const registerTx = (tx: Transaction) => {
    const occ = tx.occurrenceInSource ?? 1;
    seenKeys.add(`${transactionBaseSignature(tx)}#${occ}`);
    seenKeys.add(`fb:${fallbackSignature(tx)}#${occ}`);
  };

  for (const tx of existing) {
    if (!tx.isDuplicate) registerTx(tx);
  }

  let duplicatesCount = 0;
  const processedIncoming: Transaction[] = [];

  for (const tx of stampedIncoming) {
    const occ = tx.occurrenceInSource ?? 1;
    const strictKey = `${transactionBaseSignature(tx)}#${occ}`;
    const looseKey = `fb:${fallbackSignature(tx)}#${occ}`;
    const isDup = seenKeys.has(strictKey) || seenKeys.has(looseKey);

    if (isDup) {
      duplicatesCount += 1;
      if (!removeDuplicates) {
        processedIncoming.push({
          ...tx,
          isDuplicate: true,
          warnings: [...new Set([...tx.warnings, 'Possível duplicidade entre períodos/arquivos sobrepostos.'])],
        });
      }
    } else {
      seenKeys.add(strictKey);
      seenKeys.add(looseKey);
      processedIncoming.push({ ...tx, isDuplicate: false });
    }
  }

  const combined = [...existing, ...processedIncoming].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      a.sourcePage - b.sourcePage,
  );

  return { records: combined, duplicatesCount };
}
