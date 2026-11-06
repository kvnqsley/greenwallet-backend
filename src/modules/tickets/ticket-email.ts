import type { FastifyBaseLogger } from "fastify";
import type { PrismaClient } from "@prisma/client";
import { env } from "../../config/env";
import type { Mailer } from "../notifications/mailer";

type TicketEmailInfo = {
  id: string;
  reference: string;
  commodity: string;
  totalMinor: string;
  currency: string;
  buyerOrgId: string;
  supplierOrgId: string;
  buyer?: { name: string } | null;
  supplier?: { name: string } | null;
};

function ticketUrl(ticketId: string): string {
  return `${env.APP_URL.replace(/\/+$/, "")}/trade-tickets/review?ticketId=${encodeURIComponent(ticketId)}`;
}

function formatAmount(amountMinor: string, currency: string): string {
  const amount = Number(amountMinor) / 100;
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

async function organizationEmails(
  prisma: PrismaClient,
  organizationId: string
): Promise<string[]> {
  const memberships = await prisma.membership.findMany({
    where: { organizationId },
    select: { user: { select: { email: true } } }
  });
  return [...new Set(memberships.map((membership) => membership.user.email))];
}

async function sendToOrganization(
  prisma: PrismaClient,
  mailer: Mailer,
  log: FastifyBaseLogger,
  organizationId: string,
  subject: string,
  text: string
): Promise<void> {
  const emails = await organizationEmails(prisma, organizationId);
  for (const to of emails) {
    try {
      await mailer.send({ to, subject, text });
    } catch (error) {
      log.warn(
        { err: error, to, subject },
        "ticket notification email failed"
      );
    }
  }
}

export async function notifySellerTicketCreated(
  prisma: PrismaClient,
  mailer: Mailer,
  log: FastifyBaseLogger,
  ticket: TicketEmailInfo
): Promise<void> {
  const url = ticketUrl(ticket.id);
  const text = [
    `A new trade ticket has been created by the buyer.`,
    ``,
    `Reference: ${ticket.reference}`,
    `Commodity: ${ticket.commodity}`,
    `Total: ${formatAmount(ticket.totalMinor, ticket.currency)}`,
    `Buyer: ${ticket.buyer?.name ?? "Buyer organization"}`,
    ``,
    `Review and accept or reject the ticket:`,
    url
  ].join("\n");

  await sendToOrganization(
    prisma,
    mailer,
    log,
    ticket.supplierOrgId,
    `New trade ticket ${ticket.reference}`,
    text
  );
}

export async function notifyBuyerTicketAccepted(
  prisma: PrismaClient,
  mailer: Mailer,
  log: FastifyBaseLogger,
  ticket: TicketEmailInfo
): Promise<void> {
  const url = ticketUrl(ticket.id);
  const text = [
    `Trade ticket ${ticket.reference} was accepted by the seller.`,
    ``,
    `Reference: ${ticket.reference}`,
    `Commodity: ${ticket.commodity}`,
    `Total: ${formatAmount(ticket.totalMinor, ticket.currency)}`,
    `Seller: ${ticket.supplier?.name ?? "Supplier organization"}`,
    ``,
    `Review the ticket and fund the trade:`,
    url
  ].join("\n");

  await sendToOrganization(
    prisma,
    mailer,
    log,
    ticket.buyerOrgId,
    `Trade ticket ${ticket.reference} accepted`,
    text
  );
}

export async function notifyBuyerTicketDeclined(
  prisma: PrismaClient,
  mailer: Mailer,
  log: FastifyBaseLogger,
  ticket: TicketEmailInfo
): Promise<void> {
  const url = ticketUrl(ticket.id);
  const text = [
    `Trade ticket ${ticket.reference} was declined by the seller.`,
    ``,
    `Reference: ${ticket.reference}`,
    `Commodity: ${ticket.commodity}`,
    ``,
    `View the ticket:`,
    url
  ].join("\n");

  await sendToOrganization(
    prisma,
    mailer,
    log,
    ticket.buyerOrgId,
    `Trade ticket ${ticket.reference} declined`,
    text
  );
}
