import { describe, expect, it } from "vitest";
import {
  idempotencyLedgerKey,
  idempotencyScope,
  requireIdempotencyKey
} from "./idempotency";

describe("requireIdempotencyKey", () => {
  it("accepts a valid key", () => {
    expect(requireIdempotencyKey("fund-ticket-123")).toBe("fund-ticket-123");
  });

  it("accepts the first value when the header repeats", () => {
    expect(requireIdempotencyKey(["release-123", "release-456"])).toBe(
      "release-123"
    );
  });

  it("rejects missing keys", () => {
    expect(() => requireIdempotencyKey(undefined)).toThrow();
  });

  it("rejects short keys", () => {
    expect(() => requireIdempotencyKey("short")).toThrow();
  });

  it("rejects long keys", () => {
    expect(() => requireIdempotencyKey("x".repeat(201))).toThrow();
  });
});

describe("idempotencyScope", () => {
  it("hashes the request deterministically and changes with the payload", () => {
    const first = idempotencyScope({
      organizationId: "org-1",
      endpoint: "POST /fund",
      key: "key-12345",
      request: { amountMinor: "100" }
    });
    const second = idempotencyScope({
      organizationId: "org-1",
      endpoint: "POST /fund",
      key: "key-12345",
      request: { amountMinor: "100" }
    });
    const different = idempotencyScope({
      organizationId: "org-1",
      endpoint: "POST /fund",
      key: "key-12345",
      request: { amountMinor: "200" }
    });

    expect(first.requestHash).toBe(second.requestHash);
    expect(first.requestHash).not.toBe(different.requestHash);
  });

  it("derives a stable ledger key", () => {
    const scope = idempotencyScope({
      organizationId: "org-1",
      endpoint: "POST /fund",
      key: "key-12345",
      request: { amountMinor: "100" }
    });

    expect(idempotencyLedgerKey(scope)).toBe(idempotencyLedgerKey(scope));
  });
});
