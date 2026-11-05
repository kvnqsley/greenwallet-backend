import { Type } from "@sinclair/typebox";

const ticketStatus = Type.Union([
  Type.Literal("DRAFT"),
  Type.Literal("AWAITING_ACCEPTANCE"),
  Type.Literal("ACTIVE"),
  Type.Literal("FUNDED"),
  Type.Literal("IN_PROGRESS"),
  Type.Literal("COMPLETED"),
  Type.Literal("CANCELLED"),
  Type.Literal("DISPUTED")
]);

export const AdminTicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const AdminTicketListQuery = Type.Object(
  {
    status: Type.Optional(ticketStatus),
    organizationId: Type.Optional(Type.String({ minLength: 1 })),
    commodity: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    flaggedOnly: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);

export const AdminFlagTicketBody = Type.Object(
  { reason: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })) },
  { additionalProperties: false }
);

export const AdminAuditQuery = Type.Object(
  {
    entityType: Type.Optional(Type.String({ minLength: 1, maxLength: 80 })),
    entityId: Type.Optional(Type.String({ minLength: 1 })),
    actorId: Type.Optional(Type.String({ minLength: 1 })),
    action: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);
