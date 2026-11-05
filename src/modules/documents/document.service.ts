import type {
  Document,
  DocumentKind,
  PlatformRole,
  PrismaClient
} from "@prisma/client";
import { conflict, forbidden, notFound } from "../../common/errors";
import type { StoragePort, StoragePurpose } from "./storage.port";

const allowedKinds: Record<StoragePurpose, DocumentKind[]> = {
  VERIFICATION: [
    "ID_PROOF",
    "REG_CERT",
    "BANK_STATEMENT",
    "CERTIFICATE",
    "OTHER"
  ],
  TICKET: ["CONTRACT", "INVOICE", "CERTIFICATE", "PDF_EXPORT", "OTHER"],
  EVIDENCE: ["EVIDENCE", "CERTIFICATE", "OTHER"]
};

const mimeTypes: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

type Target = {
  ownerOrgId: string;
  ticketId: string | null;
  milestoneId: string | null;
  verificationCaseId: string | null;
};

function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

export function serializeDocument(document: Document) {
  return {
    id: document.id,
    ownerOrgId: document.ownerOrgId,
    uploadedById: document.uploadedById,
    ticketId: document.ticketId,
    milestoneId: document.milestoneId,
    verificationCaseId: document.verificationCaseId,
    kind: document.kind,
    publicId: document.publicId,
    resourceType: document.resourceType,
    format: document.format,
    originalName: document.originalName,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    checksum: document.checksum,
    createdAt: document.createdAt
  };
}

export async function listTicketDocuments(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    select: {
      buyerOrgId: true,
      supplierOrgId: true,
      exporterOrgId: true
    }
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  await requireTicketRead(prisma, userId, platformRole, ticket);

  const documents = await prisma.document.findMany({
    where: { ticketId },
    orderBy: { createdAt: "desc" }
  });
  return documents.map(serializeDocument);
}

export async function listMilestoneEvidence(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string,
  milestoneId: string
) {
  const milestone = await prisma.milestone.findFirst({
    where: { id: milestoneId, ticketId },
    include: {
      ticket: {
        select: {
          buyerOrgId: true,
          supplierOrgId: true,
          exporterOrgId: true
        }
      }
    }
  });
  if (!milestone) {
    throw notFound("Milestone not found");
  }
  await requireTicketRead(prisma, userId, platformRole, milestone.ticket);

  const documents = await prisma.document.findMany({
    where: { milestoneId },
    orderBy: { createdAt: "desc" }
  });
  return documents.map(serializeDocument);
}

async function requireTicketRead(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    exporterOrgId: string | null;
  }
) {
  if (isPlatformAdmin(platformRole)) {
    return;
  }
  const organizationIds = [
    ticket.buyerOrgId,
    ticket.supplierOrgId,
    ticket.exporterOrgId
  ].filter((id): id is string => Boolean(id));
  const membership = await prisma.membership.findFirst({
    where: { userId, organizationId: { in: organizationIds } }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
}

async function resolveTarget(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  input: {
    purpose: StoragePurpose;
    ticketId?: string;
    milestoneId?: string;
    verificationCaseId?: string;
  }
): Promise<Target> {
  const parentCount = [
    input.ticketId,
    input.milestoneId,
    input.verificationCaseId
  ].filter(Boolean).length;
  if (parentCount !== 1) {
    throw conflict("Exactly one ticket, milestone, or verification case is required");
  }

  if (input.purpose === "VERIFICATION") {
    if (!input.verificationCaseId || input.ticketId || input.milestoneId) {
      throw conflict("Verification documents require a verification case");
    }
    const verification = await prisma.verificationCase.findUnique({
      where: { id: input.verificationCaseId }
    });
    if (!verification) {
      throw notFound("Verification case not found");
    }
    if (verification.status !== "PENDING") {
      throw conflict("Documents can only be added to a pending verification case");
    }
    if (!isPlatformAdmin(platformRole)) {
      const membership = await prisma.membership.findUnique({
        where: {
          userId_organizationId: {
            userId,
            organizationId: verification.organizationId
          }
        }
      });
      if (!membership) {
        throw notFound("Verification case not found");
      }
      if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
        throw forbidden("Only organization owners and admins can add documents");
      }
    }
    return {
      ownerOrgId: verification.organizationId,
      ticketId: null,
      milestoneId: null,
      verificationCaseId: verification.id
    };
  }

  if (input.purpose === "TICKET") {
    if (!input.ticketId || input.milestoneId || input.verificationCaseId) {
      throw conflict("Ticket documents require a ticket");
    }
    const ticket = await prisma.ticket.findUnique({
      where: { id: input.ticketId }
    });
    if (!ticket) {
      throw notFound("Ticket not found");
    }
    if (ticket.status === "CANCELLED") {
      throw conflict("Documents cannot be added to a cancelled ticket");
    }
    if (!isPlatformAdmin(platformRole)) {
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
      return {
        ownerOrgId: membership.organizationId,
        ticketId: ticket.id,
        milestoneId: null,
        verificationCaseId: null
      };
    }
    return {
      ownerOrgId: ticket.buyerOrgId,
      ticketId: ticket.id,
      milestoneId: null,
      verificationCaseId: null
    };
  }

  if (!input.milestoneId || input.ticketId || input.verificationCaseId) {
    throw conflict("Milestone evidence requires a milestone");
  }
  const milestone = await prisma.milestone.findUnique({
    where: { id: input.milestoneId },
    include: { ticket: true }
  });
  if (!milestone) {
    throw notFound("Milestone not found");
  }
  if (milestone.status === "RELEASED") {
    throw conflict("Evidence cannot be added to a released milestone");
  }
  if (
    milestone.ticket.status !== "FUNDED" &&
    milestone.ticket.status !== "IN_PROGRESS"
  ) {
    throw conflict("Milestone evidence can only be added after funding");
  }

  if (!isPlatformAdmin(platformRole)) {
    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: milestone.ticket.supplierOrgId
        }
      }
    });
    if (!membership) {
      throw notFound("Milestone not found");
    }
    if (membership.role !== "OWNER" && membership.role !== "ADMIN") {
      throw forbidden("Only supplier owners and admins can add evidence");
    }
  }

  return {
    ownerOrgId: milestone.ticket.supplierOrgId,
    ticketId: milestone.ticketId,
    milestoneId: milestone.id,
    verificationCaseId: null
  };
}

