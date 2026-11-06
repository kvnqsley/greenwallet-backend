import { randomBytes } from "node:crypto";
import type {
  PaymentProvider,
  PrismaClient,
  TicketCharge
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
  enqueueNotifications,
  NotificationEvents,
  orgMemberIds
} from "../notifications/notification.service";
import {
  serializeTicket,
  ticketInclude
} from "../tickets/ticket.service";
import {
  ensureExternalSettlementAccount,
  ensureTicketEscrowAccount,
  ensureWallet,
  postLedgerTransaction,
  lockWalletBalance
} from "../wallets/wallet.service";
import type {
  ChargeVerification,
  PaymentPort
} from "../../payments/payment-port";

const providerName: PaymentProvider =
  env.PAYMENT_PROVIDER === "mock" ? "MOCK" : "PAYSTACK";

const PENDING_CHARGE_TTL_MS = 60 * 60 * 1000;

export function serializeTicketCharge(charge: TicketCharge) {
  return {
    id: charge.id,
    ticketId: charge.ticketId,
    organizationId: charge.organizationId,
    provider: charge.provider,
    reference: charge.reference,
    amountMinor: charge.amountMinor.toString(),
    currency: charge.currency,
    status: charge.status,
    authorizationUrl: charge.authorizationUrl,
    accessCode: charge.accessCode,
    customerEmail: charge.customerEmail,
    channel: charge.channel,
    providerTransactionId: charge.providerTransactionId,
    failureReason: charge.failureReason,
    paidAt: charge.paidAt,
    createdAt: charge.createdAt,
    updatedAt: charge.updatedAt
  };
}

export type TicketChargeResponse = {
  ticket: ReturnType<typeof serializeTicket>;
  charge: ReturnType<typeof serializeTicketCharge> | null;
  blockedReason: string | null;
};

async function requireTicketMember(
  prisma: PrismaClient,
  userId: string,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    exporterOrgId: string | null;
  }
): Promise<void> {
  const organizationIds = [
    ticket.buyerOrgId,
    ticket.supplierOrgId,
    ticket.exporterOrgId
  ].filter((id): id is string => Boolean(id));
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: { in: organizationIds } },
    select: { id: true }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
}

async function buyerContactEmail(
  prisma: PrismaClient,
  buyerOrgId: string,
  fallback: string
): Promise<string> {
  const membership = await prisma.membership.findFirst({
    where: {
      organizationId: buyerOrgId,
      role: { in: ["OWNER", "ADMIN"] }
    },
    select: { user: { select: { email: true } } },
    orderBy: { createdAt: "asc" }
  });
  return membership?.user.email ?? fallback;
}

