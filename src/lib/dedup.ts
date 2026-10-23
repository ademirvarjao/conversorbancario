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
  const stampedExisting = stampSourceOccurrences(existing);
  const stampedIncoming = stampSourceOccurrences(incoming);

  const seenStrict = new Set<string>();
  const seenLoose = new Map<string, string>(); // key -> document number if present

  for (const tx of stampedExisting) {
    if (tx.isDuplicate) continue;
    const occ = tx.occurrenceInSource ?? 1;
    seenStrict.add(`${transactionBaseSignature(tx)}#${occ}`);
    seenLoose.set(`${fallbackSignature(tx)}#${occ}`, tx.document.trim());
  }

  let duplicatesCount = 0;
  const processedIncoming: Transaction[] = [];

  for (const tx of stampedIncoming) {
    const occ = tx.occurrenceInSource ?? 1;
    const strictKey = `${transactionBaseSignature(tx)}#${occ}`;
    const looseKey = `${fallbackSignature(tx)}#${occ}`;
    const existingDoc = seenLoose.get(looseKey);
    const incomingDoc = tx.document.trim();

    const conflictExplicitDocs =
      existingDoc !== undefined &&
      existingDoc.length > 0 &&
      incomingDoc.length > 0 &&
      existingDoc !== incomingDoc;

    const isDup =
      seenStrict.has(strictKey) || (seenLoose.has(looseKey) && !conflictExplicitDocs);

    if (isDup) {
      duplicatesCount += 1;
      if (!removeDuplicates) {
        processedIncoming.push({
          ...tx,
          isDuplicate: true,
          warnings: [
            ...new Set([
              ...tx.warnings,
              'Possível duplicidade entre períodos/arquivos sobrepostos.',
            ]),
          ],
        });
      }
    } else {
      seenStrict.add(strictKey);
      seenLoose.set(looseKey, incomingDoc);
      processedIncoming.push({ ...tx, isDuplicate: false });
    }
  }

  const combined = [...stampedExisting, ...processedIncoming].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.sourceFile.localeCompare(b.sourceFile) ||
      a.sourcePage - b.sourcePage,
  );

  return { records: combined, duplicatesCount };
}
