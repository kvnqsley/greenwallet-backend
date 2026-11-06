import type { PlatformRole, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
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
  executeIdempotent,
  idempotencyScope,
  readIdempotentResponse,
  type IdempotentResult
} from "../../common/idempotency";
import {
  serializeMilestone,
  serializeTicket,
  ticketInclude
} from "../tickets/ticket.service";
import {
  ensureTicketEscrowAccount,
  ensureWallet,
  ensureWalletAccounts,
  lockWalletBalance,
  postLedgerTransaction,
  serializeLedgerTransaction
} from "../wallets/wallet.service";
import { allocateBasisPoints, sumBasisPoints } from "../wallets/ledger.math";

type Db = Prisma.TransactionClient;
type Role = "OWNER" | "ADMIN" | "MEMBER";

const ticketSelect = {
  id: true,
  buyerOrgId: true,
  supplierOrgId: true,
  exporterOrgId: true,
  status: true,
  currency: true,
  totalMinor: true,
  milestones: { orderBy: { sequence: "asc" as const } }
} satisfies Prisma.TicketSelect;

type MilestoneTicket = Prisma.TicketGetPayload<{ select: typeof ticketSelect }>;

function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

async function requireOrgRole(
  db: Db,
  userId: string,
  organizationId: string,
  roles: Role[]
) {
  const membership = await db.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } }
  });
  if (!membership) {
    throw notFound("Organization not found");
  }
  if (!roles.includes(membership.role)) {
    throw forbidden("You do not have permission to perform this action");
  }
  return membership;
}

async function requireTicketAdmin(
  db: Db,
  userId: string,
  platformRole: PlatformRole,
  ticket: MilestoneTicket
): Promise<void> {
  if (isPlatformAdmin(platformRole)) {
    return;
  }

  const organizationIds = [
    ticket.buyerOrgId,
    ticket.supplierOrgId,
    ticket.exporterOrgId
  ].filter((id): id is string => Boolean(id));

  const membership = await db.membership.findFirst({
    where: { userId, organizationId: { in: organizationIds } }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
  if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
    throw forbidden("You do not have permission to perform this action");
  }
}

async function loadTicket(db: Db, ticketId: string): Promise<MilestoneTicket> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    select: ticketSelect
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  return ticket;
}

function requireMilestone(
  ticket: MilestoneTicket,
  milestoneId: string
): MilestoneTicket["milestones"][number] {
  const milestone = ticket.milestones.find((item) => item.id === milestoneId);
  if (!milestone) {
    throw notFound("Milestone not found");
  }
  return milestone;
}

function assertReleaseableTicket(ticket: MilestoneTicket): void {
  if (ticket.status !== "FUNDED" && ticket.status !== "IN_PROGRESS") {
    throw conflict("Ticket must be funded before milestone actions");
  }
}

async function nextSequence(tx: Db, ticketId: string): Promise<number> {
  const result = await tx.milestone.aggregate({
    where: { ticketId },
    _max: { sequence: true }
  });
  return (result._max.sequence ?? 0) + 1;
}

export async function listMilestones(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: ticketSelect
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }

  if (!isPlatformAdmin(platformRole)) {
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

  return ticket.milestones.map(serializeMilestone);
}

export async function createMilestone(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  input: {
    title: string;
    description?: string | null;
    releaseBp: number;
    dueDate?: string | null;
  }
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireOrgRole(tx, userId, ticket.buyerOrgId, ["OWNER", "ADMIN"]);

    if (
      ticket.status !== "DRAFT" &&
      ticket.status !== "AWAITING_ACCEPTANCE" &&
      ticket.status !== "ACTIVE"
    ) {
      throw conflict("Milestones can only be added before the ticket is funded");
    }

    const existingBps = ticket.milestones.map(
      (milestone) => milestone.releaseBp
    );
    if (sumBasisPoints(existingBps) + input.releaseBp > 10_000) {
      throw conflict("Milestone basis points cannot exceed 10000");
    }

    const allBps = [...existingBps, input.releaseBp];
    const amounts = allocateBasisPoints(ticket.totalMinor, allBps);

    for (const [index, milestone] of ticket.milestones.entries()) {
      const amount = amounts[index];
      if (amount !== undefined && amount !== milestone.amountMinor) {
        await tx.milestone.update({
          where: { id: milestone.id },
          data: { amountMinor: amount }
        });
      }
    }

    const sequence = await nextSequence(tx, ticketId);
    const amountMinor = amounts[amounts.length - 1] ?? 0n;

    const milestone = await tx.milestone.create({
      data: {
        ticketId,
        sequence,
        title: input.title,
        description: input.description ?? null,
        releaseBp: input.releaseBp,
        amountMinor,
        dueDate: input.dueDate ? new Date(input.dueDate) : null
      }
    });

    return serializeMilestone(milestone);
  });
}

