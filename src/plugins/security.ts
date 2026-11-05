import fp from "fastify-plugin";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import { env } from "../config/env";

const allowedOrigins = env.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export default fp(
  async (app) => {
    await app.register(helmet);
    await app.register(cors, {
      origin: allowedOrigins,
      credentials: true
    });
    await app.register(rateLimit, {
      max: env.RATE_LIMIT_MAX,
      timeWindow: env.RATE_LIMIT_WINDOW,
      errorResponseBuilder: (_request, context) => ({
        name: "too_many_requests",
        statusCode: 429,
        error: "Too Many Requests",
        message: `Rate limit exceeded, retry in ${context.after}`
      })
    });

    app.addHook("onSend", async (request, reply, payload) => {
      reply.header("x-request-id", request.id);
      return payload;
    });
  },
  { name: "security" }
);
