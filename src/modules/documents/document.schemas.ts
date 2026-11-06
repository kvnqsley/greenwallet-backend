import { Type } from "@sinclair/typebox";

export const DocumentKindSchema = Type.Union([
  Type.Literal("EVIDENCE"),
  Type.Literal("CONTRACT"),
  Type.Literal("INVOICE"),
  Type.Literal("CERTIFICATE"),
  Type.Literal("ID_PROOF"),
  Type.Literal("REG_CERT"),
  Type.Literal("BANK_STATEMENT"),
  Type.Literal("PDF_EXPORT"),
  Type.Literal("OTHER")
]);

export const StoragePurposeSchema = Type.Union([
  Type.Literal("VERIFICATION"),
  Type.Literal("TICKET"),
  Type.Literal("EVIDENCE")
]);

export const UploadConfigQuery = Type.Object(
  { purpose: StoragePurposeSchema },
  { additionalProperties: false }
);

export const DocumentParams = Type.Object(
  { documentId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const RegisterDocumentBody = Type.Object(
  {
    purpose: StoragePurposeSchema,
    kind: DocumentKindSchema,
    publicId: Type.String({ minLength: 1, maxLength: 500 }),
    resourceType: Type.Union([
      Type.Literal("image"),
      Type.Literal("raw"),
      Type.Literal("video")
    ]),
    originalName: Type.Optional(
      Type.String({ minLength: 1, maxLength: 255 })
    ),
    ticketId: Type.Optional(Type.String({ minLength: 1 })),
    milestoneId: Type.Optional(Type.String({ minLength: 1 })),
    verificationCaseId: Type.Optional(Type.String({ minLength: 1 }))
  },
  { additionalProperties: false }
);

export const UploadMilestoneEvidenceBody = Type.Object(
  {
    fileName: Type.String({ minLength: 1, maxLength: 255 }),
    mimeType: Type.String({ minLength: 1, maxLength: 150 }),
    dataBase64: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

export const TicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const MilestoneParams = Type.Object(
  {
    ticketId: Type.String({ minLength: 1 }),
    milestoneId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);
