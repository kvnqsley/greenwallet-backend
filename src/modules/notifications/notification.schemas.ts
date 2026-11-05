import { Type } from "@sinclair/typebox";

export const NotificationParams = Type.Object(
  { notificationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const NotificationListQuery = Type.Object(
  {
    unreadOnly: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String({ minLength: 1 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 }))
  },
  { additionalProperties: false }
);

export const NotificationChannelSchema = Type.Union([
  Type.Literal("EMAIL"),
  Type.Literal("IN_APP"),
  Type.Literal("WHATSAPP")
]);

export const UpdateNotificationPreferencesBody = Type.Object(
  {
    preferences: Type.Array(
      Type.Object(
        {
          eventType: Type.String({ minLength: 1, maxLength: 80 }),
          channel: NotificationChannelSchema,
          enabled: Type.Boolean()
        },
        { additionalProperties: false }
      ),
      { minItems: 1, maxItems: 50 }
    )
  },
  { additionalProperties: false }
);