export async function applyChargeSuccess(
  prisma: PrismaClient,
  chargeId: string,
  verification: ChargeVerification
): Promise<void> {
  await withTransaction(prisma, async (tx) => {
    const charge = await tx.ticketCharge.findUnique({
      where: { id: chargeId },
      include: { ticket: true }
    });
    if (!charge) {
      throw notFound("Ticket charge not found");
    }
    if (charge.status === "SUCCESS") {
      return;
    }
    if (charge.status !== "PENDING") {
      return;
    }

    const amountMinor =
      verification.amountMinor > 0n
        ? verification.amountMinor
        : charge.amountMinor;
    const currency = verification.currency || charge.currency;
    if (amountMinor !== charge.amountMinor || currency !== charge.currency) {
      await tx.ticketCharge.update({
        where: { id: charge.id },
        data: {
          status: "FAILED",
          failureReason: "Paid amount does not match the ticket charge"
        }
      });
      await recordAudit(tx, {
        actorOrgId: charge.organizationId,
        action: "payment.charge_mismatch",
        entityType: "TicketCharge",
        entityId: charge.id,
        after: {
          expectedAmountMinor: charge.amountMinor.toString(),
          receivedAmountMinor: amountMinor.toString(),
          expectedCurrency: charge.currency,
          receivedCurrency: currency
        }
      });
      return;
    }

    const ticket = charge.ticket;
    if (ticket.status !== "ACTIVE") {
      await tx.ticketCharge.update({
        where: { id: charge.id },
        data: {
          status: "SUCCESS",
          paidAt: verification.paidAt ?? new Date(),
          channel: verification.channel,
          providerTransactionId: verification.transactionId,
          failureReason:
            "Payment arrived when the ticket was not active; manual reconciliation required"
        }
      });
      await recordAudit(tx, {
        actorOrgId: charge.organizationId,
        action: "payment.charge_overpayment",
        entityType: "TicketCharge",
        entityId: charge.id,
        after: {
          ticketId: ticket.id,
          ticketStatus: ticket.status,
          amountMinor: amountMinor.toString()
        }
      });
      return;
    }

    const ledgerKey = `paystack:charge:${charge.id}`;
    const existingTransaction = await tx.ledgerTransaction.findUnique({
      where: { idempotencyKey: ledgerKey }
    });

    if (!existingTransaction) {
      const wallet = await ensureWallet(tx, ticket.buyerOrgId, ticket.currency);
      const externalAccountId = await ensureExternalSettlementAccount(
        tx,
        ticket.currency
      );
      const escrowAccountId = await ensureTicketEscrowAccount(
        tx,
        ticket.id,
        ticket.currency
      );

      await lockWalletBalance(tx, wallet.id);
      await tx.walletBalance.update({
        where: { walletId: wallet.id },
        data: { heldMinor: { increment: amountMinor } }
      });

      await postLedgerTransaction(tx, {
        type: "TICKET_FUNDING",
        ticketId: ticket.id,
        milestoneId: null,
        providerRef: charge.reference,
        idempotencyKey: ledgerKey,
        entries: [
          {
            accountId: externalAccountId,
            direction: "DEBIT",
            amountMinor
          },
          {
            accountId: escrowAccountId,
            direction: "CREDIT",
            amountMinor
          }
        ]
      });

      await tx.ticket.update({
        where: { id: ticket.id },
        data: { status: "FUNDED", fundedAt: new Date() }
      });
    }

    await tx.ticketCharge.update({
      where: { id: charge.id },
      data: {
        status: "SUCCESS",
        paidAt: verification.paidAt ?? new Date(),
        channel: verification.channel,
        providerTransactionId: verification.transactionId,
        failureReason: null
      }
    });

    await recordAudit(tx, {
      actorOrgId: charge.organizationId,
      action: "ticket.fund",
      entityType: "Ticket",
      entityId: ticket.id,
      before: { status: ticket.status },
      after: {
        status: "FUNDED",
        amountMinor: amountMinor.toString(),
        providerRef: charge.reference
      }
    });

    const recipientIds = [
      ...(await orgMemberIds(tx, ticket.buyerOrgId)),
      ...(await orgMemberIds(tx, ticket.supplierOrgId))
    ];
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketFunded,
      title: "Ticket funded",
      body: `Ticket ${ticket.reference} has been funded and is ready for performance.`,
      data: { ticketId: ticket.id },
      userIds: recipientIds
    });
  });
}

export async function applyChargeFailure(
  prisma: PrismaClient,
  chargeId: string,
  reason: string | null
): Promise<void> {
  await prisma.ticketCharge.updateMany({
    where: { id: chargeId, status: "PENDING" },
    data: { status: "FAILED", failureReason: reason }
  });
}

export async function getTicketCharge(
  prisma: PrismaClient,
  userId: string,
  ticketId: string
): Promise<TicketChargeResponse> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  await requireTicketMember(prisma, userId, ticket);

  const charge = await prisma.ticketCharge.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });

  return {
    ticket: serializeTicket(ticket),
    charge: charge ? serializeTicketCharge(charge) : null,
    blockedReason:
      !charge && ticket.buyer.verification !== "VERIFIED"
        ? "BUYER_NOT_VERIFIED"
        : null
  };
}

