import { describe, expect, it } from "vitest";
import { AppError } from "../../common/errors";
import { normalizeDojahVerification } from "./dojah.provider";

describe("normalizeDojahVerification", () => {
  it("marks a completed verification with passing steps as PASSED", () => {
    const result = normalizeDojahVerification({
      status: true,
      verification_status: "Completed",
      data: { bvn: { status: true }, selfie: { status: true } }
    });

    expect(result.outcome).toBe("PASSED");
    expect(result.completedAt).toBeInstanceOf(Date);
    expect(result.reason).toBeNull();
  });

  it("marks a failed verification as FAILED", () => {
    const result = normalizeDojahVerification({
      status: false,
      verification_status: "Failed",
      message: "Document unreadable"
    });

    expect(result.outcome).toBe("FAILED");
    expect(result.reason).toBe("Document unreadable");
  });

  it("marks a completed verification with a failing step as FAILED", () => {
    const result = normalizeDojahVerification({
      status: true,
      verification_status: "Completed",
      data: { bvn: { status: true }, selfie: { status: false } }
    });

    expect(result.outcome).toBe("FAILED");
  });

  it("keeps an in-progress verification as PENDING", () => {
    const result = normalizeDojahVerification({
      status: false,
      verification_status: "Ongoing"
    });

    expect(result.outcome).toBe("PENDING");
    expect(result.completedAt).toBeNull();
  });

  it("rejects non-object payloads", () => {
    expect(() => normalizeDojahVerification([])).toThrow(AppError);
    expect(() => normalizeDojahVerification("nope")).toThrow(AppError);
  });
});
