import { createHash } from "node:crypto";
import type {
  BankAccount,
  PaymentProvider,
  PlatformRole,
  PrismaClient,
  Withdrawal
} from "@prisma/client";
import { env } from "../../config/env";
import { recordAudit } from "../../common/audit";
import { withTransaction } from "../../common/db";
import {
  badRequest,
  conflict,
  forbidden,
  notFound
} from "../../common/errors";
import {
  executeIdempotent,
  idempotencyScope,
  requireIdempotencyKey
} from "../../common/idempotency";
import {
  enqueueNotifications,
  NotificationEvents,
  orgMemberIds
} from "../notifications/notification.service";
import {
  ensureExternalSettlementAccount,
  ensureWallet,
  ensureWalletAccounts,
  lockWalletBalance,
  postLedgerTransaction
} from "../wallets/wallet.service";
import type { PaymentPort, TransferVerification } from "../../payments/payment-port";

const providerName: PaymentProvider =
  env.PAYMENT_PROVIDER === "mock" ? "MOCK" : "PAYSTACK";

function withdrawalReference(idempotencyKey: string): string {
  const digest = createHash("sha256")
    .update(idempotencyKey)
    .digest("hex")
    .slice(0, 24);
  return `wd_${digest}`;
}

export function serializeBankAccount(account: BankAccount) {
  return {
    id: account.id,
    organizationId: account.organizationId,
    currency: account.currency,
    bankCode: account.bankCode,
    bankName: account.bankName,
    accountName: account.accountName,
    accountNumber: `****${account.accountNumber.slice(-4)}`,
    recipientCode: account.recipientCode,
    isDefault: account.isDefault,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt
  };
}

export function serializeWithdrawal(withdrawal: Withdrawal) {
  return {
    id: withdrawal.id,
    organizationId: withdrawal.organizationId,
    walletId: withdrawal.walletId,
    bankAccountId: withdrawal.bankAccountId,
    amountMinor: withdrawal.amountMinor.toString(),
    currency: withdrawal.currency,
    status: withdrawal.status,
    provider: withdrawal.provider,
    providerRef: withdrawal.providerRef,
    failureReason: withdrawal.failureReason,
    requestedById: withdrawal.requestedById,
    processedAt: withdrawal.processedAt,
    createdAt: withdrawal.createdAt,
    updatedAt: withdrawal.updatedAt
  };
}

async function requireWalletAdmin(
  prisma: PrismaClient,
  userId: string,
  walletId: string
) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: {
      organization: { select: { id: true, name: true } }
    }
  });
  if (!wallet) {
    throw notFound("Wallet not found");
  }
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: wallet.organizationId
      }
    }
  });
  if (!membership) {
    throw notFound("Wallet not found");
  }
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    throw forbidden("Only organization owners or admins can manage payouts");
  }
  return wallet;
}

async function requireWalletMember(
  prisma: PrismaClient,
  userId: string,
  walletId: string
) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId }
  });
  if (!wallet) {
    throw notFound("Wallet not found");
  }
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: wallet.organizationId
      }
    }
  });
  if (!membership) {
    throw notFound("Wallet not found");
  }
  return wallet;
}

export async function listBanks(payments: PaymentPort) {
  return payments.listBanks();
}

export async function addBankAccount(
  prisma: PrismaClient,
  payments: PaymentPort,
  userId: string,
  walletId: string,
  input: { bankCode: string; accountNumber: string; bankName?: string }
) {
  const wallet = await requireWalletAdmin(prisma, userId, walletId);
  const resolved = await payments.resolveAccount({
    accountNumber: input.accountNumber,
    bankCode: input.bankCode
  });
  const recipient = await payments.createRecipient({
    name: resolved.accountName,
    accountNumber: resolved.accountNumber,
    bankCode: input.bankCode,
    currency: wallet.currency
  });

  const account = await withTransaction(prisma, async (tx) => {
    await tx.bankAccount.updateMany({
      where: { organizationId: wallet.organizationId, isDefault: true },
      data: { isDefault: false }
    });
    return tx.bankAccount.upsert({
      where: {
        organizationId_bankCode_accountNumber: {
          organizationId: wallet.organizationId,
          bankCode: input.bankCode,
          accountNumber: input.accountNumber
        }
      },
      create: {
        organizationId: wallet.organizationId,
        currency: wallet.currency,
        bankCode: input.bankCode,
        bankName: input.bankName ?? input.bankCode,
        accountName: resolved.accountName,
        accountNumber: input.accountNumber,
        recipientCode: recipient.recipientCode,
        isDefault: true
      },
      update: {
        bankName: input.bankName ?? input.bankCode,
        accountName: resolved.accountName,
        recipientCode: recipient.recipientCode,
        isDefault: true
      }
    });
  });

  return serializeBankAccount(account);
}

