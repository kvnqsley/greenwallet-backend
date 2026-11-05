import { Type } from "@sinclair/typebox";

const orgRoles = Type.Union([
  Type.Literal("BUYER"),
  Type.Literal("SUPPLIER"),
  Type.Literal("EXPORTER")
]);

export const OrganizationParams = Type.Object(
  { organizationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const MemberParams = Type.Object(
  {
    organizationId: Type.String({ minLength: 1 }),
    userId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

export const InvitationParams = Type.Object(
  {
    organizationId: Type.String({ minLength: 1 }),
    invitationId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

export const InvitationTokenParams = Type.Object(
  { token: Type.String({ minLength: 10 }) },
  { additionalProperties: false }
);

export const CreateOrganizationBody = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 200 }),
    type: Type.Union([Type.Literal("BUSINESS"), Type.Literal("INDIVIDUAL")]),
    regNumber: Type.Optional(Type.String({ maxLength: 60 })),
    roles: Type.Optional(
      Type.Array(orgRoles, { minItems: 1, uniqueItems: true })
    )
  },
  { additionalProperties: false }
);

export const UpdateOrganizationBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    regNumber: Type.Optional(Type.String({ maxLength: 60 })),
    roles: Type.Optional(
      Type.Array(orgRoles, { minItems: 1, uniqueItems: true })
    )
  },
  { additionalProperties: false }
);

export const InviteBody = Type.Object(
  {
    email: Type.String({
      minLength: 3,
      maxLength: 254,
      pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
    }),
    role: Type.Optional(
      Type.Union([Type.Literal("ADMIN"), Type.Literal("MEMBER")])
    )
  },
  { additionalProperties: false }
);

export const UpdateMemberBody = Type.Object(
  {
    role: Type.Union([
      Type.Literal("OWNER"),
      Type.Literal("ADMIN"),
      Type.Literal("MEMBER")
    ])
  },
  { additionalProperties: false }
);
