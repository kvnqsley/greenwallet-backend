import type { Prisma, PrismaClient } from "@prisma/client";
import type { Static } from "@sinclair/typebox";
import { recordAudit } from "../../common/audit";
import { withTransaction } from "../../common/db";
import { conflict, notFound } from "../../common/errors";
import {
  enqueueNotifications,
  NotificationEvents,
  orgMemberIds
} from "../notifications/notification.service";
import {
  serializeTicket,
  ticketInclude
} from "../tickets/ticket.service";
import type {
  AdminAuditQuery,
  AdminTicketListQuery
} from "./admin.schemas";

export async function listAdminTickets(
  prisma: PrismaClient,
  query: Static<typeof AdminTicketListQuery>
) {
  const filters: Prisma.TicketWhereInput[] = [];

  if (query.status) {
    filters.push({ status: query.status });
  }
  if (query.organizationId) {
    filters.push({
      OR: [
        { buyerOrgId: query.organizationId },
        { supplierOrgId: query.organizationId },
        { exporterOrgId: query.organizationId }
      ]
    });
  }
  if (query.commodity) {
    filters.push({
      commodity: { contains: query.commodity, mode: "insensitive" }
    });
  }
  if (query.flaggedOnly) {
    filters.push({ flaggedAt: { not: null } });
  }

  const limit = query.limit ?? 20;
  const tickets = await prisma.ticket.findMany({
    where: filters.length > 0 ? { AND: filters } : {},
    include: ticketInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
  });

  const hasMore = tickets.length > limit;
  const page = hasMore ? tickets.slice(0, limit) : tickets;
  const last = page[page.length - 1];

  return {
    tickets: page.map(serializeTicket),
    nextCursor: hasMore && last ? last.id : null
  };
}

export async function flagTicket(
  prisma: PrismaClient,
  actorId: string,
  ticketId: string,
  reason?: string
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await tx.ticket.findUnique({
      where: { id: ticketId },
      include: ticketInclude
    });
    if (!ticket) {
      throw notFound("Ticket not found");
    }
    if (ticket.flaggedAt) {
      throw conflict("Ticket is already flagged");
    }

    const flaggedAt = new Date();
    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data: { flaggedById: actorId, flaggedAt },
      include: ticketInclude
    });

    await recordAudit(tx, {
      actorId,
      action: "ticket.flag",
      entityType: "Ticket",
      entityId: ticketId,
      before: { reference: ticket.reference, status: ticket.status, flaggedAt: null },
      after: { flaggedById: actorId, flaggedAt: flaggedAt.toISOString(), reason: reason ?? null }
    });

    const recipientIds = [
      ...(await orgMemberIds(tx, ticket.buyerOrgId)),
      ...(await orgMemberIds(tx, ticket.supplierOrgId))
    ];
    if (ticket.exporterOrgId) {
      recipientIds.push(...(await orgMemberIds(tx, ticket.exporterOrgId)));
    }

    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketFlagged,
      title: "Ticket flagged for review",
      body: `Ticket ${ticket.reference} has been flagged by the platform${
        reason ? `: ${reason}` : "."
      }`,
      data: { ticketId },
      userIds: recipientIds
    });

    return serializeTicket(updated);
  });
}

export async function listAuditEvents(
  prisma: PrismaClient,
  query: Static<typeof AdminAuditQuery>
) {
  const filters: Prisma.AuditEventWhereInput[] = [];
  if (query.entityType) {
    filters.push({ entityType: query.entityType });
  }
  if (query.entityId) {
    filters.push({ entityId: query.entityId });
  }
  if (query.actorId) {
    filters.push({ actorId: query.actorId });
  }
  if (query.action) {
    filters.push({ action: query.action });
  }

  const limit = query.limit ?? 20;
  const events = await prisma.auditEvent.findMany({
    where: filters.length > 0 ? { AND: filters } : {},
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
  });

  const hasMore = events.length > limit;
  const page = hasMore ? events.slice(0, limit) : events;
  const last = page[page.length - 1];

  return {
    events: page,
    nextCursor: hasMore && last ? last.id : null
  };
}