export async function listBankAccounts(
  prisma: PrismaClient,
  userId: string,
  walletId: string
) {
  const wallet = await requireWalletMember(prisma, userId, walletId);
  const accounts = await prisma.bankAccount.findMany({
    where: { organizationId: wallet.organizationId },
    orderBy: [{ isDefault: "desc" }, { createdAt: "desc" }]
  });
  return accounts.map(serializeBankAccount);
}

export async function listWithdrawals(
  prisma: PrismaClient,
  userId: string,
  walletId: string
) {
  const wallet = await requireWalletMember(prisma, userId, walletId);
  const withdrawals = await prisma.withdrawal.findMany({
    where: { walletId: wallet.id },
    orderBy: { createdAt: "desc" },
    take: 100
  });
  return withdrawals.map(serializeWithdrawal);
}

export async function getWithdrawal(
  prisma: PrismaClient,
  userId: string,
  withdrawalId: string
) {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId }
  });
  if (!withdrawal) {
    throw notFound("Withdrawal not found");
  }
  await requireWalletMember(prisma, userId, withdrawal.walletId);
  return serializeWithdrawal(withdrawal);
}

export async function requestWithdrawal(
  prisma: PrismaClient,
  payments: PaymentPort,
  userId: string,
  walletId: string,
  input: { bankAccountId: string; amountMinor: string; reason?: string },
  idempotencyKey: string
) {
  const wallet = await requireWalletAdmin(prisma, userId, walletId);
  const amountMinor = BigInt(input.amountMinor);
  if (amountMinor <= 0n) {
    throw badRequest("Withdrawal amount must be greater than zero");
  }
  if (!/^\d+$/.test(input.amountMinor)) {
    throw badRequest("amountMinor must be a positive integer string");
  }

  const bankAccount = await prisma.bankAccount.findFirst({
    where: {
      id: input.bankAccountId,
      organizationId: wallet.organizationId
    }
  });
  if (!bankAccount) {
    throw notFound("Bank account not found");
  }

  const reference = withdrawalReference(idempotencyKey);
  const scope = idempotencyScope({
    organizationId: wallet.organizationId,
    endpoint: "POST /wallets/:walletId/withdrawals",
    key: idempotencyKey,
    request: {
      walletId,
      bankAccountId: input.bankAccountId,
      amountMinor: input.amountMinor
    }
  });

  const result = await executeIdempotent<{
    withdrawal: ReturnType<typeof serializeWithdrawal>;
  }>(prisma, scope, async (tx, ledgerKey) => {
    const currentWallet = await tx.wallet.findUniqueOrThrow({
      where: { id: wallet.id }
    });
    const accounts = await ensureWalletAccounts(tx, currentWallet);
    const locked = await lockWalletBalance(tx, currentWallet.id);
    if (locked.availableMinor < amountMinor) {
      throw conflict("Insufficient available balance");
    }

    await tx.walletBalance.update({
      where: { walletId: currentWallet.id },
      data: {
        availableMinor: { decrement: amountMinor },
        heldMinor: { increment: amountMinor }
      }
    });

    const withdrawal = await tx.withdrawal.create({
      data: {
        organizationId: wallet.organizationId,
        walletId: currentWallet.id,
        bankAccountId: bankAccount.id,
        amountMinor,
        currency: currentWallet.currency,
        status: "PENDING",
        provider: providerName,
        providerRef: reference,
        idempotencyKey,
        recipientCode: bankAccount.recipientCode,
        requestedById: userId
      }
    });

    await postLedgerTransaction(tx, {
      type: "WITHDRAWAL",
      ticketId: null,
      milestoneId: null,
      providerRef: reference,
      idempotencyKey: `${ledgerKey}:hold`,
      status: "PENDING",
      entries: [
        {
          accountId: accounts.availableAccountId,
          direction: "DEBIT",
          amountMinor
        },
        {
          accountId: accounts.heldAccountId,
          direction: "CREDIT",
          amountMinor
        }
      ]
    });

    await recordAudit(tx, {
      actorId: userId,
      actorOrgId: wallet.organizationId,
      action: "withdrawal.request",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
      after: {
        amountMinor: amountMinor.toString(),
        bankAccountId: bankAccount.id
      }
    });

    return {
      code: 201,
      body: { withdrawal: serializeWithdrawal(withdrawal) }
    };
  });

  const withdrawalId = result.body.withdrawal.id;
  await processWithdrawal(prisma, payments, withdrawalId, input.reason);

  const refreshed = await prisma.withdrawal.findUniqueOrThrow({
    where: { id: withdrawalId }
  });
  return {
    replayed: result.replayed,
    responseCode: result.responseCode,
    body: { withdrawal: serializeWithdrawal(refreshed) }
  };
}

