import { Type } from "@sinclair/typebox";

export const ShareTicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const ShareLinkParams = Type.Object(
  { shareLinkId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const PublicTicketParams = Type.Object(
  { token: Type.String({ minLength: 10, maxLength: 200 }) },
  { additionalProperties: false }
);

export const CreateShareLinkBody = Type.Object(
  {
    expiresAt: Type.Optional(
      Type.Union([
        Type.String({ minLength: 4, maxLength: 40 }),
        Type.Null()
      ])
    )
  },
  { additionalProperties: false }
);
