import { describe, expect, it } from "vitest";
import { MockStorage } from "./mock-storage";

describe("MockStorage", () => {
  const storage = new MockStorage("greenwallet");

  it("returns purpose-scoped upload configs", () => {
    const verification = storage.getUploadConfig("VERIFICATION");
    const ticket = storage.getUploadConfig("TICKET");
    const evidence = storage.getUploadConfig("EVIDENCE");

    expect(verification.folder).toBe("greenwallet/verification");
    expect(ticket.folder).toBe("greenwallet/tickets");
    expect(evidence.folder).toBe("greenwallet/evidence");
    expect(verification.allowedFormats).toContain("pdf");
    expect(ticket.allowedFormats).toContain("docx");
    expect(evidence.allowedFormats).toContain("docx");
  });

  it("derives asset metadata from the public id", async () => {
    const asset = await storage.getAsset(
      "greenwallet/evidence/report.pdf",
      "raw"
    );

    expect(asset.format).toBe("pdf");
    expect(asset.resourceType).toBe("raw");
    expect(asset.bytes).toBeGreaterThan(0);
  });

  it("builds expiring download urls", () => {
    const download = storage.buildDownloadUrl(
      "greenwallet/tickets/contract.pdf",
      "raw",
      "pdf"
    );

    expect(download.url).toContain("signed/");
    expect(download.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts server-side uploads in the right folder", async () => {
    const asset = await storage.upload({
      purpose: "TICKET",
      publicId: "greenwallet/tickets/pdf/TICKET-1.pdf",
      buffer: Buffer.from("%PDF-1.4 mock"),
      resourceType: "raw",
      format: "pdf",
      contentType: "application/pdf"
    });

    expect(asset.format).toBe("pdf");
    expect(asset.bytes).toBeGreaterThan(0);
    expect(asset.publicId).toContain("greenwallet/tickets/");
  });

  it("rejects uploads outside the purpose folder", async () => {
    await expect(
      storage.upload({
        purpose: "TICKET",
        publicId: "other/folder/file.pdf",
        buffer: Buffer.from("x"),
        resourceType: "raw",
        format: "pdf",
        contentType: "application/pdf"
      })
    ).rejects.toThrow("storage folder");
  });
});