export async function processWithdrawal(
  prisma: PrismaClient,
  payments: PaymentPort,
  withdrawalId: string,
  reason?: string
): Promise<void> {
  const withdrawal = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId }
  });
  if (!withdrawal || withdrawal.status !== "PENDING") {
    return;
  }
  if (!withdrawal.providerRef) {
    throw conflict("Withdrawal is missing a provider reference");
  }

  let transfer: {
    providerRef: string;
    status: "SUCCEEDED" | "PENDING" | "FAILED";
  };
  try {
    transfer = await payments.initiateTransfer({
      reference: withdrawal.providerRef,
      amountMinor: withdrawal.amountMinor,
      currency: withdrawal.currency,
      recipientCode: withdrawal.recipientCode,
      reason: reason ?? `GreenWallet payout ${withdrawal.id}`
    });
  } catch (error) {
    let verification: TransferVerification | null;
    try {
      verification = await payments.verifyTransfer(withdrawal.providerRef);
    } catch {
      verification = null;
    }
    if (!verification) {
      await applyWithdrawalFailure(
        prisma,
        withdrawalId,
        error instanceof Error ? error.message : "Transfer failed"
      );
      return;
    }
    transfer = { providerRef: verification.providerRef, status: verification.status };
  }

  if (transfer.status === "SUCCEEDED") {
    await applyWithdrawalSuccess(
      prisma,
      withdrawalId,
      withdrawal.amountMinor,
      withdrawal.currency
    );
    return;
  }
  if (transfer.status === "FAILED") {
    await applyWithdrawalFailure(prisma, withdrawalId, "Transfer failed");
    return;
  }

  await prisma.withdrawal.updateMany({
    where: { id: withdrawalId, status: "PENDING" },
    data: { status: "PROCESSING", providerRef: transfer.providerRef }
  });
}

export async function applyWithdrawalSuccess(
  prisma: PrismaClient,
  withdrawalId: string,
  amountMinor: bigint,
  currency: string
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: withdrawalId }
    });
    if (!withdrawal) {
      throw notFound("Withdrawal not found");
    }
    if (
      withdrawal.status === "SUCCESS" ||
      withdrawal.status === "REVERSED" ||
      withdrawal.status === "FAILED"
    ) {
      return;
    }

    const settlementAmount =
      amountMinor > 0n ? amountMinor : withdrawal.amountMinor;
    if (settlementAmount !== withdrawal.amountMinor) {
      throw conflict("Transfer amount does not match the withdrawal");
    }

    const wallet = await ensureWallet(
      tx,
      withdrawal.organizationId,
      currency || withdrawal.currency
    );
    const accounts = await ensureWalletAccounts(tx, wallet);
    const externalAccountId = await ensureExternalSettlementAccount(
      tx,
      wallet.currency
    );
    const locked = await lockWalletBalance(tx, wallet.id);
    if (locked.heldMinor < withdrawal.amountMinor) {
      throw conflict("Withdrawal hold is missing");
    }

    const ledgerKey = `withdrawal:${withdrawal.id}:settle`;
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey }
    });
    if (!existing) {
      await tx.walletBalance.update({
        where: { walletId: wallet.id },
        data: { heldMinor: { decrement: withdrawal.amountMinor } }
      });
      await postLedgerTransaction(tx, {
        type: "WITHDRAWAL",
        ticketId: null,
        milestoneId: null,
        providerRef: withdrawal.providerRef,
        idempotencyKey: ledgerKey,
        status: "POSTED",
        entries: [
          {
            accountId: accounts.heldAccountId,
            direction: "DEBIT",
            amountMinor: withdrawal.amountMinor
          },
          {
            accountId: externalAccountId,
            direction: "CREDIT",
            amountMinor: withdrawal.amountMinor
          }
        ]
      });
    }

    await tx.withdrawal.update({
      where: { id: withdrawal.id },
      data: {
        status: "SUCCESS",
        processedAt: new Date(),
        failureReason: null
      }
    });

    await recordAudit(tx, {
      action: "withdrawal.paid",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
      after: {
        amountMinor: withdrawal.amountMinor.toString(),
        providerRef: withdrawal.providerRef
      }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.withdrawalPaid,
      title: "Withdrawal paid",
      body: `Your withdrawal of ${withdrawal.amountMinor.toString()} ${
        withdrawal.currency
      } has been sent to your bank account.`,
      data: { withdrawalId: withdrawal.id, walletId: wallet.id },
      userIds: await orgMemberIds(tx, withdrawal.organizationId)
    });
  });
}

