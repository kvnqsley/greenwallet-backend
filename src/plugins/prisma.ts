import fp from "fastify-plugin";
import { PrismaClient } from "@prisma/client";
import { env } from "../config/env";

declare module "fastify" {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export default fp(
  async (app) => {
    const prisma = new PrismaClient({
      log: env.NODE_ENV === "development" ? ["warn", "error"] : ["error"]
    });

    if (env.NODE_ENV === "production") {
      await prisma.$connect();
    }
    app.decorate("prisma", prisma);

    app.addHook("onClose", async () => {
      await prisma.$disconnect();
    });
  },
  { name: "prisma" }
);