type MilestoneResponse = {
  milestone: ReturnType<typeof serializeMilestone>;
};

export async function submitMilestone(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  milestoneId: string,
  idempotencyKey: string
): Promise<IdempotentResult<MilestoneResponse>> {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  const scope = idempotencyScope({
    organizationId: ticket.buyerOrgId,
    endpoint: "POST /tickets/:ticketId/milestones/:milestoneId/submit",
    key: idempotencyKey,
    request: { ticketId, milestoneId, action: "SUBMIT" }
  });

  return executeIdempotent<MilestoneResponse>(
    prisma,
    scope,
    async (tx, _ledgerKey) => {
      const current = await loadTicket(tx, ticketId);
      await requireOrgRole(tx, userId, current.supplierOrgId, [
        "OWNER",
        "ADMIN"
      ]);
      assertReleaseableTicket(current);
      const milestone = requireMilestone(current, milestoneId);

      if (
        milestone.status !== "PENDING" &&
        milestone.status !== "REJECTED"
      ) {
        throw conflict("Only pending or rejected milestones can be submitted");
      }

      const evidenceCount = await tx.document.count({
        where: { milestoneId }
      });
      if (evidenceCount === 0) {
        throw conflict(
          "Milestone submission requires at least one evidence document"
        );
      }

      const updated = await tx.milestone.update({
        where: { id: milestoneId },
        data: {
          status: "SUBMITTED",
          submittedById: userId,
          submittedAt: new Date(),
          rejectionNote: null
        }
      });

      if (current.status === "FUNDED") {
        await tx.ticket.update({
          where: { id: ticketId },
          data: { status: "IN_PROGRESS" }
        });
      }

      await recordAudit(tx, {
        actorId: userId,
        actorOrgId: current.supplierOrgId,
        action: "milestone.submit",
        entityType: "Milestone",
        entityId: milestoneId,
        before: { status: milestone.status },
        after: { status: "SUBMITTED" }
      });
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.milestoneSubmitted,
        title: "Milestone submitted for review",
        body: `Milestone "${milestone.title}" was submitted and is awaiting confirmation.`,
        data: { ticketId, milestoneId },
        userIds: await orgMemberIds(tx, current.buyerOrgId)
      });

      return { code: 200, body: { milestone: serializeMilestone(updated) } };
    }
  );
}

export async function confirmMilestone(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  milestoneId: string,
  idempotencyKey: string
): Promise<IdempotentResult<MilestoneResponse>> {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  const scope = idempotencyScope({
    organizationId: ticket.buyerOrgId,
    endpoint: "POST /tickets/:ticketId/milestones/:milestoneId/confirm",
    key: idempotencyKey,
    request: { ticketId, milestoneId, action: "CONFIRM" }
  });

  return executeIdempotent<MilestoneResponse>(
    prisma,
    scope,
    async (tx) => {
      const current = await loadTicket(tx, ticketId);
      await requireOrgRole(tx, userId, current.buyerOrgId, [
        "OWNER",
        "ADMIN"
      ]);
      assertReleaseableTicket(current);
      const milestone = requireMilestone(current, milestoneId);
      if (milestone.status !== "SUBMITTED") {
        throw conflict("Only submitted milestones can be confirmed");
      }

      const updated = await tx.milestone.update({
        where: { id: milestoneId },
        data: {
          status: "CONFIRMED",
          confirmedById: userId,
          confirmedAt: new Date()
        }
      });

      await recordAudit(tx, {
        actorId: userId,
        actorOrgId: current.buyerOrgId,
        action: "milestone.confirm",
        entityType: "Milestone",
        entityId: milestoneId,
        before: { status: milestone.status },
        after: { status: "CONFIRMED" }
      });
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.milestoneConfirmed,
        title: "Milestone confirmed",
        body: `Milestone "${milestone.title}" was confirmed and is ready for release.`,
        data: { ticketId, milestoneId },
        userIds: await orgMemberIds(tx, current.supplierOrgId)
      });

      return { code: 200, body: { milestone: serializeMilestone(updated) } };
    }
  );
}

