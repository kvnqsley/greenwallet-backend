import { createHmac, timingSafeEqual } from "node:crypto";
import { badGateway, badRequest, unauthorized } from "../common/errors";
import type {
  Bank,
  ChargeInitialization,
  ChargeVerification,
  CreateRecipientInput,
  InitializeChargeInput,
  InitiateTransferInput,
  PaymentPort,
  PaymentResult,
  PaymentStatus,
  ResolvedAccount,
  TransactionKind,
  TransferInitialization,
  TransferVerification,
  WebhookEvent
} from "./payment-port";

type PaystackEnvelope<T> = {
  status: boolean;
  message: string;
  data: T;
};

type PaystackTransaction = {
  id: number;
  reference: string;
  status: string;
  amount: number;
  currency?: string;
  channel?: string | null;
  paid_at?: string | null;
  gateway_response?: string | null;
  authorization_url?: string;
  access_code?: string;
  metadata?: unknown;
};

type PaystackTransfer = {
  id: number;
  reference: string;
  transfer_code: string;
  status: string;
  amount: number;
  currency?: string;
  reason?: string | null;
  gateway_response?: string | null;
};

const CHARGE_STATUS: Record<string, PaymentStatus> = {
  success: "SUCCEEDED",
  failed: "FAILED",
  abandoned: "FAILED",
  reversed: "FAILED",
  pending: "PENDING",
  ongoing: "PENDING",
  processing: "PENDING",
  queued: "PENDING"
};

const TRANSFER_STATUS: Record<string, PaymentStatus> = {
  success: "SUCCEEDED",
  failed: "FAILED",
  reversed: "FAILED",
  pending: "PENDING",
  otp: "PENDING",
  processing: "PENDING",
  queued: "PENDING"
};

