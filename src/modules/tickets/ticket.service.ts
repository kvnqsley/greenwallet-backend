import type { PlatformRole, PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { Static } from "@sinclair/typebox";
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
import { sumBasisPoints } from "../wallets/ledger.math";
import { assertTicketTransition } from "./ticket.state";
import type {
  AddPartyBody,
  AmendmentDecisionBody,
  CreateAmendmentBody,
  CreateTicketBody,
  DisputeBody,
  TicketListQuery,
  TicketPatch,
  UpdateTicketBody
} from "./ticket.schemas";

type Db = Prisma.TransactionClient;
type TicketPatchInput = Static<typeof TicketPatch>;

const organizationSummary = {
  id: true,
  name: true,
  verification: true,
  roles: true
} satisfies Prisma.OrganizationSelect;

export const ticketInclude = {
  buyer: { select: organizationSummary },
  supplier: { select: organizationSummary },
  exporter: { select: organizationSummary },
  createdBy: { select: { id: true, name: true, email: true } },
  parties: {
    include: { organization: { select: organizationSummary } },
    orderBy: { createdAt: "asc" as const }
  },
  milestones: {
    orderBy: { sequence: "asc" as const }
  }
} satisfies Prisma.TicketInclude;

const amendmentInclude = {
  proposedBy: { select: { id: true, name: true, email: true } }
} satisfies Prisma.TicketAmendmentInclude;

export type TicketWithRelations = Prisma.TicketGetPayload<{
  include: typeof ticketInclude;
}>;

type AmendmentWithRelations = Prisma.TicketAmendmentGetPayload<{
  include: typeof amendmentInclude;
}>;

type TicketMoneyState = {
  quantity: Prisma.Decimal;
  unitPriceMinor: bigint;
  exporterOrgId: string | null;
};

export function isPlatformAdmin(role: PlatformRole): boolean {
  return role === "ADMIN" || role === "SUPER_ADMIN";
}

function serializeParty(party: TicketWithRelations["parties"][number]) {
  return {
    id: party.id,
    organizationId: party.organizationId,
    role: party.role,
    status: party.status,
    invitedEmail: party.invitedEmail,
    acceptedById: party.acceptedById,
    acceptedAt: party.acceptedAt,
    createdAt: party.createdAt,
    updatedAt: party.updatedAt,
    organization: party.organization
  };
}

function serializeMilestone(
  milestone: TicketWithRelations["milestones"][number]
) {
  return {
    id: milestone.id,
    ticketId: milestone.ticketId,
    sequence: milestone.sequence,
    title: milestone.title,
    description: milestone.description,
    releaseBp: milestone.releaseBp,
    amountMinor: milestone.amountMinor.toString(),
    dueDate: milestone.dueDate,
    status: milestone.status,
    submittedById: milestone.submittedById,
    submittedAt: milestone.submittedAt,
    confirmedById: milestone.confirmedById,
    confirmedAt: milestone.confirmedAt,
    releasedAt: milestone.releasedAt,
    rejectionNote: milestone.rejectionNote,
    createdAt: milestone.createdAt,
    updatedAt: milestone.updatedAt
  };
}

export function serializeTicket(ticket: TicketWithRelations) {
  return {
    id: ticket.id,
    reference: ticket.reference,
    title: ticket.title,
    buyerOrgId: ticket.buyerOrgId,
    supplierOrgId: ticket.supplierOrgId,
    exporterOrgId: ticket.exporterOrgId,
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
    createdById: ticket.createdById,
    acceptedAt: ticket.acceptedAt,
    fundedAt: ticket.fundedAt,
    completedAt: ticket.completedAt,
    flaggedById: ticket.flaggedById,
    flaggedAt: ticket.flaggedAt,
    disputeReason: ticket.disputeReason,
    disputedAt: ticket.disputedAt,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
    buyer: ticket.buyer,
    supplier: ticket.supplier,
    exporter: ticket.exporter,
    createdBy: ticket.createdBy,
    parties: ticket.parties.map(serializeParty),
    milestones: ticket.milestones.map(serializeMilestone)
  };
}

export { serializeMilestone };

function serializeAmendment(amendment: AmendmentWithRelations) {
  return {
    id: amendment.id,
    ticketId: amendment.ticketId,
    status: amendment.status,
    patch: amendment.patch,
    proposedById: amendment.proposedById,
    approvedByBuyerAt: amendment.approvedByBuyerAt,
    approvedBySupplierAt: amendment.approvedBySupplierAt,
    createdAt: amendment.createdAt,
    updatedAt: amendment.updatedAt,
    proposedBy: amendment.proposedBy
  };
}

function partyOrgIds(ticket: {
  buyerOrgId: string;
  supplierOrgId: string;
  exporterOrgId: string | null;
}): string[] {
  return [ticket.buyerOrgId, ticket.supplierOrgId, ticket.exporterOrgId].filter(
    (id): id is string => Boolean(id)
  );
}

async function creatorOrganizationId(
  db: Db,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    createdById: string;
  }
): Promise<string | null> {
  const membership = await db.membership.findFirst({
    where: {
      userId: ticket.createdById,
      organizationId: { in: [ticket.buyerOrgId, ticket.supplierOrgId] }
    },
    select: { organizationId: true }
  });
  return membership?.organizationId ?? null;
}

