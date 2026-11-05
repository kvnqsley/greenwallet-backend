import { describe, expect, it } from "vitest";
import {
  allocateBasisPoints,
  assertBalancedLedger,
  sumBasisPoints
} from "./ledger.math";

describe("assertBalancedLedger", () => {
  it("accepts a balanced transaction", () => {
    expect(() =>
      assertBalancedLedger([
        { direction: "DEBIT", amountMinor: 500n },
        { direction: "CREDIT", amountMinor: 500n }
      ])
    ).not.toThrow();
  });

  it("rejects unbalanced transactions", () => {
    expect(() =>
      assertBalancedLedger([
        { direction: "DEBIT", amountMinor: 500n },
        { direction: "CREDIT", amountMinor: 400n }
      ])
    ).toThrow();
  });

  it("rejects non-positive amounts", () => {
    expect(() =>
      assertBalancedLedger([
        { direction: "DEBIT", amountMinor: 0n },
        { direction: "CREDIT", amountMinor: 0n }
      ])
    ).toThrow();
  });

  it("requires at least two entries", () => {
    expect(() =>
      assertBalancedLedger([{ direction: "DEBIT", amountMinor: 1n }])
    ).toThrow();
  });
});

describe("allocateBasisPoints", () => {
  it("allocates exact basis points", () => {
    expect(
      allocateBasisPoints(3_600_000n, [3_333, 3_333, 3_334])
    ).toEqual([1_199_880n, 1_199_880n, 1_200_240n]);
  });

  it("gives the remainder to the last milestone", () => {
    expect(allocateBasisPoints(100n, [3_333, 3_333, 3_334])).toEqual([
      33n,
      33n,
      34n
    ]);
  });

  it("does not redistribute when basis points are below 10000", () => {
    expect(allocateBasisPoints(100_000n, [5_000, 3_000])).toEqual([
      50_000n,
      30_000n
    ]);
  });

  it("rejects totals above 10000", () => {
    expect(() => allocateBasisPoints(100n, [6_000, 5_000])).toThrow();
  });

  it("rejects non-positive basis points", () => {
    expect(() => allocateBasisPoints(100n, [10_000, 0])).toThrow();
  });

  it("requires at least one milestone", () => {
    expect(() => allocateBasisPoints(100n, [])).toThrow();
  });
});

describe("sumBasisPoints", () => {
  it("sums basis points", () => {
    expect(sumBasisPoints([2_500, 2_500, 5_000])).toBe(10_000);
  });
});
