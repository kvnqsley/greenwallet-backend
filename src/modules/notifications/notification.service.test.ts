import type { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  enqueueNotifications,
  NotificationEvents,
  serializeNotification,
  serializePreference
} from "./notification.service";

type MockTx = {
  notificationPreference: { findMany: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  notification: { create: ReturnType<typeof vi.fn> };
  outboxEvent: { create: ReturnType<typeof vi.fn> };
};

function createTx(options?: {
  preferences?: Array<{ userId: string; channel: string; enabled: boolean }>;
  users?: Array<{ id: string; email: string }>;
}): MockTx {
  return {
    notificationPreference: {
      findMany: vi.fn().mockResolvedValue(options?.preferences ?? [])
    },
    user: { findMany: vi.fn().mockResolvedValue(options?.users ?? []) },
    notification: { create: vi.fn().mockResolvedValue({}) },
    outboxEvent: { create: vi.fn().mockResolvedValue({}) }
  };
}

function asTx(tx: MockTx): Prisma.TransactionClient {
  return tx as unknown as Prisma.TransactionClient;
}

describe("enqueueNotifications", () => {
  it("defaults to in-app and email when no preference exists", async () => {
    const tx = createTx({ users: [{ id: "user-1", email: "buyer@example.com" }] });

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.ticketFunded,
      title: "Ticket funded",
      body: "Funds are held in escrow.",
      userIds: ["user-1"]
    });

    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.notification.create.mock.calls[0]![0].data).toMatchObject({
      userId: "user-1",
      type: NotificationEvents.ticketFunded,
      channel: "IN_APP"
    });
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create.mock.calls[0]![0].data).toMatchObject({
      topic: "notification.email",
      payload: {
        to: "buyer@example.com",
        subject: "Ticket funded"
      }
    });
  });

  it("skips email when the user disabled the EMAIL channel", async () => {
    const tx = createTx({
      users: [{ id: "user-1", email: "buyer@example.com" }],
      preferences: [{ userId: "user-1", channel: "EMAIL", enabled: false }]
    });

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.ticketFunded,
      title: "Ticket funded",
      body: "Funds are held in escrow.",
      userIds: ["user-1"]
    });

    expect(tx.notification.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("skips in-app when the user disabled the IN_APP channel", async () => {
    const tx = createTx({
      users: [{ id: "user-1", email: "buyer@example.com" }],
      preferences: [{ userId: "user-1", channel: "IN_APP", enabled: false }]
    });

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.ticketFunded,
      title: "Ticket funded",
      body: "Funds are held in escrow.",
      userIds: ["user-1"]
    });

    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });

  it("queues invitation emails without creating in-app rows", async () => {
    const tx = createTx();

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.invitation,
      title: "You have been invited",
      body: "Accept the invitation.",
      emails: ["new-member@example.com"]
    });

    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
    expect(tx.outboxEvent.create.mock.calls[0]![0].data.payload.to).toBe(
      "new-member@example.com"
    );
  });

  it("does nothing when there are no recipients", async () => {
    const tx = createTx();

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.ticketFunded,
      title: "Ticket funded",
      body: "Funds are held in escrow."
    });

    expect(tx.notification.create).not.toHaveBeenCalled();
    expect(tx.outboxEvent.create).not.toHaveBeenCalled();
  });

  it("deduplicates emails from user ids and explicit addresses", async () => {
    const tx = createTx({
      users: [{ id: "user-1", email: "same@example.com" }]
    });

    await enqueueNotifications(asTx(tx), {
      eventType: NotificationEvents.invitation,
      title: "Invitation",
      body: "Join us.",
      userIds: ["user-1"],
      emails: ["same@example.com"]
    });

    expect(tx.outboxEvent.create).toHaveBeenCalledTimes(1);
  });
});

describe("serializers", () => {
  it("serializes notifications with their read state", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z");
    expect(
      serializeNotification({
        id: "note-1",
        userId: "user-1",
        type: "TICKET_FUNDED",
        channel: "IN_APP",
        title: "Funded",
        body: "Body",
        data: { ticketId: "ticket-1" },
        readAt: null,
        createdAt
      })
    ).toEqual({
      id: "note-1",
      type: "TICKET_FUNDED",
      channel: "IN_APP",
      title: "Funded",
      body: "Body",
      data: { ticketId: "ticket-1" },
      readAt: null,
      createdAt
    });
  });

  it("serializes preferences", () => {
    expect(
      serializePreference({
        id: "pref-1",
        userId: "user-1",
        channel: "EMAIL",
        eventType: "TICKET_FUNDED",
        enabled: false
      })
    ).toEqual({
      id: "pref-1",
      channel: "EMAIL",
      eventType: "TICKET_FUNDED",
      enabled: false
    });
  });
});
