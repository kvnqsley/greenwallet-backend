import type { FastifyPluginAsync } from "fastify";
import { Type } from "@sinclair/typebox";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/live",
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.String() })
        }
      }
    },
    async () => ({ status: "ok" })
  );

  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: Type.Object({ status: Type.String(), db: Type.String() }),
          503: Type.Object({ status: Type.String(), db: Type.String() })
        }
      }
    },
    async (_request, reply) => {
      try {
        await app.prisma.$queryRaw`SELECT 1`;
        return { status: "ok", db: "up" };
      } catch (error) {
        app.log.error({ err: error }, "readiness check failed");
        return reply.code(503).send({ status: "degraded", db: "down" });
      }
    }
  );
};

export default healthRoutes;
