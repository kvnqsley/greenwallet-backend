import fp from "fastify-plugin";
import jwt from "@fastify/jwt";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { PlatformRole } from "@prisma/client";
import { env } from "../config/env";
import { forbidden, unauthorized } from "../common/errors";

export type CurrentUser = {
  id: string;
  email: string;
  platformRole: PlatformRole;
};

declare module "fastify" {
  interface FastifyRequest {
    currentUser: CurrentUser | null;
  }
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    requirePlatformRole: (
      ...roles: PlatformRole[]
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: { sub: string; role: PlatformRole };
    user: { sub: string; role: PlatformRole };
  }
}

export default fp(
  async (app) => {
    await app.register(jwt, {
      secret: env.JWT_ACCESS_SECRET,
      sign: { expiresIn: env.JWT_ACCESS_TTL }
    });

    app.decorateRequest("currentUser", null);

    app.decorate(
      "authenticate",
      async (request: FastifyRequest, _reply: FastifyReply) => {
        try {
          await request.jwtVerify();
        } catch {
          throw unauthorized("Missing or invalid access token");
        }

        const user = await app.prisma.user.findUnique({
          where: { id: request.user.sub },
          select: { id: true, email: true, platformRole: true }
        });

        if (!user) {
          throw unauthorized("User no longer exists");
        }

        request.currentUser = user;
      }
    );

    app.decorate(
      "requirePlatformRole",
      (...roles: PlatformRole[]) =>
        async (request: FastifyRequest, _reply: FastifyReply) => {
          if (!request.currentUser) {
            throw unauthorized();
          }
          if (!roles.includes(request.currentUser.platformRole)) {
            throw forbidden("Platform administrator access required");
          }
        }
    );
  },
  { name: "auth", dependencies: ["prisma"] }
);