export async function applyWithdrawalFailure(
  prisma: PrismaClient,
  withdrawalId: string,
  reason: string | null
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: withdrawalId }
    });
    if (!withdrawal) {
      throw notFound("Withdrawal not found");
    }
    if (withdrawal.status === "FAILED" || withdrawal.status === "REVERSED") {
      return;
    }
    if (withdrawal.status === "SUCCESS") {
      return;
    }

    const wallet = await ensureWallet(
      tx,
      withdrawal.organizationId,
      withdrawal.currency
    );
    const accounts = await ensureWalletAccounts(tx, wallet);
    await lockWalletBalance(tx, wallet.id);

    const ledgerKey = `withdrawal:${withdrawal.id}:release`;
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey }
    });
    if (!existing) {
      await tx.walletBalance.update({
        where: { walletId: wallet.id },
        data: {
          heldMinor: { decrement: withdrawal.amountMinor },
          availableMinor: { increment: withdrawal.amountMinor }
        }
      });
      await postLedgerTransaction(tx, {
        type: "WITHDRAWAL",
        ticketId: null,
        milestoneId: null,
        providerRef: withdrawal.providerRef,
        idempotencyKey: ledgerKey,
        status: "REVERSED",
        entries: [
          {
            accountId: accounts.heldAccountId,
            direction: "DEBIT",
            amountMinor: withdrawal.amountMinor
          },
          {
            accountId: accounts.availableAccountId,
            direction: "CREDIT",
            amountMinor: withdrawal.amountMinor
          }
        ]
      });
    }

    await tx.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: "FAILED", failureReason: reason }
    });

    await recordAudit(tx, {
      action: "withdrawal.failed",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
      after: { reason }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.withdrawalFailed,
      title: "Withdrawal failed",
      body: `Your withdrawal could not be completed. ${
        reason ?? "Please try again."
      }`,
      data: { withdrawalId: withdrawal.id, walletId: wallet.id },
      userIds: await orgMemberIds(tx, withdrawal.organizationId)
    });
  });
}

export async function applyWithdrawalReversal(
  prisma: PrismaClient,
  withdrawalId: string,
  reason: string | null
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const withdrawal = await tx.withdrawal.findUnique({
      where: { id: withdrawalId }
    });
    if (!withdrawal) {
      throw notFound("Withdrawal not found");
    }
    if (withdrawal.status !== "SUCCESS") {
      await tx.withdrawal.updateMany({
        where: { id: withdrawal.id, status: { in: ["PENDING", "PROCESSING"] } },
        data: { status: "PROCESSING" }
      });
      return;
    }

    const wallet = await ensureWallet(
      tx,
      withdrawal.organizationId,
      withdrawal.currency
    );
    const accounts = await ensureWalletAccounts(tx, wallet);
    const externalAccountId = await ensureExternalSettlementAccount(
      tx,
      wallet.currency
    );
    await lockWalletBalance(tx, wallet.id);

    const ledgerKey = `withdrawal:${withdrawal.id}:reversal`;
    const existing = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey }
    });
    if (!existing) {
      await tx.walletBalance.update({
        where: { walletId: wallet.id },
        data: { availableMinor: { increment: withdrawal.amountMinor } }
      });
      await postLedgerTransaction(tx, {
        type: "WITHDRAWAL",
        ticketId: null,
        milestoneId: null,
        providerRef: withdrawal.providerRef,
        idempotencyKey: ledgerKey,
        status: "REVERSED",
        entries: [
          {
            accountId: externalAccountId,
            direction: "DEBIT",
            amountMinor: withdrawal.amountMinor
          },
          {
            accountId: accounts.availableAccountId,
            direction: "CREDIT",
            amountMinor: withdrawal.amountMinor
          }
        ]
      });
    }

    await tx.withdrawal.update({
      where: { id: withdrawal.id },
      data: { status: "REVERSED", failureReason: reason }
    });

    await recordAudit(tx, {
      action: "withdrawal.reversed",
      entityType: "Withdrawal",
      entityId: withdrawal.id,
      after: { reason }
    });
  });
}

export function requireWithdrawalKey(
  value: string | string[] | undefined
): string {
  return requireIdempotencyKey(value);
}

export type WithdrawalInput = {
  bankAccountId: string;
  amountMinor: string;
  reason?: string;
};

export type WithdrawalRole = PlatformRole;
