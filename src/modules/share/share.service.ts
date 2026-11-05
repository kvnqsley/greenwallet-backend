import type { PlatformRole, PrismaClient, ShareLink } from "@prisma/client";
import type { Static } from "@sinclair/typebox";
import { env } from "../../config/env";
import { recordAudit } from "../../common/audit";
import { withTransaction } from "../../common/db";
import { badRequest, conflict, notFound } from "../../common/errors";
import { generateToken, hashToken } from "../../common/tokens";
import type { CreateShareLinkBody } from "./share.schemas";

const DEFAULT_EXPIRY_DAYS = 7;
const MAX_EXPIRY_DAYS = 365;

type TicketAccess = {
  buyerOrgId: string;
  supplierOrgId: string;
  exporterOrgId: string | null;
};

function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

function active(link: ShareLink): boolean {
  return (
    link.revokedAt === null &&
    (link.expiresAt === null || link.expiresAt.getTime() > Date.now())
  );
}

function serializeShareLink(link: ShareLink) {
  return {
    id: link.id,
    ticketId: link.ticketId,
    expiresAt: link.expiresAt,
    revokedAt: link.revokedAt,
    createdAt: link.createdAt,
    active: active(link)
  };
}

async function requireShareAccess(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticket: TicketAccess
) {
  if (isPlatformAdmin(platformRole)) {
    return;
  }
  const partyOrgIds = [
    ticket.buyerOrgId,
    ticket.supplierOrgId,
    ticket.exporterOrgId
  ].filter((id): id is string => Boolean(id));

  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: { in: partyOrgIds } }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
}

function resolveExpiry(expiresAt?: string | null): Date {
  const now = Date.now();
  let expires: Date;

  if (expiresAt === undefined || expiresAt === null) {
    expires = new Date(now + DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  } else {
    const parsed = new Date(expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw badRequest("expiresAt must be a valid date");
    }
    expires = parsed;
  }

  if (expires.getTime() <= now) {
    throw badRequest("expiresAt must be in the future");
  }
  if (expires.getTime() > now + MAX_EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
    throw badRequest(`expiresAt cannot be more than ${MAX_EXPIRY_DAYS} days away`);
  }
  return expires;
}

export async function createShareLink(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string,
  input: Static<typeof CreateShareLinkBody>
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
  await requireShareAccess(prisma, userId, platformRole, ticket);

  const token = generateToken(32);
  const expiresAt = resolveExpiry(input.expiresAt);
  const link = await withTransaction(prisma, async (tx) => {
    const created = await tx.shareLink.create({
      data: {
        ticketId,
        tokenHash: hashToken(token),
        expiresAt
      }
    });
    await recordAudit(tx, {
      actorId: userId,
      action: "share_link.create",
      entityType: "ShareLink",
      entityId: created.id,
      after: { ticketId, expiresAt: expiresAt.toISOString() }
    });
    return created;
  });

  return {
    shareLink: serializeShareLink(link),
    token,
    url: `${env.APP_URL}/public/tickets/${token}`
  };
}

export async function listShareLinks(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
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
  await requireShareAccess(prisma, userId, platformRole, ticket);

  const links = await prisma.shareLink.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });
  return links.map(serializeShareLink);
}

export async function revokeShareLink(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  shareLinkId: string
) {
  const link = await prisma.shareLink.findUnique({
    where: { id: shareLinkId },
    include: {
      ticket: {
        select: {
          id: true,
          buyerOrgId: true,
          supplierOrgId: true,
          exporterOrgId: true
        }
      }
    }
  });
  if (!link) {
    throw notFound("Share link not found");
  }
  await requireShareAccess(prisma, userId, platformRole, link.ticket);

  if (link.revokedAt) {
    throw conflict("This share link has already been revoked");
  }

  const updated = await withTransaction(prisma, async (tx) => {
    const revoked = await tx.shareLink.update({
      where: { id: shareLinkId },
      data: { revokedAt: new Date() }
    });
    await recordAudit(tx, {
      actorId: userId,
      action: "share_link.revoke",
      entityType: "ShareLink",
      entityId: shareLinkId,
      before: { revokedAt: null },
      after: { revokedAt: revoked.revokedAt?.toISOString() ?? null }
    });
    return revoked;
  });
  return { shareLink: serializeShareLink(updated) };
}

export async function resolvePublicTicket(
  prisma: PrismaClient,
  token: string
) {
  const link = await prisma.shareLink.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      ticket: {
        include: {
          buyer: {
            select: { name: true, type: true, roles: true, verification: true }
          },
          supplier: {
            select: { name: true, type: true, roles: true, verification: true }
          },
          exporter: {
            select: { name: true, type: true, roles: true, verification: true }
          },
          parties: {
            orderBy: { createdAt: "asc" as const },
            include: {
              organization: {
                select: { name: true, type: true, verification: true }
              }
            }
          },
          milestones: { orderBy: { sequence: "asc" as const } }
        }
      }
    }
  });

  if (!link || !active(link)) {
    throw notFound("Ticket not found");
  }

  const ticket = link.ticket;
  return {
    shareExpiresAt: link.expiresAt,
    ticket: {
      reference: ticket.reference,
      status: ticket.status,
      version: ticket.version,
      commodity: ticket.commodity,
      grade: ticket.grade,
      quantity: ticket.quantity.toString(),
      unit: ticket.unit,
      unitPriceMinor: ticket.unitPriceMinor.toString(),
      totalMinor: ticket.totalMinor.toString(),
      currency: ticket.currency,
      deliveryTerms: ticket.deliveryTerms,
      deliveryLocation: ticket.deliveryLocation,
      deliveryFrom: ticket.deliveryFrom,
      deliveryTo: ticket.deliveryTo,
      terms: ticket.terms,
      acceptedAt: ticket.acceptedAt,
      fundedAt: ticket.fundedAt,
      completedAt: ticket.completedAt,
      createdAt: ticket.createdAt,
      buyer: ticket.buyer,
      supplier: ticket.supplier,
      exporter: ticket.exporter,
      parties: ticket.parties.map((party) => ({
        role: party.role,
        status: party.status,
        acceptedAt: party.acceptedAt,
        organization: party.organization
      })),
      milestones: ticket.milestones.map((milestone) => ({
        sequence: milestone.sequence,
        title: milestone.title,
        description: milestone.description,
        releaseBp: milestone.releaseBp,
        amountMinor: milestone.amountMinor.toString(),
        dueDate: milestone.dueDate,
        status: milestone.status,
        rejectionNote: milestone.rejectionNote,
        submittedAt: milestone.submittedAt,
        confirmedAt: milestone.confirmedAt,
        releasedAt: milestone.releasedAt
      }))
    }
  };
}
