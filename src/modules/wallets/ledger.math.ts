import { badRequest } from "../../common/errors";

export type LedgerEntryDraft = {
  direction: "DEBIT" | "CREDIT";
  amountMinor: bigint;
};

export function assertBalancedLedger(entries: LedgerEntryDraft[]): void {
  if (entries.length < 2) {
    throw badRequest("A ledger transaction needs at least two entries");
  }

  let debits = 0n;
  let credits = 0n;

  for (const entry of entries) {
    if (entry.amountMinor <= 0n) {
      throw badRequest("Ledger entry amounts must be positive");
    }
    if (entry.direction === "DEBIT") {
      debits += entry.amountMinor;
    } else {
      credits += entry.amountMinor;
    }
  }

  if (debits !== credits) {
    throw badRequest("Ledger transaction is not balanced");
  }
}

export function sumBasisPoints(releaseBps: number[]): number {
  return releaseBps.reduce((total, basisPoints) => total + basisPoints, 0);
}

export function allocateBasisPoints(
  totalMinor: bigint,
  releaseBps: number[]
): bigint[] {
  const totalBasisPoints = sumBasisPoints(releaseBps);
  if (releaseBps.length === 0) {
    throw badRequest("At least one milestone is required");
  }
  if (totalBasisPoints > 10_000) {
    throw badRequest("Milestone basis points cannot exceed 10000");
  }
  if (releaseBps.some((basisPoints) => basisPoints <= 0)) {
    throw badRequest("Milestone basis points must be positive");
  }

  const amounts = releaseBps.map(
    (basisPoints) => (totalMinor * BigInt(basisPoints)) / 10_000n
  );

  if (totalBasisPoints === 10_000) {
    const allocated = amounts.reduce((total, amount) => total + amount, 0n);
    const lastIndex = amounts.length - 1;
    amounts[lastIndex] = (amounts[lastIndex] ?? 0n) + (totalMinor - allocated);
  }

  return amounts;
}
