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

export const BankAccountBody = Type.Object(
  {
    bankCode: Type.String({ minLength: 2, maxLength: 10 }),
    accountNumber: Type.String({ minLength: 10, maxLength: 10 }),
    bankName: Type.Optional(Type.String({ minLength: 1, maxLength: 120 }))
  },
  { additionalProperties: false }
);

export const WithdrawalBody = Type.Object(
  {
    bankAccountId: Type.String({ minLength: 1 }),
    amountMinor: Type.String({
      minLength: 1,
      maxLength: 20,
      pattern: "^\\d+$"
    }),
    reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 }))
  },
  { additionalProperties: false }
);

export const WithdrawalParams = Type.Object(
  { withdrawalId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);
