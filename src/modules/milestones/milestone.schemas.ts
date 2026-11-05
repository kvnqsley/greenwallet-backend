import { Type } from "@sinclair/typebox";

export const MilestoneParams = Type.Object(
  {
    ticketId: Type.String({ minLength: 1 }),
    milestoneId: Type.String({ minLength: 1 })
  },
  { additionalProperties: false }
);

export const TicketParams = Type.Object(
  { ticketId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

export const CreateMilestoneBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 200 }),
    description: Type.Optional(
      Type.Union([Type.String({ maxLength: 2000 }), Type.Null()])
    ),
    releaseBp: Type.Integer({ minimum: 1, maximum: 10_000 }),
    dueDate: Type.Optional(
      Type.Union([Type.String({ minLength: 4, maxLength: 40 }), Type.Null()])
    )
  },
  { additionalProperties: false }
);

export const RejectMilestoneBody = Type.Object(
  { note: Type.String({ minLength: 3, maxLength: 1000 }) },
  { additionalProperties: false }
);
