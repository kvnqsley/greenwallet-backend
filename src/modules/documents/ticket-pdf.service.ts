import { createHash } from "node:crypto";
import PDFDocument from "pdfkit";
import type { PlatformRole, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { notFound } from "../../common/errors";
import type { StoragePort } from "./storage.port";
import { serializeDocument } from "./document.service";

const PAGE_MARGIN = 50;

const pdfTicketInclude = {
  buyer: {
    select: { id: true, name: true, type: true, verification: true }
  },
  supplier: {
    select: { id: true, name: true, type: true, verification: true }
  },
  exporter: {
    select: { id: true, name: true, type: true, verification: true }
  },
  parties: {
    orderBy: { createdAt: "asc" as const },
    include: {
      organization: { select: { name: true, type: true, verification: true } },
      acceptedBy: { select: { id: true, name: true } }
    }
  },
  milestones: { orderBy: { sequence: "asc" as const } }
} satisfies Prisma.TicketInclude;

type PdfTicket = Prisma.TicketGetPayload<{ include: typeof pdfTicketInclude }>;
type PdfDocument = InstanceType<typeof PDFDocument>;

function formatMoney(minor: bigint, currency: string): string {
  const padded = minor.toString().padStart(3, "0");
  return `${currency} ${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function formatPercent(basisPoints: number): string {
  return `${(basisPoints / 100).toFixed(2)}%`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      result[key] = canonicalize(source[key]);
    }
    return result;
  }
  return value;
}

function ticketSnapshotHash(ticket: PdfTicket): string {
  const snapshot = {
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
    buyer: ticket.buyer,
    supplier: ticket.supplier,
    exporter: ticket.exporter,
    parties: ticket.parties.map((party) => ({
      role: party.role,
      status: party.status,
      organization: party.organization,
      acceptedAt: party.acceptedAt,
      acceptedBy: party.acceptedBy
    })),
    milestones: ticket.milestones.map((milestone) => ({
      sequence: milestone.sequence,
      title: milestone.title,
      description: milestone.description,
      releaseBp: milestone.releaseBp,
      amountMinor: milestone.amountMinor.toString(),
      dueDate: milestone.dueDate,
      status: milestone.status
    }))
  };
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(snapshot)))
    .digest("hex");
}

function writeSectionTitle(doc: PdfDocument, title: string) {
  doc.moveDown(0.6);
  doc
    .font("Helvetica-Bold")
    .fontSize(13)
    .fillColor("#111111")
    .text(title);
  doc.moveDown(0.2);
  doc
    .moveTo(PAGE_MARGIN, doc.y)
    .lineTo(doc.page.width - PAGE_MARGIN, doc.y)
    .lineWidth(0.5)
    .strokeColor("#cccccc")
    .stroke();
  doc.moveDown(0.4);
  doc.font("Helvetica").fontSize(10).fillColor("#1a1a1a");
}

function writeField(doc: PdfDocument, label: string, value: string) {
  doc
    .fillColor("#555555")
    .fontSize(9)
    .text(`${label}: `, { continued: true })
    .fillColor("#1a1a1a")
    .text(value);
  doc.moveDown(0.15);
}

function writeMilestoneTable(doc: PdfDocument, ticket: PdfTicket) {
  doc.font("Courier-Bold").fontSize(8.5).fillColor("#111111");
  doc.text(
    [
      "#".padEnd(4),
      "Title".padEnd(30),
      "Share".padStart(8),
      "Amount".padStart(18),
      "Status".padEnd(14)
    ].join(" ")
  );
  doc.font("Courier").fontSize(8.5).fillColor("#1a1a1a");
  for (const milestone of ticket.milestones) {
    doc.text(
      [
        String(milestone.sequence).padEnd(4),
        truncate(milestone.title, 29).padEnd(30),
        formatPercent(milestone.releaseBp).padStart(8),
        formatMoney(milestone.amountMinor, ticket.currency).padStart(18),
        milestone.status.padEnd(14)
      ].join(" ")
    );
  }
  doc.font("Helvetica").fontSize(10);
}

function writePdfContent(
  doc: PdfDocument,
  ticket: PdfTicket,
  snapshotHash: string,
  generatedAt: Date
) {
  doc
    .font("Helvetica-Bold")
    .fontSize(20)
    .fillColor("#111111")
    .text("GreenWallet Trade Ticket");
  doc
    .font("Helvetica")
    .fontSize(11)
    .fillColor("#555555")
    .text(`${ticket.reference} · generated ${generatedAt.toISOString()}`);

  writeSectionTitle(doc, "Parties");
  writeField(
    doc,
    "Buyer",
    `${ticket.buyer.name} (${ticket.buyer.verification})`
  );
  writeField(
    doc,
    "Supplier",
    `${ticket.supplier.name} (${ticket.supplier.verification})`
  );
  writeField(
    doc,
    "Exporter",
    ticket.exporter
      ? `${ticket.exporter.name} (${ticket.exporter.verification})`
      : "None"
  );
  writeField(doc, "Status", ticket.status);
  writeField(doc, "Version", String(ticket.version));

  writeSectionTitle(doc, "Commodity & Terms");
  writeField(doc, "Commodity", ticket.commodity);
  writeField(doc, "Grade", ticket.grade ?? "—");
  writeField(
    doc,
    "Quantity",
    `${ticket.quantity.toString()} ${ticket.unit}`
  );
  writeField(
    doc,
    "Unit price",
    formatMoney(ticket.unitPriceMinor, ticket.currency)
  );
  writeField(doc, "Total", formatMoney(ticket.totalMinor, ticket.currency));
  writeField(doc, "Delivery terms", ticket.deliveryTerms ?? "—");
  writeField(doc, "Delivery location", ticket.deliveryLocation ?? "—");
  writeField(
    doc,
    "Delivery window",
    `${ticket.deliveryFrom?.toISOString().slice(0, 10) ?? "—"} to ${
      ticket.deliveryTo?.toISOString().slice(0, 10) ?? "—"
    }`
  );
  writeField(doc, "Terms", ticket.terms ?? "—");

  writeSectionTitle(doc, "Milestones");
  writeMilestoneTable(doc, ticket);

  writeSectionTitle(doc, "Acceptance Manifest");
  for (const party of ticket.parties) {
    writeField(
      doc,
      party.role,
      `${party.organization.name} · ${party.status} · ${
        party.acceptedAt?.toISOString() ?? "not accepted"
      }${party.acceptedBy ? ` by ${party.acceptedBy.name}` : ""}`
    );
  }

  doc.moveDown(0.8);
  doc.font("Helvetica").fontSize(8).fillColor("#666666");
  doc.text("Ticket snapshot hash (SHA-256):");
  doc.font("Courier").fontSize(7).fillColor("#888888").text(snapshotHash);
}

function renderTicketPdf(
  ticket: PdfTicket,
  snapshotHash: string,
  generatedAt: Date
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: PAGE_MARGIN,
      info: {
        Title: `GreenWallet Trade Ticket ${ticket.reference}`,
        Author: "GreenWallet",
        Subject: "Trade ticket export",
        Creator: "GreenWallet API"
      }
    });

    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    try {
      writePdfContent(doc, ticket, snapshotHash, generatedAt);
    } catch (error) {
      doc.end();
      reject(error);
      return;
    }
    doc.end();
  });
}

function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

async function requirePdfAccess(
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

export async function generateTicketPdf(
  prisma: PrismaClient,
  storage: StoragePort,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
) {
  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: pdfTicketInclude
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  await requirePdfAccess(prisma, userId, platformRole, ticket);

  const generatedAt = new Date();
  const snapshotHash = ticketSnapshotHash(ticket);
  const buffer = await renderTicketPdf(ticket, snapshotHash, generatedAt);

  const config = storage.getUploadConfig("TICKET");
  const publicId = `${config.folder}/pdf/${ticket.reference}-${generatedAt.getTime()}.pdf`;
  const asset = await storage.upload({
    purpose: "TICKET",
    publicId,
    buffer,
    resourceType: "raw",
    format: "pdf",
    contentType: "application/pdf"
  });

  const document = await prisma.document.create({
    data: {
      ownerOrgId: ticket.buyerOrgId,
      uploadedById: userId,
      ticketId,
      kind: "PDF_EXPORT",
      storageKey: asset.publicId,
      publicId: asset.publicId,
      secureUrl: asset.secureUrl,
      resourceType: asset.resourceType,
      format: asset.format,
      originalName: `${ticket.reference}.pdf`,
      mimeType: "application/pdf",
      sizeBytes: asset.bytes,
      checksum: asset.etag
    }
  });

  const download = storage.buildDownloadUrl(
    asset.publicId,
    asset.resourceType,
    asset.format
  );

  return {
    document: serializeDocument(document),
    download,
    snapshotHash
  };
}
