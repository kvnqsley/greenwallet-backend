import type { FastifyPluginAsync } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import { notFound } from "../../common/errors";
import { toPublicUser } from "../auth/auth.service";

const UpdateMeBody = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 120 })),
    phone: Type.Optional(Type.String({ minLength: 3, maxLength: 30 }))
  },
  { additionalProperties: false }
);

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.get("/me", { preHandler: app.authenticate }, async (request, reply) => {
    const user = await app.prisma.user.findUnique({
      where: { id: request.currentUser!.id },
      include: {
        memberships: {
          include: {
            organization: {
              select: {
                id: true,
                name: true,
                type: true,
                roles: true,
                verification: true
              }
            }
          },
          orderBy: { createdAt: "asc" }
        }
      }
    });

    if (!user) {
      throw notFound("User not found");
    }

    return reply.send({
      user: toPublicUser(user),
      memberships: user.memberships.map((membership) => ({
        id: membership.id,
        role: membership.role,
        organization: membership.organization
      }))
    });
  });

  app.patch<{ Body: Static<typeof UpdateMeBody> }>(
    "/me",
    { preHandler: app.authenticate, schema: { body: UpdateMeBody } },
    async (request, reply) => {
      const user = await app.prisma.user.update({
        where: { id: request.currentUser!.id },
        data: {
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.phone !== undefined
            ? { phone: request.body.phone }
            : {})
        }
      });

      return reply.send({ user: toPublicUser(user) });
    }
  );
};

export default usersRoutes;
