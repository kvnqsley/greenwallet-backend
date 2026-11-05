import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import { requireIdempotencyKey } from "../../common/idempotency";
import {
  CreateMilestoneBody,
  MilestoneParams,
  RejectMilestoneBody,
  TicketParams
} from "./milestone.schemas";
import {
  confirmMilestone,
  createMilestone,
  listMilestones,
  rejectMilestone,
  releaseMilestone,
  submitMilestone
} from "./milestone.service";

const milestoneRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/milestones",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const milestones = await listMilestones(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send({ milestones });
    }
  );

  app.post<{
    Params: Static<typeof TicketParams>;
    Body: Static<typeof CreateMilestoneBody>;
  }>(
    "/tickets/:ticketId/milestones",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, body: CreateMilestoneBody }
    },
    async (request, reply) => {
      const milestone = await createMilestone(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body
      );
      return reply.code(201).send({ milestone });
    }
  );

  app.post<{ Params: Static<typeof MilestoneParams> }>(
    "/tickets/:ticketId/milestones/:milestoneId/submit",
    { preHandler: app.authenticate, schema: { params: MilestoneParams } },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await submitMilestone(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.params.milestoneId,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );

  app.post<{ Params: Static<typeof MilestoneParams> }>(
    "/tickets/:ticketId/milestones/:milestoneId/confirm",
    { preHandler: app.authenticate, schema: { params: MilestoneParams } },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await confirmMilestone(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.params.milestoneId,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );

  app.post<{
    Params: Static<typeof MilestoneParams>;
    Body: Static<typeof RejectMilestoneBody>;
  }>(
    "/tickets/:ticketId/milestones/:milestoneId/reject",
    {
      preHandler: app.authenticate,
      schema: { params: MilestoneParams, body: RejectMilestoneBody }
    },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await rejectMilestone(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.params.milestoneId,
        request.body.note,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );

  app.post<{ Params: Static<typeof MilestoneParams> }>(
    "/tickets/:ticketId/milestones/:milestoneId/release",
    { preHandler: app.authenticate, schema: { params: MilestoneParams } },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await releaseMilestone(
        app.prisma,
        app.payments,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId,
        request.params.milestoneId,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );
};

export default milestoneRoutes;