export async function rejectMilestone(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  milestoneId: string,
  note: string,
  idempotencyKey: string
): Promise<IdempotentResult<MilestoneResponse>> {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  const scope = idempotencyScope({
    organizationId: ticket.buyerOrgId,
    endpoint: "POST /tickets/:ticketId/milestones/:milestoneId/reject",
    key: idempotencyKey,
    request: { ticketId, milestoneId, action: "REJECT", note }
  });

  return executeIdempotent<MilestoneResponse>(
    prisma,
    scope,
    async (tx) => {
      const current = await loadTicket(tx, ticketId);
      await requireOrgRole(tx, userId, current.buyerOrgId, [
        "OWNER",
        "ADMIN"
      ]);
      assertReleaseableTicket(current);
      const milestone = requireMilestone(current, milestoneId);
      if (milestone.status !== "SUBMITTED") {
        throw conflict("Only submitted milestones can be rejected");
      }

      const updated = await tx.milestone.update({
        where: { id: milestoneId },
        data: {
          status: "REJECTED",
          rejectionNote: note,
          confirmedById: userId,
          confirmedAt: new Date()
        }
      });

      await recordAudit(tx, {
        actorId: userId,
        actorOrgId: current.buyerOrgId,
        action: "milestone.reject",
        entityType: "Milestone",
        entityId: milestoneId,
        before: { status: milestone.status },
        after: { status: "REJECTED", note }
      });
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.milestoneRejected,
        title: "Milestone rejected",
        body: `Milestone "${milestone.title}" was rejected: ${note}`,
        data: { ticketId, milestoneId },
        userIds: await orgMemberIds(tx, current.supplierOrgId)
      });

      return { code: 200, body: { milestone: serializeMilestone(updated) } };
    }
  );
}

type ReleaseResponse = {
  ticket: ReturnType<typeof serializeTicket>;
  milestone: ReturnType<typeof serializeMilestone>;
  transaction: ReturnType<typeof serializeLedgerTransaction>;
};

