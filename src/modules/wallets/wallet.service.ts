import type {
  AccountType,
  PaymentProvider,
  PlatformRole,
  PrismaClient,
  TxnType
} from "@prisma/client";
import { Prisma } from "@prisma/client";
import { env } from "../../config/env";
import { notFound } from "../../common/errors";
import { assertBalancedLedger } from "./ledger.math";

type Db = Prisma.TransactionClient;

const providerName: PaymentProvider =
  env.PAYMENT_PROVIDER === "mock" ? "MOCK" : "PAYSTACK";

const walletInclude = {
  balance: true,
  organization: { select: { id: true, name: true } }
} satisfies Prisma.WalletInclude;

const ledgerTransactionInclude = {
  entries: {
    include: {
      account: {
        select: {
          id: true,
          type: true,
          walletId: true,
          ticketId: true,
          currency: true
        }
      }
    },
    orderBy: { createdAt: "asc" as const }
  }
} satisfies Prisma.LedgerTransactionInclude;

type WalletWithBalance = Prisma.WalletGetPayload<{
  include: typeof walletInclude;
}>;

type LedgerTransactionWithRelations = Prisma.LedgerTransactionGetPayload<{
  include: typeof ledgerTransactionInclude;
}>;

export type WalletAccounts = {
  availableAccountId: string;
  heldAccountId: string;
};

function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function serializeWallet(wallet: WalletWithBalance) {
  return {
    id: wallet.id,
    organizationId: wallet.organizationId,
    currency: wallet.currency,
    provider: wallet.provider,
    providerWalletId: wallet.providerWalletId,
    status: wallet.status,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
    organization: wallet.organization,
    balance: wallet.balance
      ? {
          availableMinor: wallet.balance.availableMinor.toString(),
          heldMinor: wallet.balance.heldMinor.toString(),
          updatedAt: wallet.balance.updatedAt
        }
      : null
  };
}

export function serializeLedgerTransaction(
  transaction: LedgerTransactionWithRelations
) {
  return {
    id: transaction.id,
    type: transaction.type,
    status: transaction.status,
    ticketId: transaction.ticketId,
    milestoneId: transaction.milestoneId,
    provider: transaction.provider,
    providerRef: transaction.providerRef,
    idempotencyKey: transaction.idempotencyKey,
    createdAt: transaction.createdAt,
    updatedAt: transaction.updatedAt,
    entries: transaction.entries.map((entry) => ({
      id: entry.id,
      transactionId: entry.transactionId,
      accountId: entry.accountId,
      direction: entry.direction,
      amountMinor: entry.amountMinor.toString(),
      createdAt: entry.createdAt,
      account: entry.account
    }))
  };
}

