import { createHash } from "node:crypto";
import { badRequest } from "../common/errors";
import type {
  FundTicketInput,
  OrgRef,
  PaymentPort,
  PaymentResult,
  ReleaseMilestoneInput,
  WebhookEvent
} from "./payment-port";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export class MockProvider implements PaymentPort {
  async ensureWallet(org: OrgRef): Promise<{ providerWalletId: string }> {
    return {
      providerWalletId: `mock-wallet-${digest(org.organizationId)}`
    };
  }

  async fundTicket(input: FundTicketInput): Promise<PaymentResult> {
    return {
      providerRef: `mock-fund-${digest(input.idempotencyKey)}`,
      status: "SUCCEEDED"
    };
  }

  async releaseMilestone(
    input: ReleaseMilestoneInput
  ): Promise<PaymentResult> {
    return {
      providerRef: `mock-release-${digest(input.idempotencyKey)}`,
      status: "SUCCEEDED"
    };
  }

  async getTransaction(providerRef: string): Promise<PaymentResult> {
    return { providerRef, status: "SUCCEEDED" };
  }

  verifyWebhook(
    _headers: Record<string, string>,
    rawBody: Buffer
  ): WebhookEvent {
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      throw badRequest("Invalid webhook payload");
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      Array.isArray(payload)
    ) {
      throw badRequest("Invalid webhook payload");
    }

    const record = payload as Record<string, unknown>;
    if (
      typeof record.eventId !== "string" ||
      typeof record.type !== "string"
    ) {
      throw badRequest("Webhook payload requires eventId and type");
    }

    return {
      eventId: record.eventId,
      type: record.type,
      payload
    };
  }
}
