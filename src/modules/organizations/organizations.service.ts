import type { OrgRole, PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import { recordAudit } from "../../common/audit";
import {
  badRequest,
  conflict,
  forbidden,
  notFound
} from "../../common/errors";
import { withTransaction } from "../../common/db";
import { generateToken, hashToken } from "../../common/tokens";
import {
  enqueueNotifications,
  NotificationEvents
} from "../notifications/notification.service";

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CreateOrganizationInput = {
  name: string;
  type: "BUSINESS" | "INDIVIDUAL";
  regNumber?: string;
  roles?: Array<"BUYER" | "SUPPLIER" | "EXPORTER">;
};

export async function createOrganization(
  prisma: PrismaClient,
  userId: string,
  input: CreateOrganizationInput
) {
  return withTransaction(prisma, async (tx) => {
    const organization = await tx.organization.create({
      data: {
        name: input.name,
        type: input.type,
        regNumber: input.regNumber,
        roles: input.roles ?? []
      }
    });

    await tx.membership.create({
      data: { userId, organizationId: organization.id, role: "OWNER" }
    });

    return organization;
  });
}

export async function listOrganizations(
  prisma: PrismaClient,
  userId: string
) {
  return prisma.membership.findMany({
    where: { userId },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          type: true,
          regNumber: true,
          country: true,
          roles: true,
          verification: true,
          createdAt: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
}

export async function listMembers(
  prisma: PrismaClient,
  organizationId: string
) {
  return prisma.membership.findMany({
    where: { organizationId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          phone: true,
          name: true,
          emailVerifiedAt: true
        }
      }
    },
    orderBy: { createdAt: "asc" }
  });
}

export async function inviteMember(
  prisma: PrismaClient,
  organizationId: string,
  invitedById: string,
  email: string,
  role: "ADMIN" | "MEMBER"
) {
  const normalizedEmail = email.trim().toLowerCase();

  const existingUser = await prisma.user.findUnique({
    where: { email: normalizedEmail }
  });

  if (existingUser) {
    const existingMembership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId: existingUser.id,
          organizationId
        }
      }
    });
    if (existingMembership) {
      throw conflict("This user is already a member of the organization");
    }
  }

  const pending = await prisma.invitation.findFirst({
    where: { organizationId, email: normalizedEmail, status: "PENDING" }
  });
  if (pending) {
    throw conflict("A pending invitation already exists for this email");
  }

  const token = generateToken();
  const invitation = await withTransaction(prisma, async (tx) => {
    const record = await tx.invitation.create({
      data: {
        organizationId,
        email: normalizedEmail,
        role,
        invitedById,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS)
      }
    });

    await recordAudit(tx, {
      actorId: invitedById,
      actorOrgId: organizationId,
      action: "invitation.create",
      entityType: "Invitation",
      entityId: record.id,
      after: { email: normalizedEmail, role }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.invitation,
      title: "You have been invited to GreenWallet",
      body: `You have been invited to join an organization. Accept the invitation: ${env.APP_URL}/invitations/accept?token=${token}`,
      data: { organizationId, invitationId: record.id },
      userIds: existingUser ? [existingUser.id] : [],
      emails: [normalizedEmail]
    });

    return record;
  });

  return { invitation, token };
}

export async function listInvitations(
  prisma: PrismaClient,
  organizationId: string
) {
  return prisma.invitation.findMany({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      email: true,
      role: true,
      status: true,
      expiresAt: true,
      acceptedAt: true,
      createdAt: true,
      invitedBy: { select: { id: true, name: true, email: true } }
    }
  });
}

export async function revokeInvitation(
  prisma: PrismaClient,
  organizationId: string,
  invitationId: string
) {
  const invitation = await prisma.invitation.findFirst({
    where: { id: invitationId, organizationId }
  });

  if (!invitation) {
    throw notFound("Invitation not found");
  }
  if (invitation.status !== "PENDING") {
    throw conflict("Only pending invitations can be revoked");
  }

  return prisma.invitation.update({
    where: { id: invitation.id },
    data: { status: "REVOKED" }
  });
}

export async function acceptInvitation(
  prisma: PrismaClient,
  userId: string,
  userEmail: string,
  rawToken: string
) {
  const invitation = await prisma.invitation.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { organization: true }
  });

  if (!invitation) {
    throw badRequest("Invalid invitation token");
  }
  if (invitation.status !== "PENDING") {
    throw badRequest("This invitation is no longer valid");
  }
  if (invitation.expiresAt <= new Date()) {
    await prisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" }
    });
    throw badRequest("This invitation has expired");
  }
  if (invitation.email.toLowerCase() !== userEmail.toLowerCase()) {
    throw forbidden("This invitation was sent to a different email address");
  }

  const membership = await withTransaction(prisma, async (tx) => {
    const record = await tx.membership.upsert({
      where: {
        userId_organizationId: {
          userId,
          organizationId: invitation.organizationId
        }
      },
      update: {},
      create: {
        userId,
        organizationId: invitation.organizationId,
        role: invitation.role
      }
    });

    await tx.invitation.update({
      where: { id: invitation.id },
      data: {
        status: "ACCEPTED",
        acceptedById: userId,
        acceptedAt: new Date()
      }
    });

    await recordAudit(tx, {
      actorId: userId,
      actorOrgId: invitation.organizationId,
      action: "invitation.accept",
      entityType: "Invitation",
      entityId: invitation.id,
      before: { status: "PENDING" },
      after: { status: "ACCEPTED" }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.invitationAccepted,
      title: "Invitation accepted",
      body: `${userEmail} accepted the invitation to join ${invitation.organization.name}.`,
      data: {
        organizationId: invitation.organizationId,
        invitationId: invitation.id
      },
      userIds: [invitation.invitedById]
    });

    return record;
  });

  return { membership, organization: invitation.organization };
}

export async function updateMemberRole(
  prisma: PrismaClient,
  organizationId: string,
  targetUserId: string,
  role: OrgRole
) {
  const target = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId: targetUserId, organizationId }
    }
  });

  if (!target) {
    throw notFound("Member not found");
  }

  if (target.role === "OWNER" && role !== "OWNER") {
    const ownerCount = await prisma.membership.count({
      where: { organizationId, role: "OWNER" }
    });
    if (ownerCount <= 1) {
      throw conflict("The organization must keep at least one owner");
    }
  }

  return prisma.membership.update({
    where: { id: target.id },
    data: { role }
  });
}

export async function removeMember(
  prisma: PrismaClient,
  organizationId: string,
  targetUserId: string
) {
  const target = await prisma.membership.findUnique({
    where: {
      userId_organizationId: { userId: targetUserId, organizationId }
    }
  });

  if (!target) {
    throw notFound("Member not found");
  }

  if (target.role === "OWNER") {
    const ownerCount = await prisma.membership.count({
      where: { organizationId, role: "OWNER" }
    });
    if (ownerCount <= 1) {
      throw conflict("The organization must keep at least one owner");
    }
  }

  await prisma.membership.delete({ where: { id: target.id } });
}