function mapStatus(
  raw: string,
  table: Record<string, PaymentStatus>,
  fallback: PaymentStatus
): PaymentStatus {
  return table[raw.toLowerCase()] ?? fallback;
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return typeof parsed === "object" && parsed !== null
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

export class PaystackProvider implements PaymentPort {
  constructor(
    private readonly secretKey: string,
    private readonly baseUrl: string
  ) {}

  private async request<T>(
    path: string,
    init?: RequestInit
  ): Promise<PaystackEnvelope<T>> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          "Content-Type": "application/json",
          ...(init?.headers ?? {})
        },
        signal: AbortSignal.timeout(20_000)
      });
    } catch (error) {
      throw badGateway(
        `Could not reach Paystack: ${
          error instanceof Error ? error.message : "network error"
        }`
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw badGateway("Paystack returned an invalid response");
    }

    const envelope = body as Partial<PaystackEnvelope<T>>;
    if (!response.ok || envelope.status === false) {
      throw badGateway(
        typeof envelope.message === "string"
          ? `Paystack: ${envelope.message}`
          : `Paystack request failed with status ${response.status}`
      );
    }
    return envelope as PaystackEnvelope<T>;
  }

  async initializeCharge(
    input: InitializeChargeInput
  ): Promise<ChargeInitialization> {
    const { data } = await this.request<PaystackTransaction>(
      "/transaction/initialize",
      {
        method: "POST",
        body: JSON.stringify({
          email: input.email,
          amount: Number(input.amountMinor),
          currency: input.currency,
          reference: input.reference,
          ...(input.callbackUrl ? { callback_url: input.callbackUrl } : {}),
          metadata: input.metadata ?? {}
        })
      }
    );

    return {
      providerRef: data.reference,
      status: "PENDING",
      authorizationUrl: data.authorization_url ?? null,
      accessCode: data.access_code ?? null
    };
  }

  async verifyCharge(reference: string): Promise<ChargeVerification> {
    const { data } = await this.request<PaystackTransaction>(
      `/transaction/verify/${encodeURIComponent(reference)}`
    );

    return {
      providerRef: data.reference,
      status: mapStatus(data.status, CHARGE_STATUS, "PENDING"),
      amountMinor: BigInt(data.amount),
      currency: data.currency ?? "NGN",
      transactionId: String(data.id),
      channel: data.channel ?? null,
      paidAt: data.paid_at ? new Date(data.paid_at) : null,
      failureReason: data.gateway_response ?? null,
      metadata: parseMetadata(data.metadata)
    };
  }

  async listBanks(): Promise<Bank[]> {
    const { data } = await this.request<Array<{ id: number; name: string; code: string }>>(
      "/bank?country=nigeria&currency=NGN&per_page=100"
    );
    return data.map((bank) => ({
      id: bank.id,
      name: bank.name,
      code: bank.code
    }));
  }

  async resolveAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<ResolvedAccount> {
    const query = new URLSearchParams({
      account_number: input.accountNumber,
      bank_code: input.bankCode
    });
    const { data } = await this.request<{
      account_name: string;
      account_number: string;
    }>(`/bank/resolve?${query.toString()}`);

    return {
      accountName: data.account_name,
      accountNumber: data.account_number
    };
  }

  async createRecipient(
    input: CreateRecipientInput
  ): Promise<{ recipientCode: string }> {
    const { data } = await this.request<{ recipient_code: string }>(
      "/transferrecipient",
      {
        method: "POST",
        body: JSON.stringify({
          type: "nuban",
          name: input.name,
          account_number: input.accountNumber,
          bank_code: input.bankCode,
          currency: input.currency
        })
      }
    );

    return { recipientCode: data.recipient_code };
  }

  async initiateTransfer(
    input: InitiateTransferInput
  ): Promise<TransferInitialization> {
    const { data } = await this.request<PaystackTransfer>("/transfer", {
      method: "POST",
      body: JSON.stringify({
        source: "balance",
        reason: input.reason,
        amount: Number(input.amountMinor),
        recipient: input.recipientCode,
        reference: input.reference,
        currency: input.currency
      })
    });

    return {
      providerRef: data.reference,
      transferCode: data.transfer_code,
      status: mapStatus(data.status, TRANSFER_STATUS, "PENDING")
    };
  }

  async verifyTransfer(reference: string): Promise<TransferVerification> {
    const { data } = await this.request<PaystackTransfer>(
      `/transfer/verify/${encodeURIComponent(reference)}`
    );

    return {
      providerRef: data.reference,
      status: mapStatus(data.status, TRANSFER_STATUS, "PENDING"),
      amountMinor: BigInt(data.amount),
      currency: data.currency ?? "NGN",
      failureReason: data.gateway_response ?? data.reason ?? null
    };
  }

  async getTransaction(
    providerRef: string,
    kind: TransactionKind
  ): Promise<PaymentResult> {
    if (kind === "transfer") {
      const transfer = await this.verifyTransfer(providerRef);
      return { providerRef, status: transfer.status };
    }
    const charge = await this.verifyCharge(providerRef);
    return { providerRef, status: charge.status };
  }

  verifyWebhook(
    headers: Record<string, string>,
    rawBody: Buffer
  ): WebhookEvent {
    const signature = headers["x-paystack-signature"];
    if (typeof signature !== "string" || signature.length === 0) {
      throw unauthorized("Missing webhook signature");
    }

    const expected = createHmac("sha512", this.secretKey)
      .update(rawBody)
      .digest("hex");
    const provided = signature.trim().toLowerCase();
    const expectedBuffer = Buffer.from(expected, "utf8");
    const providedBuffer = Buffer.from(provided, "utf8");
    if (
      expectedBuffer.length !== providedBuffer.length ||
      !timingSafeEqual(expectedBuffer, providedBuffer)
    ) {
      throw unauthorized("Invalid webhook signature");
    }

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
    const data =
      typeof record.data === "object" && record.data !== null
        ? (record.data as Record<string, unknown>)
        : {};
    const eventType = record.event;
    if (typeof eventType !== "string") {
      throw badRequest("Webhook payload requires an event type");
    }
    const identifier =
      data.id ?? data.reference ?? data.transfer_code ?? data.customer_code;

    return {
      eventId: `${eventType}:${String(identifier ?? "unknown")}`,
      type: eventType,
      payload
    };
  }
}