export async function registerDocument(
  prisma: PrismaClient,
  storage: StoragePort,
  userId: string,
  platformRole: PlatformRole,
  input: {
    purpose: StoragePurpose;
    kind: DocumentKind;
    publicId: string;
    resourceType: string;
    originalName?: string;
    ticketId?: string;
    milestoneId?: string;
    verificationCaseId?: string;
  }
) {
  if (!allowedKinds[input.purpose].includes(input.kind)) {
    throw conflict(`Document kind ${input.kind} is not valid for ${input.purpose}`);
  }

  const target = await resolveTarget(prisma, userId, platformRole, input);
  const config = storage.getUploadConfig(input.purpose);
  const expectedPrefix = `${config.folder}/`;
  if (!input.publicId.startsWith(expectedPrefix)) {
    throw conflict(
      `Uploaded asset must be in the ${config.folder} Cloudinary folder`
    );
  }

  const asset = await storage.getAsset(input.publicId, input.resourceType);
  const format = asset.format.toLowerCase();
  if (!config.allowedFormats.includes(format)) {
    throw conflict(`File format ${format || "unknown"} is not allowed`);
  }
  if (asset.bytes > config.maxBytes) {
    throw conflict("Uploaded file is too large");
  }

  const existing = await prisma.document.findFirst({
    where: {
      publicId: asset.publicId,
      resourceType: asset.resourceType
    }
  });
  if (existing) {
    throw conflict("This uploaded asset is already registered");
  }

  const document = await prisma.document.create({
    data: {
      ownerOrgId: target.ownerOrgId,
      uploadedById: userId,
      ticketId: target.ticketId,
      milestoneId: target.milestoneId,
      verificationCaseId: target.verificationCaseId,
      kind: input.kind,
      storageKey: asset.publicId,
      publicId: asset.publicId,
      secureUrl: asset.secureUrl,
      resourceType: asset.resourceType,
      format,
      originalName: input.originalName ?? asset.originalName,
      mimeType: mimeTypes[format] ?? "application/octet-stream",
      sizeBytes: asset.bytes,
      checksum: asset.etag
    }
  });

  return serializeDocument(document);
}

export async function getDocumentDownload(
  prisma: PrismaClient,
  storage: StoragePort,
  userId: string,
  platformRole: PlatformRole,
  documentId: string
) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: {
      verificationCase: true,
      ticket: {
        select: {
          buyerOrgId: true,
          supplierOrgId: true,
          exporterOrgId: true
        }
      }
    }
  });
  if (!document) {
    throw notFound("Document not found");
  }

  await requireDocumentRead(
    prisma,
    userId,
    platformRole,
    document,
    document.ticket
  );

  if (!document.publicId || !document.resourceType || !document.format) {
    throw conflict("Document does not have a downloadable asset");
  }

  const download = storage.buildDownloadUrl(
    document.publicId,
    document.resourceType,
    document.format
  );
  return {
    document: serializeDocument(document),
    url: download.url,
    expiresAt: download.expiresAt
  };
}

async function requireDocumentRead(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  document: Document,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    exporterOrgId: string | null;
  } | null
) {
  if (isPlatformAdmin(platformRole)) {
    return;
  }
  if (document.verificationCaseId) {
    const verification = await prisma.verificationCase.findUnique({
      where: { id: document.verificationCaseId },
      select: { organizationId: true }
    });
    const membership = verification
      ? await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId,
              organizationId: verification.organizationId
            }
          }
        })
      : null;
    if (!membership) {
      throw notFound("Document not found");
    }
    return;
  }
  if (ticket) {
    await requireTicketRead(prisma, userId, platformRole, ticket);
    return;
  }
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: document.ownerOrgId
      }
    }
  });
  if (!membership) {
    throw notFound("Document not found");
  }
}

export async function deleteDocument(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  documentId: string
) {
  const document = await prisma.document.findUnique({
    where: { id: documentId },
    include: { verificationCase: true, milestone: true, ticket: true }
  });
  if (!document) {
    throw notFound("Document not found");
  }

  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId: document.ownerOrgId
      }
    }
  });
  const canDelete =
    isPlatformAdmin(platformRole) ||
    document.uploadedById === userId ||
    (membership &&
      (membership.role === "OWNER" || membership.role === "ADMIN"));
  if (!canDelete) {
    throw forbidden("You do not have permission to delete this document");
  }

  if (
    document.verificationCase &&
    document.verificationCase.status !== "PENDING"
  ) {
    throw conflict("Documents cannot be removed from a reviewed verification");
  }
  if (document.milestone?.status === "RELEASED") {
    throw conflict("Evidence cannot be removed from a released milestone");
  }
  if (
    document.ticket?.status === "COMPLETED" ||
    document.ticket?.status === "CANCELLED"
  ) {
    throw conflict("Documents cannot be removed from a closed ticket");
  }

  await prisma.document.delete({ where: { id: documentId } });
  return { id: documentId };
}
