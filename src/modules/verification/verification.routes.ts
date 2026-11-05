import type { FastifyPluginAsync } from "fastify";
import { Type, type Static } from "@sinclair/typebox";
import { requireMembership } from "../../common/org-access";
import { notFound } from "../../common/errors";
import { OrganizationParams } from "../organizations/organizations.schemas";
import {
  getLatestVerification,
  getVerificationReport,
  listVerificationCases,
  refreshVerification,
  reviewVerification,
  startVerification
} from "./verification.service";

const VerificationParams = Type.Object(
  { verificationId: Type.String({ minLength: 1 }) },
  { additionalProperties: false }
);

const ListQuery = Type.Object(
  {
    status: Type.Optional(
      Type.Union([
        Type.Literal("NOT_STARTED"),
        Type.Literal("PENDING"),
        Type.Literal("VERIFIED"),
        Type.Literal("REJECTED")
      ])
    )
  },
  { additionalProperties: false }
);

const RejectBody = Type.Object(
  { reason: Type.String({ minLength: 1, maxLength: 500 }) },
  { additionalProperties: false }
);

const verificationRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = {
    preHandler: [
      app.authenticate,
      app.requirePlatformRole("ADMIN", "SUPER_ADMIN")
    ]
  };

  app.post<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId/verification",
    { preHandler: app.authenticate, schema: { params: OrganizationParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId,
        ["OWNER", "ADMIN"]
      );

      const result = await startVerification(
        app.prisma,
        app.verification,
        request.params.organizationId
      );
      return reply.code(201).send(result);
    }
  );

  app.post<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId/verification/refresh",
    { preHandler: app.authenticate, schema: { params: OrganizationParams } },
    async (request, reply) => {
      const verification = await refreshVerification(
        app.prisma,
        app.verification,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.organizationId
      );
      return reply.send({ verification });
    }
  );

  app.get<{ Params: Static<typeof OrganizationParams> }>(
    "/organizations/:organizationId/verification",
    { preHandler: app.authenticate, schema: { params: OrganizationParams } },
    async (request, reply) => {
      await requireMembership(
        app.prisma,
        request.currentUser!.id,
        request.params.organizationId
      );

      const verification = await getLatestVerification(
        app.prisma,
        request.params.organizationId
      );

      if (!verification) {
        throw notFound("No verification case found for this organization");
      }

      return reply.send({ verification });
    }
  );

  app.get<{ Querystring: Static<typeof ListQuery> }>(
    "/admin/verifications",
    { ...adminOnly, schema: { querystring: ListQuery } },
    async (request, reply) => {
      const verifications = await listVerificationCases(
        app.prisma,
        request.query.status
      );
      return reply.send({ verifications });
    }
  );

  app.post<{ Params: Static<typeof VerificationParams> }>(
    "/admin/verifications/:verificationId/approve",
    { ...adminOnly, schema: { params: VerificationParams } },
    async (request, reply) => {
      const verification = await reviewVerification(
        app.prisma,
        request.params.verificationId,
        request.currentUser!.id,
        "APPROVED"
      );
      return reply.send({ verification });
    }
  );

  app.post<{
    Params: Static<typeof VerificationParams>;
    Body: Static<typeof RejectBody>;
  }>(
    "/admin/verifications/:verificationId/reject",
    {
      ...adminOnly,
      schema: { params: VerificationParams, body: RejectBody }
    },
    async (request, reply) => {
      const verification = await reviewVerification(
        app.prisma,
        request.params.verificationId,
        request.currentUser!.id,
        "REJECTED",
        request.body.reason
      );
      return reply.send({ verification });
    }
  );

  app.get<{ Params: Static<typeof VerificationParams> }>(
    "/admin/verifications/:verificationId/report",
    { ...adminOnly, schema: { params: VerificationParams } },
    async (request, reply) => {
      const report = await getVerificationReport(
        app.prisma,
        app.verification,
        request.params.verificationId
      );
      return reply.send({ report });
    }
  );
};

export default verificationRoutes;