export async function releaseMilestone(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string,
  milestoneId: string,
  idempotencyKey: string
): Promise<IdempotentResult<ReleaseResponse>> {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  await requireTicketAdmin(
    prisma as unknown as Db,
    userId,
    platformRole,
    ticket
  );

  const scope = idempotencyScope({
    organizationId: ticket.buyerOrgId,
    endpoint: "POST /tickets/:ticketId/milestones/:milestoneId/release",
    key: idempotencyKey,
    request: { ticketId, milestoneId, action: "RELEASE" }
  });

  const replay = await readIdempotentResponse<ReleaseResponse>(prisma, scope);
  if (replay) {
    return replay;
  }

  assertReleaseableTicket(ticket);
  const milestone = requireMilestone(ticket, milestoneId);
  if (milestone.status !== "CONFIRMED") {
    throw conflict("Only confirmed milestones can be released");
  }
  if (milestone.amountMinor <= 0n) {
    throw badRequest("Milestone amount must be greater than zero");
  }
  if (!ticket.supplierOrgId) {
    throw conflict("Ticket has no supplier");
  }

  return executeIdempotent<ReleaseResponse>(
    prisma,
    scope,
    async (tx, ledgerKey) => {
      const current = await loadTicket(tx, ticketId);
      await requireTicketAdmin(tx, userId, platformRole, current);
      assertReleaseableTicket(current);
      const currentMilestone = requireMilestone(current, milestoneId);
      if (currentMilestone.status !== "CONFIRMED") {
        throw conflict("Only confirmed milestones can be released");
      }
      if (!current.supplierOrgId) {
        throw conflict("Ticket has no supplier");
      }
      if (currentMilestone.amountMinor <= 0n) {
        throw badRequest("Milestone amount must be greater than zero");
      }

      const amountMinor = currentMilestone.amountMinor;
      const buyerWallet = await ensureWallet(
        tx,
        current.buyerOrgId,
        current.currency
      );
      const supplierWallet = await ensureWallet(
        tx,
        current.supplierOrgId,
        current.currency
      );
      const supplierAccounts = await ensureWalletAccounts(tx, supplierWallet);
      const escrowAccountId = await ensureTicketEscrowAccount(
        tx,
        ticketId,
        current.currency
      );

      const [escrowCredits, escrowDebits] = await Promise.all([
        tx.ledgerEntry.aggregate({
          where: { accountId: escrowAccountId, direction: "CREDIT" },
          _sum: { amountMinor: true }
        }),
        tx.ledgerEntry.aggregate({
          where: { accountId: escrowAccountId, direction: "DEBIT" },
          _sum: { amountMinor: true }
        })
      ]);
      const escrowBalance =
        (escrowCredits._sum.amountMinor ?? 0n) -
        (escrowDebits._sum.amountMinor ?? 0n);
      if (escrowBalance < amountMinor) {
        throw conflict("Ticket escrow does not have enough funds");
      }

      const lockedBuyer = await lockWalletBalance(tx, buyerWallet.id);
      if (buyerWallet.id !== supplierWallet.id) {
        await lockWalletBalance(tx, supplierWallet.id);
      }
      if (lockedBuyer.heldMinor < amountMinor) {
        throw conflict("Buyer wallet does not have enough held funds");
      }

      if (buyerWallet.id === supplierWallet.id) {
        await tx.walletBalance.update({
          where: { walletId: buyerWallet.id },
          data: {
            heldMinor: { decrement: amountMinor },
            availableMinor: { increment: amountMinor }
          }
        });
      } else {
        await tx.walletBalance.update({
          where: { walletId: buyerWallet.id },
          data: { heldMinor: { decrement: amountMinor } }
        });
        await tx.walletBalance.update({
          where: { walletId: supplierWallet.id },
          data: { availableMinor: { increment: amountMinor } }
        });
      }

      const transaction = await postLedgerTransaction(tx, {
        type: "MILESTONE_RELEASE",
        ticketId,
        milestoneId,
        providerRef: null,
        idempotencyKey: ledgerKey,
        entries: [
          {
            accountId: escrowAccountId,
            direction: "DEBIT",
            amountMinor
          },
          {
            accountId: supplierAccounts.availableAccountId,
            direction: "CREDIT",
            amountMinor
          }
        ]
      });

      const updatedMilestone = await tx.milestone.update({
        where: { id: milestoneId },
        data: { status: "RELEASED", releasedAt: new Date() }
      });

      const remaining = await tx.milestone.count({
        where: { ticketId, status: { not: "RELEASED" } }
      });
      if (remaining === 0) {
        await tx.ticket.updateMany({
          where: { id: ticketId, status: { in: ["FUNDED", "IN_PROGRESS"] } },
          data: { status: "COMPLETED", completedAt: new Date() }
        });
      }

      await recordAudit(tx, {
        actorId: userId,
        action: "milestone.release",
        entityType: "Milestone",
        entityId: milestoneId,
        before: { status: "CONFIRMED" },
        after: {
          status: "RELEASED",
          amountMinor: amountMinor.toString(),
          providerRef: null
        }
      });
      const recipientIds = [
        ...(await orgMemberIds(tx, current.buyerOrgId)),
        ...(await orgMemberIds(tx, current.supplierOrgId))
      ];
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.milestoneReleased,
        title: "Milestone funds released",
        body: `Funds for milestone "${currentMilestone.title}" have been released to the supplier.`,
        data: { ticketId, milestoneId },
        userIds: recipientIds
      });

      const fullTicket = await tx.ticket.findUniqueOrThrow({
        where: { id: ticketId },
        include: ticketInclude
      });

      return {
        code: 200,
        body: {
          ticket: serializeTicket(fullTicket),
          milestone: serializeMilestone(updatedMilestone),
          transaction: serializeLedgerTransaction(transaction)
        }
      };
    }
  );
}
