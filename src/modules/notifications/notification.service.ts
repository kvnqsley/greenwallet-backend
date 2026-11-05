import type {
  Notification,
  NotificationChannel,
  NotificationPreference,
  Prisma,
  PrismaClient
} from "@prisma/client";
import { notFound } from "../../common/errors";

export const NotificationEvents = {
  invitation: "INVITATION",
  invitationAccepted: "INVITATION_ACCEPTED",
  ticketSubmitted: "TICKET_SUBMITTED",
  ticketAccepted: "TICKET_ACCEPTED",
  ticketDeclined: "TICKET_DECLINED",
  ticketCancelled: "TICKET_CANCELLED",
  ticketDisputed: "TICKET_DISPUTED",
  ticketFunded: "TICKET_FUNDED",
  ticketFlagged: "TICKET_FLAGGED",
  milestoneSubmitted: "MILESTONE_SUBMITTED",
  milestoneConfirmed: "MILESTONE_CONFIRMED",
  milestoneRejected: "MILESTONE_REJECTED",
  milestoneReleased: "MILESTONE_RELEASED",
  verificationApproved: "VERIFICATION_APPROVED",
  verificationRejected: "VERIFICATION_REJECTED",
  reconciliationMismatch: "RECONCILIATION_MISMATCH"
} as const;

export type NotificationEventType =
  (typeof NotificationEvents)[keyof typeof NotificationEvents];

type Db = Prisma.TransactionClient;

export const DEFAULT_CHANNELS: NotificationChannel[] = ["EMAIL", "IN_APP"];

export async function orgMemberIds(
  db: PrismaClient | Db,
  organizationId: string
): Promise<string[]> {
  const memberships = await db.membership.findMany({
    where: { organizationId },
    select: { userId: true }
  });
  return memberships.map((membership) => membership.userId);
}

export type EnqueueNotificationInput = {
  eventType: string;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  userIds?: readonly string[];
  emails?: readonly string[];
};

export async function enqueueNotifications(
  tx: Db,
  input: EnqueueNotificationInput
): Promise<void> {
  const userIds = [...new Set(input.userIds ?? [])];
  const emailTargets = new Set(input.emails ?? []);

  if (userIds.length > 0) {
    const preferences = await tx.notificationPreference.findMany({
      where: { userId: { in: userIds }, eventType: input.eventType }
    });

    const channelState = new Map<
      string,
      { EMAIL: boolean; IN_APP: boolean }
    >();
    for (const userId of userIds) {
      channelState.set(userId, { EMAIL: true, IN_APP: true });
    }
    for (const preference of preferences) {
      const state = channelState.get(preference.userId);
      if (!state) {
        continue;
      }
      if (preference.channel === "EMAIL" || preference.channel === "IN_APP") {
        state[preference.channel] = preference.enabled;
      }
    }

    const users = await tx.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, email: true }
    });
    const userEmails = new Map(users.map((user) => [user.id, user.email]));

    for (const userId of userIds) {
      const state = channelState.get(userId)!;
      if (state.IN_APP) {
        await tx.notification.create({
          data: {
            userId,
            type: input.eventType,
            channel: "IN_APP",
            title: input.title,
            body: input.body,
            data: input.data
          }
        });
      }
      const email = userEmails.get(userId);
      if (state.EMAIL && email) {
        emailTargets.add(email);
      }
    }
  }

  for (const to of emailTargets) {
    await tx.outboxEvent.create({
      data: {
        topic: "notification.email",
        payload: { to, subject: input.title, text: input.body }
      }
    });
  }
}

export type EmailOutboxPayload = {
  to: string;
  subject: string;
  text: string;
};

export function serializeNotification(notification: Notification) {
  return {
    id: notification.id,
    type: notification.type,
    channel: notification.channel,
    title: notification.title,
    body: notification.body,
    data: notification.data,
    readAt: notification.readAt,
    createdAt: notification.createdAt
  };
}

export async function listNotifications(
  prisma: PrismaClient,
  userId: string,
  query: { unreadOnly?: boolean; cursor?: string; limit?: number }
) {
  const limit = query.limit ?? 20;
  const notifications = await prisma.notification.findMany({
    where: {
      userId,
      ...(query.unreadOnly ? { readAt: null } : {})
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {})
  });

  const hasMore = notifications.length > limit;
  const page = hasMore ? notifications.slice(0, limit) : notifications;
  const last = page[page.length - 1];

  return {
    notifications: page.map(serializeNotification),
    nextCursor: hasMore && last ? last.id : null
  };
}

export async function markNotificationRead(
  prisma: PrismaClient,
  userId: string,
  notificationId: string
) {
  const notification = await prisma.notification.findFirst({
    where: { id: notificationId, userId }
  });
  if (!notification) {
    throw notFound("Notification not found");
  }
  if (notification.readAt) {
    return serializeNotification(notification);
  }
  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: new Date() }
  });
  return serializeNotification(updated);
}

export function serializePreference(preference: NotificationPreference) {
  return {
    id: preference.id,
    channel: preference.channel,
    eventType: preference.eventType,
    enabled: preference.enabled
  };
}

export async function listNotificationPreferences(
  prisma: PrismaClient,
  userId: string
) {
  const preferences = await prisma.notificationPreference.findMany({
    where: { userId },
    orderBy: [{ eventType: "asc" }, { channel: "asc" }]
  });
  return preferences.map(serializePreference);
}

export type PreferenceUpdate = {
  eventType: string;
  channel: NotificationChannel;
  enabled: boolean;
};

export async function updateNotificationPreferences(
  prisma: PrismaClient,
  userId: string,
  updates: PreferenceUpdate[]
) {
  for (const update of updates) {
    await prisma.notificationPreference.upsert({
      where: {
        userId_channel_eventType: {
          userId,
          channel: update.channel,
          eventType: update.eventType
        }
      },
      update: { enabled: update.enabled },
      create: {
        userId,
        channel: update.channel,
        eventType: update.eventType,
        enabled: update.enabled
      }
    });
  }
  return listNotificationPreferences(prisma, userId);
}
