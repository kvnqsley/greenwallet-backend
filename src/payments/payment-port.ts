export type PaymentStatus = "SUCCEEDED" | "PENDING" | "FAILED";

export type PaymentResult = {
  providerRef: string;
  status: PaymentStatus;
};

export type ChargeInitialization = {
  providerRef: string;
  status: PaymentStatus;
  authorizationUrl: string | null;
  accessCode: string | null;
};

export type InitializeChargeInput = {
  reference: string;
  email: string;
  amountMinor: bigint;
  currency: string;
  callbackUrl?: string;
  metadata?: Record<string, string>;
};

export type ChargeVerification = {
  providerRef: string;
  status: PaymentStatus;
  amountMinor: bigint;
  currency: string;
  transactionId: string | null;
  channel: string | null;
  paidAt: Date | null;
  failureReason: string | null;
  metadata: Record<string, unknown>;
};

export type Bank = {
  id: number;
  name: string;
  code: string;
};

export type ResolvedAccount = {
  accountName: string;
  accountNumber: string;
};

export type CreateRecipientInput = {
  name: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
};

export type InitiateTransferInput = {
  reference: string;
  amountMinor: bigint;
  currency: string;
  recipientCode: string;
  reason: string;
};

export type TransferInitialization = {
  providerRef: string;
  transferCode: string;
  status: PaymentStatus;
};

export type TransferVerification = {
  providerRef: string;
  status: PaymentStatus;
  amountMinor: bigint;
  currency: string;
  failureReason: string | null;
};

export type WebhookEvent = {
  eventId: string;
  type: string;
  payload: unknown;
};

export type TransactionKind = "charge" | "transfer";

export interface PaymentPort {
  initializeCharge(input: InitializeChargeInput): Promise<ChargeInitialization>;
  verifyCharge(reference: string): Promise<ChargeVerification>;
  listBanks(): Promise<Bank[]>;
  resolveAccount(input: {
    accountNumber: string;
    bankCode: string;
  }): Promise<ResolvedAccount>;
  createRecipient(input: CreateRecipientInput): Promise<{ recipientCode: string }>;
  initiateTransfer(input: InitiateTransferInput): Promise<TransferInitialization>;
  verifyTransfer(reference: string): Promise<TransferVerification>;
  getTransaction(
    providerRef: string,
    kind: TransactionKind
  ): Promise<PaymentResult>;
  verifyWebhook(
    headers: Record<string, string>,
    rawBody: Buffer
  ): WebhookEvent;
}
