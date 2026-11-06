-- Paystack per-ticket charges and seller payouts.
ALTER TYPE "PaymentProvider" ADD VALUE IF NOT EXISTS 'PAYSTACK';
ALTER TYPE "TxnType" ADD VALUE IF NOT EXISTS 'WITHDRAWAL';

CREATE TYPE "TicketChargeStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED', 'ABANDONED', 'REVERSED');
CREATE TYPE "WithdrawalStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'FAILED', 'REVERSED');

CREATE TABLE "TicketCharge" (
  "id" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "provider" "PaymentProvider" NOT NULL,
  "reference" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "status" "TicketChargeStatus" NOT NULL DEFAULT 'PENDING',
  "authorizationUrl" TEXT,
  "accessCode" TEXT,
  "customerEmail" TEXT NOT NULL,
  "channel" TEXT,
  "providerTransactionId" TEXT,
  "failureReason" TEXT,
  "paidAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TicketCharge_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketCharge_reference_key" ON "TicketCharge"("reference");
CREATE INDEX "TicketCharge_ticketId_status_idx" ON "TicketCharge"("ticketId", "status");
CREATE INDEX "TicketCharge_organizationId_status_idx" ON "TicketCharge"("organizationId", "status");
CREATE INDEX "TicketCharge_provider_providerTransactionId_idx" ON "TicketCharge"("provider", "providerTransactionId");

ALTER TABLE "TicketCharge" ADD CONSTRAINT "TicketCharge_ticketId_fkey"
  FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TicketCharge" ADD CONSTRAINT "TicketCharge_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "BankAccount" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "bankCode" TEXT NOT NULL,
  "bankName" TEXT NOT NULL,
  "accountName" TEXT NOT NULL,
  "accountNumber" TEXT NOT NULL,
  "recipientCode" TEXT NOT NULL,
  "isDefault" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankAccount_recipientCode_key" ON "BankAccount"("recipientCode");
CREATE UNIQUE INDEX "BankAccount_organizationId_bankCode_accountNumber_key"
  ON "BankAccount"("organizationId", "bankCode", "accountNumber");
CREATE INDEX "BankAccount_organizationId_idx" ON "BankAccount"("organizationId");

ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "Withdrawal" (
  "id" TEXT NOT NULL,
  "organizationId" TEXT NOT NULL,
  "walletId" TEXT NOT NULL,
  "bankAccountId" TEXT NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'NGN',
  "status" "WithdrawalStatus" NOT NULL DEFAULT 'PENDING',
  "provider" "PaymentProvider" NOT NULL,
  "providerRef" TEXT,
  "idempotencyKey" TEXT NOT NULL,
  "recipientCode" TEXT NOT NULL,
  "failureReason" TEXT,
  "requestedById" TEXT NOT NULL,
  "processedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Withdrawal_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Withdrawal_providerRef_key" ON "Withdrawal"("providerRef");
CREATE UNIQUE INDEX "Withdrawal_idempotencyKey_key" ON "Withdrawal"("idempotencyKey");
CREATE INDEX "Withdrawal_organizationId_status_idx" ON "Withdrawal"("organizationId", "status");
CREATE INDEX "Withdrawal_walletId_status_idx" ON "Withdrawal"("walletId", "status");

ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_walletId_fkey"
  FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_bankAccountId_fkey"
  FOREIGN KEY ("bankAccountId") REFERENCES "BankAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Withdrawal" ADD CONSTRAINT "Withdrawal_requestedById_fkey"
  FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
