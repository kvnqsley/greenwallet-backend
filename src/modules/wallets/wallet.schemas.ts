import { Type } from "@sinclair/typebox";

export const WalletParams = Type.Object(
  { walletId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const TicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const LedgerQuery = Type.Object(
  {
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);
