import { Type } from "@sinclair/typebox";

const email = Type.String({
  minLength: 3,
  maxLength: 254,
  pattern: "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"
});

const password = Type.String({ minLength: 8, maxLength: 128 });

export const RegisterBody = Type.Object(
  {
    email,
    password,
    name: Type.String({ minLength: 1, maxLength: 120 }),
    phone: Type.Optional(Type.String({ minLength: 3, maxLength: 30 })),
    organizationName: Type.String({ minLength: 1, maxLength: 200 }),
    organizationType: Type.Union([
      Type.Literal("BUSINESS"),
      Type.Literal("INDIVIDUAL")
    ]),
    roles: Type.Array(
      Type.Union([
        Type.Literal("BUYER"),
        Type.Literal("SUPPLIER"),
        Type.Literal("EXPORTER")
      ]),
      { minItems: 1, uniqueItems: true }
    )
  },
  { additionalProperties: false }
);

export const LoginBody = Type.Object(
  { email, password: Type.String({ minLength: 1, maxLength: 128 }) },
  { additionalProperties: false }
);

export const RefreshBody = Type.Object(
  { refreshToken: Type.String({ minLength: 10 }) },
  { additionalProperties: false }
);

export const VerifyEmailBody = Type.Object(
  { token: Type.String({ minLength: 10 }) },
  { additionalProperties: false }
);

export const ForgotPasswordBody = Type.Object(
  { email },
  { additionalProperties: false }
);

export const ResetPasswordBody = Type.Object(
  { token: Type.String({ minLength: 10 }), password },
  { additionalProperties: false }
);
