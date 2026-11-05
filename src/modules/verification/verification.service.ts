import { randomUUID } from "node:crypto";
import type {
  PlatformRole,
  Prisma,
  PrismaClient,
  VerificationCase,
  VerificationStatus
} from "@prisma/client";
import { withTransaction } from "../../common/db";
import { recordAudit } from "../../common/audit";
import {
  conflict,
  forbidden,
  notFound
} from "../../common/errors";
import {
  enqueueNotifications,
  NotificationEvents,
  orgMemberIds
} from "../notifications/notification.service";
import type {
  NormalizedVerification,
  VerificationProvider
} from "./verification-provider";

const verificationInclude = {
  documents: { orderBy: { createdAt: "desc" as const } },
  reviewedBy: { select: { id: true, name: true } }
} satisfies Prisma.VerificationCaseInclude;

async function requireVerificationMember(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  roles?: Array<"OWNER" | "ADMIN" | "MEMBER">
) {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } }
  });
  if (!membership) {
    throw notFound("Organization not found");
  }
  if (roles && !roles.includes(membership.role)) {
    throw forbidden("You do not have permission to perform this action");
  }
  return membership;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function startVerification(
  prisma: PrismaClient,
  provider: VerificationProvider,
  organizationId: string
) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId }
  });

  if (!organization) {
    throw conflict("Organization not found");
  }
  if (organization.verification === "VERIFIED") {
    throw conflict("Organization is already verified");
  }

  const pending = await prisma.verificationCase.findFirst({
    where: { organizationId, status: "PENDING" }
  });
  if (pending) {
    throw conflict("A verification review is already in progress");
  }

  const referenceId = `GW-VER-${randomUUID()}`;

  const verificationCase = await withTransaction(prisma, async (tx) => {
    const created = await tx.verificationCase.create({
      data: {
        organizationId,
        status: "PENDING",
        provider: provider.name,
        providerRef: referenceId,
        providerStatus: "Ongoing"
      }
    });

    await tx.organization.update({
      where: { id: organizationId },
      data: { verification: "PENDING" }
    });

    return created;
  });

  return {
    verification: verificationCase,
    widget: provider.widgetConfig(referenceId)
  };
}

export async function getLatestVerification(
  prisma: PrismaClient,
  organizationId: string
) {
  return prisma.verificationCase.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" },
    include: verificationInclude
  });
}

export async function listVerificationCases(
  prisma: PrismaClient,
  status?: VerificationStatus
) {
  return prisma.verificationCase.findMany({
    where: status ? { status } : undefined,
    orderBy: { createdAt: "desc" },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          type: true,
          regNumber: true,
          verification: true
        }
      },
      documents: { orderBy: { createdAt: "desc" as const } }
    }
  });
}

export async function applyVerificationResult(
  prisma: PrismaClient,
  verificationCase: VerificationCase,
  result: NormalizedVerification
) {
  return withTransaction(prisma, async (tx) => {
    const current = await tx.verificationCase.findUniqueOrThrow({
      where: { id: verificationCase.id }
    });

    if (current.status !== "PENDING") {
      return tx.verificationCase.findUniqueOrThrow({
        where: { id: current.id },
        include: verificationInclude
      });
    }

    const passed = result.outcome === "PASSED";
    const updated = await tx.verificationCase.update({
      where: { id: current.id },
      data: {
        status: passed ? "VERIFIED" : "PENDING",
        providerStatus: result.providerStatus,
        providerData: toJson(result.raw),
        completedAt: result.completedAt,
        reason: passed ? null : result.reason,
        ...(passed
          ? { reviewedAt: new Date(), reviewedById: null }
          : {})
      },
      include: verificationInclude
    });

    if (passed) {
      await tx.organization.update({
        where: { id: current.organizationId },
        data: { verification: "VERIFIED" }
      });

      await recordAudit(tx, {
        action: "verification.apply",
        entityType: "VerificationCase",
        entityId: current.id,
        before: { status: "PENDING" },
        after: { status: "VERIFIED", providerStatus: result.providerStatus }
      });
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.verificationApproved,
        title: "Organization verified",
        body: "Your organization has been verified. You can now fund and perform tickets.",
        data: { organizationId: current.organizationId },
        userIds: await orgMemberIds(tx, current.organizationId)
      });
    }

    return updated;
  });
}

