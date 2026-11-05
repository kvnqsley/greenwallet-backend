import type { Prisma } from "@prisma/client";

export type AuditInput = {
  actorId?: string | null;
  actorOrgId?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: Prisma.InputJsonValue;
  after?: Prisma.InputJsonValue;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
};

export async function recordAudit(
  tx: Prisma.TransactionClient,
  input: AuditInput
): Promise<void> {
  const data: Prisma.AuditEventCreateInput = {
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId
  };

  if (input.actorId) {
    data.actor = { connect: { id: input.actorId } };
  }
  if (input.actorOrgId) {
    data.actorOrg = { connect: { id: input.actorOrgId } };
  }
  if (input.before !== undefined) {
    data.before = input.before;
  }
  if (input.after !== undefined) {
    data.after = input.after;
  }
  if (input.ip) {
    data.ip = input.ip;
  }
  if (input.userAgent) {
    data.userAgent = input.userAgent;
  }
  if (input.requestId) {
    data.requestId = input.requestId;
  }

  await tx.auditEvent.create({ data });
}
