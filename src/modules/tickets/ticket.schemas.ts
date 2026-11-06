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

const partyRole = Type.Union([
  Type.Literal("BUYER"),
  Type.Literal("SUPPLIER"),
  Type.Literal("EXPORTER")
]);

const moneyString = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: "^\\d+$"
});

const quantityString = Type.String({
  minLength: 1,
  maxLength: 20,
  pattern: "^\\d+(\\.\\d{1,3})?$"
});

const nullableText = (maxLength: number) =>
  Type.Union([Type.String({ maxLength }), Type.Null()]);

const nullableDate = Type.Union([
  Type.String({ minLength: 4, maxLength: 40 }),
  Type.Null()
]);

const patchProperties = {
  title: Type.Optional(nullableText(160)),
  commodity: Type.Optional(
    Type.String({ minLength: 1, maxLength: 120 })
  ),
  grade: Type.Optional(nullableText(60)),
  quantity: Type.Optional(quantityString),
  unit: Type.Optional(Type.String({ minLength: 1, maxLength: 30 })),
  unitPriceMinor: Type.Optional(moneyString),
  deliveryTerms: Type.Optional(nullableText(500)),
  deliveryLocation: Type.Optional(nullableText(200)),
  deliveryFrom: Type.Optional(nullableDate),
  deliveryTo: Type.Optional(nullableDate),
  terms: Type.Optional(nullableText(5000)),
  exporterOrgId: Type.Optional(
    Type.Union([Type.String({ minLength: 1 }), Type.Null()])
  )
};

export const TicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const AmendmentParams = Type.Object(
  {
    ticketId: Type.String({ minLength: 1 }),
    amendmentId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

export const CreateTicketBody = Type.Object(
  {
    title: Type.Optional(nullableText(160)),
    buyerOrgId: Type.String({ minLength: 1 }),
    supplierOrgId: Type.String({ minLength: 1 }),
    exporterOrgId: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Null()])
    ),
    commodity: Type.String({ minLength: 1, maxLength: 120 }),
    grade: Type.Optional(nullableText(60)),
    quantity: quantityString,
    unit: Type.String({ minLength: 1, maxLength: 30 }),
    unitPriceMinor: moneyString,
    expectedTotalMinor: moneyString,
    currency: Type.Optional(
      Type.String({ minLength: 3, maxLength: 3, pattern: "^[A-Z]{3}$" })
    ),
    deliveryTerms: Type.Optional(nullableText(500)),
    deliveryLocation: Type.Optional(nullableText(200)),
    deliveryFrom: Type.Optional(nullableDate),
    deliveryTo: Type.Optional(nullableDate),
    terms: Type.Optional(nullableText(5000))
  },
  { additionalProperties: false }
);

export const UpdateTicketBody = Type.Object(
  {
    ...patchProperties,
    expectedTotalMinor: Type.Optional(moneyString),
    version: Type.Optional(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
);

export const TicketPatch = Type.Object(
  {
    ...patchProperties,
    expectedTotalMinor: Type.Optional(moneyString)
  },
  {
    additionalProperties: false
  }
);

export const TicketListQuery = Type.Object(
  {
    status: Type.Optional(ticketStatus),
    organizationId: Type.Optional(Type.String({ minLength: 1 })),
    commodity: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);

export const AddPartyBody = Type.Object(
  {
    organizationId: Type.String({ minLength: 1 }),
    role: partyRole,
    invitedEmail: Type.Optional(
      Type.String({
        minLength: 3,
        maxLength: 254,
        pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
      })
    )
  },
  { additionalProperties: false }
);

export const PartyActionBody = Type.Object(
  { organizationId: Type.Optional(Type.String({ minLength: 1 })) },
  { additionalProperties: false }
);

export const DisputeBody = Type.Object(
  { reason: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false }
);

export const CreateAmendmentBody = Type.Object(
  {
    patch: TicketPatch,
    version: Type.Optional(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
);

export const AmendmentDecisionBody = Type.Object(
  {
    decision: Type.Union([Type.Literal("APPROVE"), Type.Literal("REJECT")]),
    side: Type.Optional(
      Type.Union([Type.Literal("BUYER"), Type.Literal("SUPPLIER")])
    ),
    version: Type.Optional(Type.Integer({ minimum: 1 }))
  },
  { additionalProperties: false }
);