export async function refreshVerification(
  prisma: PrismaClient,
  provider: VerificationProvider,
  userId: string,
  platformRole: PlatformRole,
  organizationId: string
) {
  const membership = await requireVerificationMember(
    prisma,
    userId,
    organizationId
  );

  if (
    platformRole !== "ADMIN" &&
    platformRole !== "SUPER_ADMIN" &&
    membership.role !== "OWNER" &&
    membership.role !== "ADMIN"
  ) {
    throw forbidden("Only organization owners and admins can refresh verification");
  }

  const verificationCase = await prisma.verificationCase.findFirst({
    where: { organizationId },
    orderBy: { createdAt: "desc" }
  });
  if (!verificationCase) {
    throw notFound("No verification case found for this organization");
  }
  if (!verificationCase.providerRef) {
    throw conflict("Verification case has no provider reference");
  }
  if (verificationCase.provider !== provider.name) {
    throw conflict("Verification case was created with a different provider");
  }
  if (verificationCase.status !== "PENDING") {
    return getLatestVerification(prisma, organizationId);
  }

  const result = await provider.fetchVerification(
    verificationCase.providerRef
  );
  if (!result) {
    throw notFound("Verification result was not found at the provider");
  }

  return applyVerificationResult(prisma, verificationCase, result);
}

export async function processDojahWebhook(
  prisma: PrismaClient,
  rawPayload: unknown
) {
  if (
    typeof rawPayload !== "object" ||
    rawPayload === null ||
    Array.isArray(rawPayload)
  ) {
    return null;
  }

  const referenceId = (rawPayload as Record<string, unknown>).reference_id;
  if (typeof referenceId !== "string" || referenceId.length === 0) {
    return null;
  }

  const verificationCase = await prisma.verificationCase.findFirst({
    where: { provider: "DOJAH", providerRef: referenceId }
  });
  if (!verificationCase) {
    return null;
  }

  const { normalizeDojahVerification } = await import("./dojah.provider");
  const result = normalizeDojahVerification(rawPayload);
  return applyVerificationResult(prisma, verificationCase, result);
}

export async function getVerificationReport(
  prisma: PrismaClient,
  provider: VerificationProvider,
  verificationId: string
) {
  const verificationCase = await prisma.verificationCase.findUnique({
    where: { id: verificationId }
  });
  if (!verificationCase) {
    throw notFound("Verification case not found");
  }
  if (
    verificationCase.provider !== "DOJAH" ||
    !verificationCase.providerRef
  ) {
    throw conflict("This verification case has no Dojah report");
  }

  const report = await provider.fetchVerification(
    verificationCase.providerRef
  );
  if (!report) {
    throw notFound("Dojah verification report was not found");
  }

  return {
    verificationId,
    referenceId: verificationCase.providerRef,
    providerStatus: report.providerStatus,
    outcome: report.outcome,
    report: report.raw
  };
}

export async function reviewVerification(
  prisma: PrismaClient,
  verificationId: string,
  reviewerId: string,
  decision: "APPROVED" | "REJECTED",
  reason?: string
) {
  const verificationCase = await prisma.verificationCase.findUnique({
    where: { id: verificationId }
  });

  if (!verificationCase) {
    throw conflict("Verification case not found");
  }
  if (verificationCase.status !== "PENDING") {
    throw conflict("This verification case has already been reviewed");
  }

  return withTransaction(prisma, async (tx) => {
    const updated = await tx.verificationCase.update({
      where: { id: verificationId },
      data: {
        status: decision === "APPROVED" ? "VERIFIED" : "REJECTED",
        reviewedById: reviewerId,
        reviewedAt: new Date(),
        completedAt: new Date(),
        reason: decision === "REJECTED" ? reason : null
      },
      include: verificationInclude
    });

    await tx.organization.update({
      where: { id: verificationCase.organizationId },
      data: {
        verification: decision === "APPROVED" ? "VERIFIED" : "REJECTED"
      }
    });

    await recordAudit(tx, {
      actorId: reviewerId,
      action: "verification.review",
      entityType: "VerificationCase",
      entityId: verificationId,
      before: { status: "PENDING" },
      after: {
        status: decision === "APPROVED" ? "VERIFIED" : "REJECTED",
        reason: reason ?? null
      }
    });
    await enqueueNotifications(tx, {
      eventType:
        decision === "APPROVED"
          ? NotificationEvents.verificationApproved
          : NotificationEvents.verificationRejected,
      title:
        decision === "APPROVED"
          ? "Organization verified"
          : "Verification rejected",
      body:
        decision === "APPROVED"
          ? "Your organization has been verified. You can now fund and perform tickets."
          : `Your organization verification was rejected${reason ? `: ${reason}` : "."}`,
      data: { organizationId: verificationCase.organizationId },
      userIds: await orgMemberIds(tx, verificationCase.organizationId)
    });

    return updated;
  });
}
