import { describe, expect, it } from "vitest";
import {
  parseExpectedTotal,
  parseMinorAmount
} from "./ticket.service";

describe("ticket minor amounts", () => {
  it("accepts an exact total that does not equal quantity x rounded unit price", () => {
    const total = parseMinorAmount("10000", "expectedTotalMinor");
    const roundedUnit = parseMinorAmount("3333", "unitPriceMinor");

    expect(total).toBe(10_000n);
    expect(roundedUnit).toBe(3_333n);
    expect(roundedUnit * 3n).not.toBe(total);
  });

  it("rejects decimal, signed, or zero totals", () => {
    expect(() => parseMinorAmount("100.50", "expectedTotalMinor")).toThrow(
      /integer amount in minor units/
    );
    expect(() => parseMinorAmount("-100", "expectedTotalMinor")).toThrow(
      /integer amount in minor units/
    );
    expect(() => parseMinorAmount("0", "expectedTotalMinor")).toThrow(
      /greater than zero/
    );
  });

  it("requires an expected total when the amount changes", () => {
    expect(() => parseExpectedTotal(undefined, true)).toThrow(
      /expectedTotalMinor is required/
    );
    expect(parseExpectedTotal(undefined, false)).toBeNull();
  });

  it("returns the provided total unchanged", () => {
    expect(parseExpectedTotal("100000", true)).toBe(100_000n);
  });
});
