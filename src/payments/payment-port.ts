export type OrgRef = {
  organizationId: string;
  organizationName?: string;
};

export type PaymentStatus = "SUCCEEDED" | "PENDING" | "FAILED";

export type PaymentResult = {
  providerRef: string;
  status: PaymentStatus;
};

export type FundTicketInput = {
  ticketId: string;
  orgId: string;
  amountMinor: bigint;
  idempotencyKey: string;
};

export type ReleaseMilestoneInput = {
  ticketId: string;
  milestoneId: string;
  supplierOrgId: string;
  amountMinor: bigint;
  idempotencyKey: string;
};

export type WebhookEvent = {
  eventId: string;
  type: string;
  payload: unknown;
};

export interface PaymentPort {
  ensureWallet(org: OrgRef): Promise<{ providerWalletId: string }>;
  fundTicket(input: FundTicketInput): Promise<PaymentResult>;
  releaseMilestone(input: ReleaseMilestoneInput): Promise<PaymentResult>;
  getTransaction(providerRef: string): Promise<PaymentResult>;
  verifyWebhook(
    headers: Record<string, string>,
    rawBody: Buffer
  ): WebhookEvent;
}