async function ticketPartyUserIds(
  db: Db,
  ticket: {
    buyerOrgId: string;
    supplierOrgId: string;
    exporterOrgId: string | null;
  }
): Promise<string[]> {
  const members = await Promise.all(
    partyOrgIds(ticket).map((orgId) => orgMemberIds(db, orgId))
  );
  return [...new Set(members.flat())];
}

async function loadTicket(db: Db, ticketId: string): Promise<TicketWithRelations> {
  const ticket = await db.ticket.findUnique({
    where: { id: ticketId },
    include: ticketInclude
  });
  if (!ticket) {
    throw notFound("Ticket not found");
  }
  return ticket;
}

async function requireTicketMembership(
  db: Db,
  userId: string,
  ticket: { buyerOrgId: string; supplierOrgId: string; exporterOrgId: string | null }
) {
  const membership = await db.membership.findFirst({
    where: {
      userId,
      organizationId: { in: partyOrgIds(ticket) }
    },
    select: { id: true, organizationId: true, role: true }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
  return membership;
}

async function requireBuyerOrSupplier(
  db: Db,
  userId: string,
  ticket: { buyerOrgId: string; supplierOrgId: string }
) {
  const membership = await db.membership.findFirst({
    where: {
      userId,
      organizationId: { in: [ticket.buyerOrgId, ticket.supplierOrgId] }
    },
    select: { id: true, organizationId: true, role: true }
  });
  if (!membership) {
    throw notFound("Ticket not found");
  }
  return membership;
}

async function findPartyMembership(
  db: Db,
  userId: string,
  ticket: { buyerOrgId: string; supplierOrgId: string; exporterOrgId: string | null },
  organizationId?: string
) {
  const memberships = await db.membership.findMany({
    where: {
      userId,
      organizationId: { in: partyOrgIds(ticket) }
    },
    select: { organizationId: true }
  });

  if (organizationId) {
    const match = memberships.find(
      (membership) => membership.organizationId === organizationId
    );
    if (!match) {
      throw forbidden("You are not a party to this ticket");
    }
    return match;
  }

  const first = memberships[0];
  if (!first) {
    throw forbidden("You are not a party to this ticket");
  }
  if (memberships.length > 1) {
    throw badRequest(
      "Specify organizationId to choose which party is acting on this ticket"
    );
  }
  return first;
}

function parseQuantity(value: string): Prisma.Decimal {
  let quantity: Prisma.Decimal;
  try {
    quantity = new Prisma.Decimal(value);
  } catch {
    throw badRequest("quantity must be a valid decimal");
  }
  if (!quantity.isFinite() || quantity.lte(0)) {
    throw badRequest("quantity must be greater than zero");
  }
  if (quantity.decimalPlaces() > 3) {
    throw badRequest("quantity supports at most three decimal places");
  }
  return quantity;
}

export function parseMinorAmount(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw badRequest(`${field} must be an integer amount in minor units`);
  }
  const amount = BigInt(value);
  if (amount <= 0n) {
    throw badRequest(`${field} must be greater than zero`);
  }
  return amount;
}

export function parseExpectedTotal(
  value: string | undefined,
  required: boolean
): bigint | null {
  if (value === undefined) {
    if (required) {
      throw badRequest(
        "expectedTotalMinor is required when the ticket amount changes"
      );
    }
    return null;
  }
  return parseMinorAmount(value, "expectedTotalMinor");
}

function parseDate(
  value: string | null | undefined,
  field: string
): Date | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${field} must be a valid ISO date`);
  }
  return date;
}

function buildScalarUpdate(
  ticket: TicketMoneyState,
  patch: TicketPatchInput,
  expectedTotalMinor: string | undefined
): {
  data: Prisma.TicketUncheckedUpdateInput;
  exporterChanged: boolean;
} {
  const data: Prisma.TicketUncheckedUpdateInput = {};

  if (patch.title !== undefined) data.title = patch.title;
  if (patch.commodity !== undefined) data.commodity = patch.commodity;
  if (patch.grade !== undefined) data.grade = patch.grade;
  if (patch.unit !== undefined) data.unit = patch.unit;
  if (patch.deliveryTerms !== undefined) {
    data.deliveryTerms = patch.deliveryTerms;
  }
  if (patch.deliveryLocation !== undefined) {
    data.deliveryLocation = patch.deliveryLocation;
  }
  if (patch.terms !== undefined) data.terms = patch.terms;

  const deliveryFrom = parseDate(patch.deliveryFrom, "deliveryFrom");
  if (deliveryFrom !== undefined) data.deliveryFrom = deliveryFrom;
  const deliveryTo = parseDate(patch.deliveryTo, "deliveryTo");
  if (deliveryTo !== undefined) data.deliveryTo = deliveryTo;

  let quantity = ticket.quantity;
  let unitPriceMinor = ticket.unitPriceMinor;
  let moneyChanged = false;

  if (patch.quantity !== undefined) {
    quantity = parseQuantity(patch.quantity);
    moneyChanged = true;
  }
  if (patch.unitPriceMinor !== undefined) {
    unitPriceMinor = parseMinorAmount(
      patch.unitPriceMinor,
      "unitPriceMinor"
    );
    moneyChanged = true;
  }
  if (moneyChanged) {
    data.quantity = quantity;
    data.unitPriceMinor = unitPriceMinor;
  }

  const totalMinor = parseExpectedTotal(expectedTotalMinor, moneyChanged);
  if (totalMinor !== null) {
    data.totalMinor = totalMinor;
  }

  const exporterChanged =
    patch.exporterOrgId !== undefined &&
    patch.exporterOrgId !== ticket.exporterOrgId;
  if (exporterChanged) {
    data.exporterOrgId = patch.exporterOrgId;
  }

  return {
    data,
    exporterChanged
  };
}

async function ensureExporterAllowed(
  db: Db,
  ticket: { buyerOrgId: string; supplierOrgId: string },
  exporterOrgId: string
): Promise<void> {
  if (
    exporterOrgId === ticket.buyerOrgId ||
    exporterOrgId === ticket.supplierOrgId
  ) {
    throw badRequest(
      "Exporter must be different from the buyer and supplier organizations"
    );
  }
  const exporter = await db.organization.findUnique({
    where: { id: exporterOrgId },
    select: { id: true }
  });
  if (!exporter) {
    throw notFound("Exporter organization not found");
  }
}

async function applyExporterChange(
  db: Db,
  ticket: { id: string; buyerOrgId: string; supplierOrgId: string },
  exporterOrgId: string | null
): Promise<void> {
  if (exporterOrgId) {
    await ensureExporterAllowed(db, ticket, exporterOrgId);
  }
  await db.ticketParty.deleteMany({
    where: { ticketId: ticket.id, role: "EXPORTER" }
  });
  if (exporterOrgId) {
    await db.ticketParty.create({
      data: {
        ticketId: ticket.id,
        organizationId: exporterOrgId,
        role: "EXPORTER",
        status: "INVITED"
      }
    });
  }
}

function isReferenceConflict(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002" &&
    JSON.stringify(error.meta?.target ?? "").includes("reference")
  );
}

async function nextTicketReference(db: Db): Promise<string> {
  const year = new Date().getUTCFullYear();
  const prefix = `GW-${year}-`;
  const last = await db.ticket.findFirst({
    where: { reference: { startsWith: prefix } },
    orderBy: { reference: "desc" },
    select: { reference: true }
  });

  const sequence = last
    ? Number.parseInt(last.reference.slice(prefix.length), 10) + 1
    : 1;
  if (!Number.isFinite(sequence) || sequence > 999999) {
    throw conflict("Ticket reference sequence exhausted for the year");
  }
  return `${prefix}${String(sequence).padStart(6, "0")}`;
}

export async function createTicket(
  prisma: PrismaClient,
  userId: string,
  input: Static<typeof CreateTicketBody>
) {
  const quantity = parseQuantity(input.quantity);
  const unitPriceMinor = parseMinorAmount(
    input.unitPriceMinor,
    "unitPriceMinor"
  );
  const totalMinor = parseMinorAmount(
    input.expectedTotalMinor,
    "expectedTotalMinor"
  );
  const exporterOrgId = input.exporterOrgId ?? null;

  const [buyer, supplier] = await Promise.all([
    prisma.organization.findUnique({
      where: { id: input.buyerOrgId },
      select: { id: true }
    }),
    prisma.organization.findUnique({
      where: { id: input.supplierOrgId },
      select: { id: true }
    })
  ]);

  if (!buyer) throw notFound("Buyer organization not found");
  if (!supplier) throw notFound("Supplier organization not found");
  if (buyer.id === supplier.id) {
    throw badRequest("Buyer and supplier must be different organizations");
  }
  if (exporterOrgId) {
    await ensureExporterAllowed(
      prisma as unknown as Db,
      { buyerOrgId: buyer.id, supplierOrgId: supplier.id },
      exporterOrgId
    );
  }

  const membership = await prisma.membership.findFirst({
    where: {
      userId,
      organizationId: { in: [buyer.id, supplier.id] }
    },
    select: { id: true, organizationId: true }
  });
  if (!membership) {
    throw forbidden(
      "You must belong to the buyer or supplier organization to create this ticket"
    );
  }

  const creatorAcceptedAt = new Date();
  const partyInputs: Array<{
    organizationId: string;
    role: "BUYER" | "SUPPLIER" | "EXPORTER";
    status?: "ACCEPTED";
    acceptedById?: string;
    acceptedAt?: Date;
  }> = [
    {
      organizationId: buyer.id,
      role: "BUYER",
      ...(membership.organizationId === buyer.id
        ? {
            status: "ACCEPTED" as const,
            acceptedById: userId,
            acceptedAt: creatorAcceptedAt
          }
        : {})
    },
    {
      organizationId: supplier.id,
      role: "SUPPLIER",
      ...(membership.organizationId === supplier.id
        ? {
            status: "ACCEPTED" as const,
            acceptedById: userId,
            acceptedAt: creatorAcceptedAt
          }
        : {})
    }
  ];
  if (exporterOrgId) {
    partyInputs.push({ organizationId: exporterOrgId, role: "EXPORTER" });
  }

  const data: Omit<Prisma.TicketUncheckedCreateInput, "reference"> = {
    title: input.title ?? null,
    buyerOrgId: buyer.id,
    supplierOrgId: supplier.id,
    exporterOrgId,
    commodity: input.commodity,
    grade: input.grade ?? null,
    quantity,
    unit: input.unit,
    unitPriceMinor,
    totalMinor,
    currency: input.currency ?? "NGN",
    deliveryTerms: input.deliveryTerms ?? null,
    deliveryLocation: input.deliveryLocation ?? null,
    deliveryFrom: parseDate(input.deliveryFrom, "deliveryFrom") ?? null,
    deliveryTo: parseDate(input.deliveryTo, "deliveryTo") ?? null,
    terms: input.terms ?? null,
    createdById: userId
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const reference = await nextTicketReference(prisma as unknown as Db);
    try {
      const ticket = await withTransaction(prisma, async (tx) => {
        const created = await tx.ticket.create({
          data: { ...data, reference }
        });
        await tx.ticketParty.createMany({
          data: partyInputs.map((party) => ({
            ticketId: created.id,
            organizationId: party.organizationId,
            role: party.role,
            status: party.status,
            acceptedById: party.acceptedById,
            acceptedAt: party.acceptedAt
          }))
        });
        return tx.ticket.findUniqueOrThrow({
          where: { id: created.id },
          include: ticketInclude
        });
      });
      return serializeTicket(ticket);
    } catch (error) {
      if (isReferenceConflict(error)) {
        continue;
      }
      throw error;
    }
  }

  throw conflict("Could not allocate a ticket reference, please retry");
}

export async function listTickets(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  query: Static<typeof TicketListQuery>
) {
  const filters: Prisma.TicketWhereInput[] = [];
  const admin = isPlatformAdmin(platformRole);

  if (!admin) {
    const memberships = await prisma.membership.findMany({
      where: { userId },
      select: { organizationId: true }
    });
    const orgIds = memberships.map((membership) => membership.organizationId);
    if (orgIds.length === 0) {
      return { tickets: [], nextCursor: null };
    }
    filters.push({
      OR: [
        { buyerOrgId: { in: orgIds } },
        { supplierOrgId: { in: orgIds } },
        { exporterOrgId: { in: orgIds } }
      ]
    });
    filters.push({
      NOT: {
        AND: [
          { status: "DRAFT" },
          {
            OR: [
              { buyerOrgId: { in: orgIds } },
              { supplierOrgId: { in: orgIds } }
            ]
          },
          { NOT: { createdBy: { memberships: { some: { organizationId: { in: orgIds } } } } } }
        ]
      }
    });
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
  if (query.status) {
    filters.push({ status: query.status });
  }
  if (query.commodity) {
    filters.push({
      commodity: { contains: query.commodity, mode: "insensitive" }
    });
  }

  const limit = query.limit ?? 20;
  const tickets = await prisma.ticket.findMany({
    where: filters.length > 0 ? { AND: filters } : {},
    include: ticketInclude,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor
      ? { cursor: { id: query.cursor }, skip: 1 }
      : {})
  });

  const hasMore = tickets.length > limit;
  const page = hasMore ? tickets.slice(0, limit) : tickets;
  const last = page[page.length - 1];

  return {
    tickets: page.map(serializeTicket),
    nextCursor: hasMore && last ? last.id : null
  };
}

export async function getTicket(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
) {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  if (!isPlatformAdmin(platformRole)) {
    await requireTicketMembership(prisma as unknown as Db, userId, ticket);
    if (ticket.status === "DRAFT" && ticket.createdById !== userId) {
      const creatorMemberships = await (prisma as unknown as Db).membership.findMany({
        where: { userId: ticket.createdById },
        select: { organizationId: true }
      });
      const creatorOrgIds = creatorMemberships.map((m) => m.organizationId);
      const callerMemberships = await (prisma as unknown as Db).membership.findMany({
        where: { userId },
        select: { organizationId: true }
      });
      const callerOrgIds = callerMemberships.map((m) => m.organizationId);
      const sharesCreatorOrg = callerOrgIds.some((id) =>
        creatorOrgIds.includes(id)
      );
      if (!sharesCreatorOrg) {
        throw notFound("Ticket not found");
      }
    }
  }
  return serializeTicket(ticket);
}

export async function updateTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  input: Static<typeof UpdateTicketBody>
) {
  const { version, expectedTotalMinor, ...patch } = input;
  if (
    Object.keys(patch).length === 0 &&
    expectedTotalMinor === undefined
  ) {
    throw badRequest("No ticket fields were supplied");
  }

  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireTicketMembership(tx, userId, ticket);

    if (ticket.status !== "DRAFT") {
      throw conflict(
        "Only draft tickets can be edited directly; propose an amendment instead"
      );
    }
    if (version !== undefined && version !== ticket.version) {
      throw conflict("Ticket has changed since it was loaded; reload and retry");
    }

    const { data, exporterChanged } = buildScalarUpdate(
      ticket,
      patch,
      expectedTotalMinor
    );
    if (exporterChanged) {
      await applyExporterChange(tx, ticket, patch.exporterOrgId ?? null);
    }
    data.version = ticket.version + 1;

    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data,
      include: ticketInclude
    });
    return serializeTicket(updated);
  });
}

export async function submitTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireTicketMembership(tx, userId, ticket);

    if (ticket.status !== "DRAFT") {
      throw conflict("Only draft tickets can be submitted");
    }
    assertTicketTransition(ticket.status, "AWAITING_ACCEPTANCE");

    const hasBuyer = ticket.parties.some(
      (party) =>
        party.organizationId === ticket.buyerOrgId && party.role === "BUYER"
    );
    const hasSupplier = ticket.parties.some(
      (party) =>
        party.organizationId === ticket.supplierOrgId &&
        party.role === "SUPPLIER"
    );
    if (!hasBuyer || !hasSupplier) {
      throw conflict("Ticket must include buyer and supplier parties");
    }

    const basisPoints = sumBasisPoints(
      ticket.milestones.map((milestone) => milestone.releaseBp)
    );
    const milestoneTotal = ticket.milestones.reduce(
      (total, milestone) => total + milestone.amountMinor,
      0n
    );
    if (
      ticket.milestones.length === 0 ||
      basisPoints !== 10_000 ||
      milestoneTotal !== ticket.totalMinor
    ) {
      throw conflict(
        "Milestones must total 10000 basis points and the full ticket amount before submission"
      );
    }

    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data: { status: "AWAITING_ACCEPTANCE" },
      include: ticketInclude
    });

    await recordAudit(tx, {
      actorId: userId,
      action: "ticket.submit",
      entityType: "Ticket",
      entityId: ticketId,
      before: { status: ticket.status },
      after: { status: "AWAITING_ACCEPTANCE" }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketSubmitted,
      title: "Ticket awaiting acceptance",
      body: `Ticket ${ticket.reference} has been submitted for acceptance.`,
      data: { ticketId },
      userIds: await ticketPartyUserIds(tx, ticket)
    });

    return serializeTicket(updated);
  });
}

export async function acceptTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  organizationId?: string
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    if (ticket.status !== "AWAITING_ACCEPTANCE") {
      throw conflict("This ticket is not awaiting acceptance");
    }

    const membership = await findPartyMembership(
      tx,
      userId,
      ticket,
      organizationId
    );
    const creatorOrgId = await creatorOrganizationId(tx, ticket);
    if (creatorOrgId === membership.organizationId) {
      throw forbidden(
        "The creator cannot accept their own ticket; the counterparty must accept it"
      );
    }
    const party = ticket.parties.find(
      (candidate) => candidate.organizationId === membership.organizationId
    );
    if (!party) {
      throw forbidden("Your organization is not a party to this ticket");
    }
    if (party.status === "ACCEPTED") {
      throw conflict("Your organization has already accepted this ticket");
    }
    if (party.status !== "INVITED") {
      throw conflict("This party can no longer accept the ticket");
    }

    await tx.ticketParty.update({
      where: { id: party.id },
      data: {
        status: "ACCEPTED",
        acceptedById: userId,
        acceptedAt: new Date()
      }
    });

    const parties = await tx.ticketParty.findMany({
      where: { ticketId },
      select: { organizationId: true, status: true }
    });
    const requiredOrgIds = [ticket.buyerOrgId, ticket.supplierOrgId].filter(
      (orgId) => orgId !== creatorOrgId
    );
    const allRequiredAccepted = requiredOrgIds.every((orgId) =>
      parties.some(
        (candidate) =>
          candidate.organizationId === orgId &&
          candidate.status === "ACCEPTED"
      )
    );

    if (allRequiredAccepted) {
      assertTicketTransition(ticket.status, "ACTIVE");
      await tx.ticket.update({
        where: { id: ticketId },
        data: { status: "ACTIVE", acceptedAt: new Date() }
      });
    }

    await recordAudit(tx, {
      actorId: userId,
      actorOrgId: membership.organizationId,
      action: "ticket.accept",
      entityType: "Ticket",
      entityId: ticketId,
      before: { status: ticket.status, partyStatus: party.status },
      after: {
        status: allRequiredAccepted ? "ACTIVE" : ticket.status,
        partyStatus: "ACCEPTED"
      }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketAccepted,
      title: "Ticket accepted",
      body: `Ticket ${ticket.reference} has been accepted by a party.`,
      data: { ticketId },
      userIds: await ticketPartyUserIds(tx, ticket),
      skipEmailOutbox: true
    });

    const updated = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude
    });
    return serializeTicket(updated);
  });
}

export async function declineTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  organizationId?: string
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    if (ticket.status !== "AWAITING_ACCEPTANCE") {
      throw conflict("This ticket is not awaiting acceptance");
    }

    const membership = await findPartyMembership(
      tx,
      userId,
      ticket,
      organizationId
    );
    const creatorOrgId = await creatorOrganizationId(tx, ticket);
    if (creatorOrgId === membership.organizationId) {
      throw forbidden(
        "The creator cannot decline their own ticket; the counterparty must respond"
      );
    }
    const party = ticket.parties.find(
      (candidate) => candidate.organizationId === membership.organizationId
    );
    if (!party) {
      throw forbidden("Your organization is not a party to this ticket");
    }
    if (party.status !== "INVITED") {
      throw conflict("This party can no longer decline the ticket");
    }

    await tx.ticketParty.update({
      where: { id: party.id },
      data: { status: "DECLINED" }
    });
    assertTicketTransition(ticket.status, "CANCELLED");
    await tx.ticket.update({
      where: { id: ticketId },
      data: { status: "CANCELLED" }
    });

    await recordAudit(tx, {
      actorId: userId,
      actorOrgId: membership.organizationId,
      action: "ticket.decline",
      entityType: "Ticket",
      entityId: ticketId,
      before: { status: ticket.status, partyStatus: party.status },
      after: { status: "CANCELLED", partyStatus: "DECLINED" }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketDeclined,
      title: "Ticket declined",
      body: `Ticket ${ticket.reference} was declined and cancelled.`,
      data: { ticketId },
      userIds: await ticketPartyUserIds(tx, ticket),
      skipEmailOutbox: true
    });

    const updated = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude
    });
    return serializeTicket(updated);
  });
}

export async function cancelTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireBuyerOrSupplier(tx, userId, ticket);
    assertTicketTransition(ticket.status, "CANCELLED");

    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data: { status: "CANCELLED" },
      include: ticketInclude
    });

    await recordAudit(tx, {
      actorId: userId,
      action: "ticket.cancel",
      entityType: "Ticket",
      entityId: ticketId,
      before: { status: ticket.status },
      after: { status: "CANCELLED" }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketCancelled,
      title: "Ticket cancelled",
      body: `Ticket ${ticket.reference} has been cancelled.`,
      data: { ticketId },
      userIds: await ticketPartyUserIds(tx, ticket)
    });

    return serializeTicket(updated);
  });
}

export async function disputeTicket(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  input: Static<typeof DisputeBody>
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireBuyerOrSupplier(tx, userId, ticket);
    assertTicketTransition(ticket.status, "DISPUTED");

    const updated = await tx.ticket.update({
      where: { id: ticketId },
      data: {
        status: "DISPUTED",
        disputeReason: input.reason,
        disputedAt: new Date()
      },
      include: ticketInclude
    });

    await recordAudit(tx, {
      actorId: userId,
      action: "ticket.dispute",
      entityType: "Ticket",
      entityId: ticketId,
      before: { status: ticket.status },
      after: { status: "DISPUTED", reason: input.reason }
    });
    await enqueueNotifications(tx, {
      eventType: NotificationEvents.ticketDisputed,
      title: "Ticket disputed",
      body: `Ticket ${ticket.reference} has been disputed: ${input.reason}`,
      data: { ticketId },
      userIds: await ticketPartyUserIds(tx, ticket)
    });

    return serializeTicket(updated);
  });
}

export async function addTicketParty(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  input: Static<typeof AddPartyBody>
) {
  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireBuyerOrSupplier(tx, userId, ticket);

    if (input.role === "EXPORTER") {
      if (ticket.exporterOrgId === input.organizationId) {
        throw conflict("This organization is already the ticket exporter");
      }
      if (ticket.exporterOrgId) {
        throw conflict("This ticket already has an exporter");
      }
      await ensureExporterAllowed(tx, ticket, input.organizationId);
      await tx.ticket.update({
        where: { id: ticketId },
        data: { exporterOrgId: input.organizationId }
      });
    } else {
      const expectedOrgId =
        input.role === "BUYER" ? ticket.buyerOrgId : ticket.supplierOrgId;
      if (expectedOrgId !== input.organizationId) {
        throw conflict(
          `The ${input.role.toLowerCase()} party must match the ticket ${input.role.toLowerCase()} organization`
        );
      }
    }

    const existing = await tx.ticketParty.findUnique({
      where: {
        ticketId_organizationId_role: {
          ticketId,
          organizationId: input.organizationId,
          role: input.role
        }
      }
    });
    if (existing) {
      throw conflict("This party is already on the ticket");
    }

    await tx.ticketParty.create({
      data: {
        ticketId,
        organizationId: input.organizationId,
        role: input.role,
        status: "INVITED",
        invitedEmail: input.invitedEmail ?? null
      }
    });

    const updated = await tx.ticket.findUniqueOrThrow({
      where: { id: ticketId },
      include: ticketInclude
    });
    return serializeTicket(updated);
  });
}

export async function listTicketAmendments(
  prisma: PrismaClient,
  userId: string,
  platformRole: PlatformRole,
  ticketId: string
) {
  const ticket = await loadTicket(prisma as unknown as Db, ticketId);
  if (!isPlatformAdmin(platformRole)) {
    await requireTicketMembership(prisma as unknown as Db, userId, ticket);
  }

  const amendments = await prisma.ticketAmendment.findMany({
    where: { ticketId },
    include: amendmentInclude,
    orderBy: { createdAt: "desc" }
  });
  return amendments.map(serializeAmendment);
}

export async function proposeAmendment(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  input: Static<typeof CreateAmendmentBody>
) {
  const patch = input.patch;
  if (Object.keys(patch).length === 0) {
    throw badRequest("Amendment patch must include at least one field");
  }

  return withTransaction(prisma, async (tx) => {
    const ticket = await loadTicket(tx, ticketId);
    await requireBuyerOrSupplier(tx, userId, ticket);

    const editableStatuses = [
      "AWAITING_ACCEPTANCE",
      "ACTIVE",
      "FUNDED",
      "IN_PROGRESS"
    ];
    if (!editableStatuses.includes(ticket.status)) {
      throw conflict("This ticket cannot be amended in its current status");
    }
    if (input.version !== undefined && input.version !== ticket.version) {
      throw conflict("Ticket has changed since it was loaded; reload and retry");
    }

    const pending = await tx.ticketAmendment.findFirst({
      where: { ticketId, status: "PENDING" },
      select: { id: true }
    });
    if (pending) {
      throw conflict("This ticket already has a pending amendment");
    }

    buildScalarUpdate(ticket, patch, patch.expectedTotalMinor);
    if (patch.exporterOrgId) {
      await ensureExporterAllowed(tx, ticket, patch.exporterOrgId);
    }

    const patchJson = Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined)
    ) as Prisma.InputJsonObject;

    const amendment = await tx.ticketAmendment.create({
      data: {
        ticketId,
        patch: patchJson,
        proposedById: userId
      },
      include: amendmentInclude
    });
    return serializeAmendment(amendment);
  });
}

export async function decideAmendment(
  prisma: PrismaClient,
  userId: string,
  ticketId: string,
  amendmentId: string,
  input: Static<typeof AmendmentDecisionBody>
) {
  return withTransaction(prisma, async (tx) => {
    const amendment = await tx.ticketAmendment.findUnique({
      where: { id: amendmentId },
      include: amendmentInclude
    });
    if (!amendment || amendment.ticketId !== ticketId) {
      throw notFound("Amendment not found");
    }
    if (amendment.status !== "PENDING") {
      throw conflict("This amendment has already been decided");
    }

    const ticket = await loadTicket(tx, ticketId);
    if (input.version !== undefined && input.version !== ticket.version) {
      throw conflict("Ticket has changed since it was loaded; reload and retry");
    }

    const memberships = await tx.membership.findMany({
      where: {
        userId,
        organizationId: { in: [ticket.buyerOrgId, ticket.supplierOrgId] }
      },
      select: { organizationId: true }
    });
    if (memberships.length === 0) {
      throw notFound("Ticket not found");
    }

    let side = input.side;
    if (!side) {
      const isBuyer = memberships.some(
        (membership) => membership.organizationId === ticket.buyerOrgId
      );
      const isSupplier = memberships.some(
        (membership) => membership.organizationId === ticket.supplierOrgId
      );
      if (isBuyer && isSupplier) {
        throw badRequest(
          "Specify side as BUYER or SUPPLIER for this approval"
        );
      }
      side = isBuyer ? "BUYER" : "SUPPLIER";
    }

    const sideOrgId =
      side === "BUYER" ? ticket.buyerOrgId : ticket.supplierOrgId;
    if (
      !memberships.some(
        (membership) => membership.organizationId === sideOrgId
      )
    ) {
      throw forbidden("You cannot decide this amendment for that party");
    }

    if (input.decision === "REJECT") {
      const rejected = await tx.ticketAmendment.update({
        where: { id: amendmentId },
        data: { status: "REJECTED" },
        include: amendmentInclude
      });
      return {
        amendment: serializeAmendment(rejected),
        ticket: serializeTicket(ticket)
      };
    }

    if (
      (side === "BUYER" && amendment.approvedByBuyerAt) ||
      (side === "SUPPLIER" && amendment.approvedBySupplierAt)
    ) {
      throw conflict(`The ${side.toLowerCase()} has already approved this amendment`);
    }

    const approvalData: Prisma.TicketAmendmentUpdateInput =
      side === "BUYER"
        ? { approvedByBuyerAt: new Date() }
        : { approvedBySupplierAt: new Date() };

    await tx.ticketAmendment.update({
      where: { id: amendmentId },
      data: approvalData
    });

    const buyerApproved =
      side === "BUYER" ? true : Boolean(amendment.approvedByBuyerAt);
    const supplierApproved =
      side === "SUPPLIER" ? true : Boolean(amendment.approvedBySupplierAt);

    if (!buyerApproved || !supplierApproved) {
      const current = await tx.ticketAmendment.findUniqueOrThrow({
        where: { id: amendmentId },
        include: amendmentInclude
      });
      return {
        amendment: serializeAmendment(current),
        ticket: serializeTicket(ticket)
      };
    }

    const patch = amendment.patch as unknown as TicketPatchInput;
    const { data, exporterChanged } = buildScalarUpdate(
      ticket,
      patch,
      patch.expectedTotalMinor
    );
    if (exporterChanged) {
      await applyExporterChange(tx, ticket, patch.exporterOrgId ?? null);
    }
    data.version = ticket.version + 1;

    const updatedTicket = await tx.ticket.update({
      where: { id: ticketId },
      data,
      include: ticketInclude
    });
    const approved = await tx.ticketAmendment.update({
      where: { id: amendmentId },
      data: { status: "APPROVED" },
      include: amendmentInclude
    });

    return {
      amendment: serializeAmendment(approved),
      ticket: serializeTicket(updatedTicket)
    };
  });
}
