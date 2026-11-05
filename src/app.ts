import Fastify from "fastify";
import { type TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import { env } from "./config/env";
import errorHandlerPlugin from "./plugins/error-handler";
import securityPlugin from "./plugins/security";
import prismaPlugin from "./plugins/prisma";
import authPlugin from "./plugins/auth";
import mailerPlugin from "./plugins/mailer";
import paymentsPlugin from "./plugins/payments";
import storagePlugin from "./plugins/storage";
import verificationPlugin from "./plugins/verification";
import jobsPlugin from "./plugins/jobs";
import healthRoutes from "./modules/health/routes";
import authRoutes from "./modules/auth/auth.routes";
import usersRoutes from "./modules/users/users.routes";
import organizationRoutes from "./modules/organizations/organizations.routes";
import verificationRoutes from "./modules/verification/verification.routes";
import ticketRoutes from "./modules/tickets/ticket.routes";
import walletRoutes from "./modules/wallets/wallet.routes";
import milestoneRoutes from "./modules/milestones/milestone.routes";
import documentRoutes from "./modules/documents/document.routes";
import shareRoutes from "./modules/share/share.routes";
import notificationRoutes from "./modules/notifications/notification.routes";
import adminRoutes from "./modules/admin/admin.routes";
import verificationWebhookRoutes from "./modules/verification/verification.webhook";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      ...(env.NODE_ENV === "development"
        ? {
            transport: {
              target: "pino-pretty",
              options: {
                translateTime: "SYS:standard",
                ignore: "pid,hostname"
              }
            }
          }
        : {})
    },
    trustProxy: true,
    bodyLimit: env.BODY_LIMIT_BYTES,
    requestIdHeader: "x-request-id"
  }).withTypeProvider<TypeBoxTypeProvider>();

  await app.register(errorHandlerPlugin);
  await app.register(securityPlugin);
  await app.register(prismaPlugin);
  await app.register(authPlugin);
  await app.register(mailerPlugin);
  await app.register(paymentsPlugin);
  await app.register(storagePlugin);
  await app.register(verificationPlugin);
  await app.register(jobsPlugin);
  await app.register(healthRoutes, { prefix: "/health" });
  await app.register(authRoutes, { prefix: "/api/v1/auth" });
  await app.register(usersRoutes, { prefix: "/api/v1" });
  await app.register(organizationRoutes, { prefix: "/api/v1" });
  await app.register(verificationRoutes, { prefix: "/api/v1" });
  await app.register(ticketRoutes, { prefix: "/api/v1" });
  await app.register(walletRoutes, { prefix: "/api/v1" });
  await app.register(milestoneRoutes, { prefix: "/api/v1" });
  await app.register(documentRoutes, { prefix: "/api/v1" });
  await app.register(shareRoutes, { prefix: "/api/v1" });
  await app.register(notificationRoutes, { prefix: "/api/v1" });
  await app.register(adminRoutes, { prefix: "/api/v1" });
  await app.register(verificationWebhookRoutes, {
    prefix: "/api/v1/webhooks"
  });

  app.get("/", async () => ({
    name: "GreenWallet API",
    version: "0.1.0",
    status: "ok"
  }));

  return app;
}
