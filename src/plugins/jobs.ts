import fp from "fastify-plugin";
import { PgBoss } from "pg-boss";
import type { FastifyInstance } from "fastify";
import { recordAudit } from "../common/audit";
import { withTransaction } from "../common/db";
import { env } from "../config/env";
import {
  enqueueNotifications,
  NotificationEvents,
  type EmailOutboxPayload
} from "../modules/notifications/notification.service";

const EMAIL_RELAY_QUEUE = "outbox.email";
const MAINTENANCE_QUEUE = "maintenance.expire";
const RECONCILE_QUEUE = "maintenance.reconcile";
const EMAIL_BATCH_SIZE = 50;
const RECONCILE_LOOKBACK_DAYS = 30;
const RECONCILE_BATCH_SIZE = 500;

declare module "fastify" {
  interface FastifyInstance {
    boss: PgBoss;
    startJobs: () => Promise<void>;
  }
}

async function relayEmailOutbox(app: FastifyInstance) {
  const events = await app.prisma.outboxEvent.findMany({
    where: { processedAt: null, topic: "notification.email" },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: EMAIL_BATCH_SIZE
  });

  for (const event of events) {
    const payload = event.payload as unknown as EmailOutboxPayload;
    if (!payload?.to || !payload.subject || !payload.text) {
      app.log.warn(
        { eventId: event.id },
        "skipping malformed email outbox event"
      );
    } else {
      await app.mailer.send(payload);
    }
    await app.prisma.outboxEvent.update({
      where: { id: event.id },
      data: { processedAt: new Date() }
    });
  }

  return events.length;
}

async function expireInvitations(app: FastifyInstance) {
  const result = await app.prisma.invitation.updateMany({
    where: { status: "PENDING", expiresAt: { lt: new Date() } },
    data: { status: "EXPIRED" }
  });
  if (result.count > 0) {
    app.log.info({ count: result.count }, "expired stale invitations");
  }
}

async function reconcilePayments(app: FastifyInstance) {
  const since = new Date(
    Date.now() - RECONCILE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000
  );
  const transactions = await app.prisma.ledgerTransaction.findMany({
    where: {
      status: "POSTED",
      providerRef: { not: null },
      createdAt: { gte: since }
    },
    orderBy: { createdAt: "desc" },
    take: RECONCILE_BATCH_SIZE,
    select: {
      id: true,
      providerRef: true,
      type: true,
      ticketId: true,
      milestoneId: true
    }
  });

  if (transactions.length === 0) {
    return;
  }

  const adminIds = (
    await app.prisma.user.findMany({
      where: { platformRole: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { id: true }
    })
  ).map((user) => user.id);

  let mismatches = 0;
  let providerErrors = 0;

  for (const transaction of transactions) {
    if (!transaction.providerRef) {
      continue;
    }

    let providerStatus: string;
    try {
      const provider = await app.payments.getTransaction(
        transaction.providerRef
      );
      providerStatus = provider.status;
    } catch (error) {
      providerErrors += 1;
      app.log.warn(
        { err: error, transactionId: transaction.id },
        "reconciliation could not reach payment provider"
      );
      continue;
    }

    if (providerStatus === "SUCCEEDED") {
      continue;
    }

    const alreadyReported = await app.prisma.auditEvent.findFirst({
      where: {
        action: "reconciliation.mismatch",
        entityType: "LedgerTransaction",
        entityId: transaction.id
      },
      select: { id: true }
    });
    if (alreadyReported) {
      continue;
    }

    mismatches += 1;
    await withTransaction(app.prisma, async (tx) => {
      await recordAudit(tx, {
        action: "reconciliation.mismatch",
        entityType: "LedgerTransaction",
        entityId: transaction.id,
        before: {
          status: "POSTED",
          providerRef: transaction.providerRef
        },
        after: { providerStatus }
      });
      await enqueueNotifications(tx, {
        eventType: NotificationEvents.reconciliationMismatch,
        title: "Payment reconciliation mismatch",
        body: `Ledger transaction ${transaction.id} is POSTED but the provider reports ${providerStatus}.`,
        data: {
          transactionId: transaction.id,
          ticketId: transaction.ticketId,
          providerRef: transaction.providerRef,
          providerStatus
        },
        userIds: adminIds
      });
    });
  }

  app.log.info(
    {
      checked: transactions.length,
      mismatches,
      providerErrors
    },
    "payment reconciliation finished"
  );
}

function pgSslConfig():
  | { rejectUnauthorized: boolean; ca?: string }
  | undefined {
  if (env.DATABASE_SSL_CA) {
    return {
      ca: env.DATABASE_SSL_CA.replace(/\\n/g, "\n"),
      rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED
    };
  }
  if (!env.DATABASE_SSL_REJECT_UNAUTHORIZED) {
    return { rejectUnauthorized: false };
  }
  return undefined;
}

function bossConnectionOptions() {
  const ssl = pgSslConfig();
  if (!ssl) {
    return { connectionString: env.DATABASE_URL };
  }

  // pg merges parse(connectionString) over explicit options, so sslmode in the
  // URL would silently override the SSL settings above. Strip those params.
  const url = new URL(env.DATABASE_URL);
  for (const key of [
    "sslmode",
    "uselibpqcompat",
    "sslrootcert",
    "sslcert",
    "sslkey"
  ]) {
    url.searchParams.delete(key);
  }

  return { connectionString: url.toString(), ssl };
}

export default fp(
  async (app) => {
    const boss = new PgBoss({
      ...bossConnectionOptions(),
      schema: "pgboss"
    });
    let started = false;

    boss.on("error", (error: Error) => {
      app.log.error({ err: error }, "pg-boss error");
    });

    app.decorate("boss", boss);
    app.decorate("startJobs", async () => {
      if (started) {
        return;
      }

      await boss.start();
      started = true;

      await boss.createQueue(EMAIL_RELAY_QUEUE);
      await boss.createQueue(MAINTENANCE_QUEUE);
      await boss.createQueue(RECONCILE_QUEUE);

      await boss.work(EMAIL_RELAY_QUEUE, { batchSize: 1 }, async () => {
        const processed = await relayEmailOutbox(app);
        if (processed > 0) {
          app.log.info({ processed }, "relayed notification emails");
        }
      });
      await boss.work(MAINTENANCE_QUEUE, { batchSize: 1 }, async () => {
        await expireInvitations(app);
      });
      await boss.work(RECONCILE_QUEUE, { batchSize: 1 }, async () => {
        await reconcilePayments(app);
      });

      await boss.schedule(EMAIL_RELAY_QUEUE, "* * * * *", null, {
        key: "email-relay"
      });
      await boss.schedule(MAINTENANCE_QUEUE, "0 3 * * *", null, {
        key: "maintenance"
      });
      await boss.schedule(RECONCILE_QUEUE, "30 2 * * *", null, {
        key: "reconcile"
      });

      app.log.info("background jobs started");
    });

    app.addHook("onClose", async () => {
      if (started) {
        started = false;
        await boss.stop();
      }
    });
  },
  { name: "jobs", dependencies: ["prisma", "mailer"] }
);
