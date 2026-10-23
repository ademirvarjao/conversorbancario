import type { DayReconciliation, ReconciliationSummary, Transaction } from '../types';

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeReconciliation(
  transactions: Transaction[],
  explicitOpeningBalance: number | null = null,
): ReconciliationSummary {
  const endOfDayRowIds = new Set<string>();
  const divergentRowIds = new Set<string>();
  const rowCalculatedBalance: Record<string, number | null> = {};
  const dayDeltaByRowId: Record<string, number> = {};

  if (transactions.length === 0) {
    return {
      days: [],
      inferredOpeningBalance: explicitOpeningBalance,
      calculatedClosingBalance: explicitOpeningBalance,
      reportedClosingBalance: null,
      totalDelta: null,
      divergentDaysCount: 0,
      checkedDaysCount: 0,
      rowCalculatedBalance,
      endOfDayRowIds,
      divergentRowIds,
      dayDeltaByRowId,
    };
  }

  // Group transactions by date preserving current array order
  const dayGroups = new Map<string, Transaction[]>();
  for (const tx of transactions) {
    const bucket = dayGroups.get(tx.date);
    if (bucket) bucket.push(tx);
    else dayGroups.set(tx.date, [tx]);
  }

  // Infer opening balance if not explicitly provided:
  // If the first transaction (or end of first day) has a reported balance, opening = balance - cumulative amount up to that row!
  let openingBalance: number | null = explicitOpeningBalance;
  if (openingBalance === null) {
    let runningBeforeAnchor = 0;
    for (const tx of transactions) {
      runningBeforeAnchor = roundCents(runningBeforeAnchor + (Number.isFinite(tx.amount) ? tx.amount : 0));
      if (tx.balance !== null && Number.isFinite(tx.balance)) {
        openingBalance = roundCents(tx.balance - runningBeforeAnchor);
        break;
      }
    }
  }

  let runningBalance = openingBalance;
  const days: DayReconciliation[] = [];
  let divergentDaysCount = 0;
  let checkedDaysCount = 0;
  let lastReportedBalance: number | null = null;

  for (const [date, dayTxs] of dayGroups.entries()) {
    const dayOpening = runningBalance;
    let credits = 0;
    let debits = 0;
    let reportedClosing: number | null = null;

    for (const tx of dayTxs) {
      const amt = Number.isFinite(tx.amount) ? tx.amount : 0;
      if (amt > 0) credits = roundCents(credits + amt);
      if (amt < 0) debits = roundCents(debits + Math.abs(amt));
      if (runningBalance !== null) {
        runningBalance = roundCents(runningBalance + amt);
      }
      rowCalculatedBalance[tx.id] = runningBalance;
      if (tx.balance !== null && Number.isFinite(tx.balance)) {
        reportedClosing = tx.balance;
        lastReportedBalance = tx.balance;
      }
    }

    const lastTx = dayTxs[dayTxs.length - 1];
    endOfDayRowIds.add(lastTx.id);

    const netChange = roundCents(credits - debits);
    const expectedClosing = dayOpening !== null ? roundCents(dayOpening + netChange) : null;
    let delta: number | null = null;
    let reconciled: boolean | null = null;

    if (expectedClosing !== null && reportedClosing !== null) {
      delta = roundCents(expectedClosing - reportedClosing);
      reconciled = Math.abs(delta) <= 0.02;
      checkedDaysCount += 1;
      dayDeltaByRowId[lastTx.id] = delta;
      if (!reconciled) {
        divergentDaysCount += 1;
        divergentRowIds.add(lastTx.id);
      }
    }

    days.push({
      date,
      openingBalance: dayOpening,
      credits,
      debits,
      netChange,
      expectedClosing,
      reportedClosing,
      delta,
      reconciled,
      lastTransactionId: lastTx.id,
      count: dayTxs.length,
    });
  }

  const totalDelta =
    runningBalance !== null && lastReportedBalance !== null
      ? roundCents(runningBalance - lastReportedBalance)
      : null;

  return {
    days,
    inferredOpeningBalance: openingBalance,
    calculatedClosingBalance: runningBalance,
    reportedClosingBalance: lastReportedBalance,
    totalDelta,
    divergentDaysCount,
    checkedDaysCount,
    rowCalculatedBalance,
    endOfDayRowIds,
    divergentRowIds,
    dayDeltaByRowId,
  };
}
