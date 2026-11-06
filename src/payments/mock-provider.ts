import { createHash } from "node:crypto";
import { badRequest } from "../common/errors";
import type {
  Bank,
  ChargeInitialization,
  ChargeVerification,
  CreateRecipientInput,
  InitializeChargeInput,
  InitiateTransferInput,
  PaymentPort,
  PaymentResult,
  ResolvedAccount,
  TransactionKind,
  TransferInitialization,
  TransferVerification,
  WebhookEvent
} from "./payment-port";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export class MockProvider implements PaymentPort {
  async initializeCharge(
    input: InitializeChargeInput
  ): Promise<ChargeInitialization> {
    return {
      providerRef: input.reference,
      status: "SUCCEEDED",
      authorizationUrl: `mock://checkout/${encodeURIComponent(input.reference)}`,
      accessCode: `mock_access_${digest(input.reference)}`
    };
  }

  async verifyCharge(reference: string): Promise<ChargeVerification> {
    return {
      providerRef: reference,
      status: "SUCCEEDED",
      amountMinor: 0n,
      currency: "NGN",
      transactionId: `mock-txn-${digest(reference)}`,
      channel: "mock",
      paidAt: new Date(),
      failureReason: null,
      metadata: {}
    };
  }

  async listBanks(): Promise<Bank[]> {
    return [
      { id: 1, name: "Mock Bank", code: "000" },
      { id: 2, name: "Test Microfinance Bank", code: "001" }
    ];
  }

  async resolveAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<ResolvedAccount> {
    return {
      accountName: "Mock Account Holder",
      accountNumber: input.accountNumber
    };
  }

  async createRecipient(
    input: CreateRecipientInput
  ): Promise<{ recipientCode: string }> {
    return {
      recipientCode: `mock-rcp-${digest(
        `${input.bankCode}:${input.accountNumber}`
      )}`
    };
  }

  async initiateTransfer(
    input: InitiateTransferInput
  ): Promise<TransferInitialization> {
    return {
      providerRef: input.reference,
      transferCode: `mock-trf-${digest(input.reference)}`,
      status: "SUCCEEDED"
    };
  }

  async verifyTransfer(reference: string): Promise<TransferVerification> {
    return {
      providerRef: reference,
      status: "SUCCEEDED",
      amountMinor: 0n,
      currency: "NGN",
      failureReason: null
    };
  }

  async getTransaction(
    providerRef: string,
    _kind: TransactionKind
  ): Promise<PaymentResult> {
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
    if (typeof record.event === "string") {
      const data =
        typeof record.data === "object" && record.data !== null
          ? (record.data as Record<string, unknown>)
          : {};
      const identifier =
        data.id ?? data.reference ?? data.transfer_code ?? data.customer_code;
      return {
        eventId: `${record.event}:${String(identifier ?? "unknown")}`,
        type: record.event,
        payload
      };
    }
    if (typeof record.eventId !== "string" || typeof record.type !== "string") {
      throw badRequest("Webhook payload requires eventId and type");
    }

    return {
      eventId: record.eventId,
      type: record.type,
      payload
    };
  }
}