export async function ensureTicketCharge(
  prisma: PrismaClient,
  payments: PaymentPort,
  userId: string,
  ticketId: string
): Promise<TicketChargeResponse> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  await requireTicketMember(prisma, userId, ticket);

  const serializeCurrent = async (): Promise<TicketChargeResponse> => {
    const current = await prisma.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude
    });
    const charge = await prisma.ticketCharge.findFirst({
      where: { ticketId },
      orderBy: { createdAt: "desc" }
    });
    return {
      ticket: serializeTicket(current),
      charge: charge ? serializeTicketCharge(charge) : null,
      blockedReason: null
    };
  };

  const newest = await prisma.ticketCharge.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });

  if (newest?.status === "SUCCESS") {
    return serializeCurrent();
  }
  if (
    newest?.status === "PENDING" &&
    Date.now() - newest.createdAt.getTime() < PENDING_CHARGE_TTL_MS
  ) {
    return serializeCurrent();
  }
  if (newest?.status === "PENDING") {
    await prisma.ticketCharge.update({
      where: { id: newest.id },
      data: { status: "ABANDONED", failureReason: "Charge expired" }
    });
  }

  if (
    ticket.status === "FUNDED" ||
    ticket.status === "IN_PROGRESS" ||
    ticket.status === "COMPLETED"
  ) {
    return serializeCurrent();
  }
  if (ticket.status !== "ACTIVE") {
    throw conflict("Only an active ticket can be charged");
  }
  if (ticket.totalMinor <= 0n) {
    throw conflict("Ticket amount must be greater than zero");
  }
  // if (ticket.buyer.verification !== "VERIFIED") {
  //   return {
  //     ticket: serializeTicket(ticket),
  //     charge: null,
  //     blockedReason: "BUYER_NOT_VERIFIED"
  //   };
  // }

  const email = await buyerContactEmail(
    prisma,
    ticket.buyerOrgId,
    ticket.createdBy.email
  );
  const reference = `${ticket.reference}-${Date.now().toString(
    36
  )}-${randomBytes(3).toString("hex")}`;

  const initialization = await payments.initializeCharge({
    reference,
    email,
    amountMinor: ticket.totalMinor,
    currency: ticket.currency,
    callbackUrl: env.PAYSTACK_CALLBACK_URL ?? env.APP_URL,
    metadata: {
      ticketId: ticket.id,
      ticketReference: ticket.reference,
      buyerOrgId: ticket.buyerOrgId
    }
  });

  const charge = await prisma.ticketCharge.create({
    data: {
      ticketId: ticket.id,
      organizationId: ticket.buyerOrgId,
      provider: providerName,
      reference: initialization.providerRef,
      amountMinor: ticket.totalMinor,
      currency: ticket.currency,
      status: "PENDING",
      authorizationUrl: initialization.authorizationUrl,
      accessCode: initialization.accessCode,
      customerEmail: email
    }
  });

  if (initialization.status === "SUCCEEDED") {
    await applyChargeSuccess(prisma, charge.id, {
      providerRef: charge.reference,
      status: "SUCCEEDED",
      amountMinor: charge.amountMinor,
      currency: charge.currency,
      transactionId: null,
      channel: "mock",
      paidAt: new Date(),
      failureReason: null,
      metadata: {}
    });
  }

  const result = await serializeCurrent();
  await withTransaction(prisma, (tx) =>
    recordAudit(tx, {
      actorId: userId,
      actorOrgId: ticket.buyerOrgId,
      action: "payment.charge_created",
      entityType: "TicketCharge",
      entityId: charge.id,
      after: {
        ticketId: ticket.id,
        reference: charge.reference,
        amountMinor: charge.amountMinor.toString()
      }
    })
  );
  return result;
}

export async function verifyTicketCharge(
  prisma: PrismaClient,
  payments: PaymentPort,
  userId: string,
  ticketId: string
): Promise<TicketChargeResponse> {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  await requireTicketMember(prisma, userId, ticket);

  const charge = await prisma.ticketCharge.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });
  if (!charge) {
    return ensureTicketCharge(prisma, payments, userId, ticketId);
  }
  if (charge.status === "PENDING") {
    const verification = await payments.verifyCharge(charge.reference);
    if (verification.status === "SUCCEEDED") {
      await applyChargeSuccess(prisma, charge.id, verification);
    } else if (verification.status === "FAILED") {
      await applyChargeFailure(
        prisma,
        charge.id,
        verification.failureReason
      );
    }
  }

  const refreshed = await prisma.ticket.findUniqueOrThrow({
    where: { id: ticketId },
    include: ticketInclude
  });
  const latest = await prisma.ticketCharge.findFirst({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });
  if (!latest) {
    throw badRequest("Ticket charge not found");
  }
  return {
    ticket: serializeTicket(refreshed),
    charge: serializeTicketCharge(latest),
    blockedReason: null
  };
}

export async function findChargeByReference(
  prisma: PrismaClient,
  reference: string
): Promise<TicketCharge | null> {
  return prisma.ticketCharge.findUnique({ where: { reference } });
}

export async function ticketPartyMembership(
  prisma: PrismaClient,
  userId: string,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    exporterOrgId: string | null;
  }
): Promise<void> {
  await requireTicketMember(prisma, userId, ticket);
}

export function assertChargeProvider(charge: TicketCharge): void {
  if (charge.provider !== providerName) {
    throw forbidden("This charge belongs to a different payment provider");
  }
}