async function ensureLedgerAccount(
  tx: Db,
  input: {
    type: AccountType;
    currency: string;
    walletId: string | null;
    ticketId: string | null;
  }
) {
  const existing = await tx.ledgerAccount.findFirst({
    where: {
      type: input.type,
      currency: input.currency,
      walletId: input.walletId,
      ticketId: input.ticketId
    }
  });
  if (existing) {
    return existing;
  }

  try {
    return await tx.ledgerAccount.create({
      data: {
        type: input.type,
        currency: input.currency,
        walletId: input.walletId,
        ticketId: input.ticketId
      }
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await tx.ledgerAccount.findFirst({
        where: {
          type: input.type,
          currency: input.currency,
          walletId: input.walletId,
          ticketId: input.ticketId
        }
      });
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

export async function ensureWallet(
  tx: Db,
  organizationId: string,
  currency: string
): Promise<WalletWithBalance> {
  const existing = await tx.wallet.findUnique({
    where: { organizationId_currency: { organizationId, currency } },
    include: walletInclude
  });

  if (existing) {
    if (!existing.balance) {
      await tx.walletBalance.create({
        data: { walletId: existing.id, availableMinor: 0n, heldMinor: 0n }
      });
      return tx.wallet.findUniqueOrThrow({
        where: { id: existing.id },
        include: walletInclude
      });
    }
    return existing;
  }

  try {
    return await tx.wallet.create({
      data: {
        organizationId,
        currency,
        provider: providerName,
        balance: { create: { availableMinor: 0n, heldMinor: 0n } }
      },
      include: walletInclude
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await tx.wallet.findUnique({
        where: { organizationId_currency: { organizationId, currency } },
        include: walletInclude
      });
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}

export async function ensureWalletAccounts(
  tx: Db,
  wallet: { id: string; currency: string }
): Promise<WalletAccounts> {
  const available = await ensureLedgerAccount(tx, {
    type: "WALLET_AVAILABLE",
    currency: wallet.currency,
    walletId: wallet.id,
    ticketId: null
  });
  const held = await ensureLedgerAccount(tx, {
    type: "WALLET_HELD",
    currency: wallet.currency,
    walletId: wallet.id,
    ticketId: null
  });

  return {
    availableAccountId: available.id,
    heldAccountId: held.id
  };
}

export async function ensureExternalSettlementAccount(
  tx: Db,
  currency: string
): Promise<string> {
  const account = await ensureLedgerAccount(tx, {
    type: "EXTERNAL_SETTLEMENT",
    currency,
    walletId: null,
    ticketId: null
  });
  return account.id;
}

export async function ensureTicketEscrowAccount(
  tx: Db,
  ticketId: string,
  currency: string
): Promise<string> {
  const account = await ensureLedgerAccount(tx, {
    type: "TICKET_ESCROW",
    currency,
    walletId: null,
    ticketId
  });
  return account.id;
}

export async function lockWalletBalance(
  tx: Db,
  walletId: string
): Promise<{ availableMinor: bigint; heldMinor: bigint }> {
  const rows = await tx.$queryRaw<
    Array<{ availableMinor: bigint; heldMinor: bigint }>
  >(Prisma.sql`
    SELECT "availableMinor", "heldMinor"
    FROM "WalletBalance"
    WHERE "walletId" = ${walletId}
    FOR UPDATE
  `);

  const row = rows[0];
  if (!row) {
    throw notFound("Wallet balance not found");
  }
  return row;
}

export async function postLedgerTransaction(
  tx: Db,
  input: {
    type: TxnType;
    ticketId: string | null;
    milestoneId: string | null;
    providerRef: string | null;
    idempotencyKey: string;
    status?: "PENDING" | "POSTED" | "FAILED" | "REVERSED";
    entries: Array<{
      accountId: string;
      direction: "DEBIT" | "CREDIT";
      amountMinor: bigint;
    }>;
  }
): Promise<LedgerTransactionWithRelations> {
  assertBalancedLedger(input.entries);

  return tx.ledgerTransaction.create({
    data: {
      type: input.type,
      status: input.status ?? "POSTED",
      ticketId: input.ticketId,
      milestoneId: input.milestoneId,
      provider: providerName,
      providerRef: input.providerRef,
      idempotencyKey: input.idempotencyKey,
      entries: {
        create: input.entries.map((entry) => ({
          accountId: entry.accountId,
          direction: entry.direction,
          amountMinor: entry.amountMinor
        }))
      }
    },
    include: ledgerTransactionInclude
  });
}

export async function listWalletsForUser(
  prisma: PrismaClient,
  userId: string
) {
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { organizationId: true }
  });
  const organizationIds = memberships.map(
    (membership) => membership.organizationId
  );
  if (organizationIds.length === 0) {
    return [];
  }

  const wallets = await prisma.wallet.findMany({
    where: { organizationId: { in: organizationIds } },
    include: walletInclude,
    orderBy: { createdAt: "asc" }
  });
  return wallets.map(serializeWallet);
}

export async function getWalletLedger(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  walletId: string,
  query: { cursor?: string; limit?: number }
) {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    select: { id: true, organizationId: true }
  });
  if (!wallet) {
    throw notFound("Wallet not found");
  }

  if (!isPlatformAdmin(platformRole)) {
    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: wallet.organizationId
        }
      },
      select: { id: true }
    });
    if (!membership) {
      throw notFound("Wallet not found");
    }
  }

  const limit = query.limit ?? 20;
  const transactions = await prisma.ledgerTransaction.findMany({
    where: { entries: { some: { account: { walletId } } } },
    include: ledgerTransactionInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor
      ? { cursor: { id: query.cursor }, skip: 1 }
      : {})
  });

  const hasMore = transactions.length > limit;
  const page = hasMore ? transactions.slice(0, limit) : transactions;
  const last = page[page.length - 1];

  return {
    transactions: page.map(serializeLedgerTransaction),
    nextCursor: hasMore && last ? last.id : null
  };
}

export async function getTicketLedger(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string,
  query: { cursor?: string; limit?: number }
) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      id: true,
      buyerOrgId: true,
      supplierOrgId: true,
      exporterOrgId: true
    }
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }

  if (!isPlatformAdmin(platformRole)) {
    const partyOrgIds = [
      ticket.buyerOrgId,
      ticket.supplierOrgId,
      ticket.exporterOrgId
    ].filter((id): id is string => Boolean(id));
    const membership = await prisma.membership.findFirst({
      where: { userId, organizationId: { in: partyOrgIds } },
      select: { id: true }
    });
    if (!membership) {
      throw notFound("Ticket not found");
    }
  }

  const limit = query.limit ?? 20;
  const transactions = await prisma.ledgerTransaction.findMany({
    where: { ticketId },
    include: ledgerTransactionInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor
      ? { cursor: { id: query.cursor }, skip: 1 }
      : {})
  });

  const hasMore = transactions.length > limit;
  const page = hasMore ? transactions.slice(0, limit) : transactions;
  const last = page[page.length - 1];

  return {
    transactions: page.map(serializeLedgerTransaction),
    nextCursor: hasMore && last ? last.id : null
  };
}

