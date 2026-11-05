import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  AddPartyBody,
  AmendmentDecisionBody,
  AmendmentParams,
  CreateAmendmentBody,
  CreateTicketBody,
  DisputeBody,
  TicketListQuery,
  TicketParams,
  UpdateTicketBody
} from "./ticket.schemas";
import {
  acceptTicket,
  addTicketParty,
  cancelTicket,
  createTicket,
  decideAmendment,
  declineTicket,
  disputeTicket,
  getTicket,
  listTicketAmendments,
  listTickets,
  proposeAmendment,
  submitTicket,
  updateTicket
} from "./ticket.service";

const ticketRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Body: Static<typeof CreateTicketBody> }>(
    "/tickets",
    { preHandler: app.authenticate, schema: { body: CreateTicketBody } },
    async (request, reply) => {
      const ticket = await createTicket(
        app.prisma,
        request.currentUser!.id,
        request.body
      );
      return reply.code(201).send({ ticket });
    }
  );

  app.get<{ Querystring: Static<typeof TicketListQuery> }>(
    "/tickets",
    { preHandler: app.authenticate, schema: { querystring: TicketListQuery } },
    async (request, reply) => {
      const result = await listTickets(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.query
      );
      return reply.send(result);
    }
  );

  app.get<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const ticket = await getTicket(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send({ ticket });
    }
  );

  app.patch<{
    Params: Static<typeof TicketParams>;
    Body: Static<typeof UpdateTicketBody>;
  }>(
    "/tickets/:ticketId",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, body: UpdateTicketBody }
    },
    async (request, reply) => {
      const ticket = await updateTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body
      );
      return reply.send({ ticket });
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/submit",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const ticket = await submitTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId
      );
      return reply.send({ ticket });
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/accept",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { organizationId?: string };
      const ticket = await acceptTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        body.organizationId
      );
      return reply.send({ ticket });
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/decline",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const body = (request.body ?? {}) as { organizationId?: string };
      const ticket = await declineTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        body.organizationId
      );
      return reply.send({ ticket });
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/cancel",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const ticket = await cancelTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId
      );
      return reply.send({ ticket });
    }
  );

  app.post<{
    Params: Static<typeof TicketParams>;
    Body: Static<typeof DisputeBody>;
  }>(
    "/tickets/:ticketId/dispute",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, body: DisputeBody }
    },
    async (request, reply) => {
      const ticket = await disputeTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body
      );
      return reply.send({ ticket });
    }
  );

  app.post<{
    Params: Static<typeof TicketParams>;
    Body: Static<typeof AddPartyBody>;
  }>(
    "/tickets/:ticketId/parties",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, body: AddPartyBody }
    },
    async (request, reply) => {
      const ticket = await addTicketParty(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body
      );
      return reply.code(201).send({ ticket });
    }
  );

  app.get<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/amendments",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const amendments = await listTicketAmendments(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send({ amendments });
    }
  );

  app.post<{
    Params: Static<typeof TicketParams>;
    Body: Static<typeof CreateAmendmentBody>;
  }>(
    "/tickets/:ticketId/amendments",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, body: CreateAmendmentBody }
    },
    async (request, reply) => {
      const amendment = await proposeAmendment(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body
      );
      return reply.code(201).send({ amendment });
    }
  );

  app.patch<{
    Params: Static<typeof AmendmentParams>;
    Body: Static<typeof AmendmentDecisionBody>;
  }>(
    "/tickets/:ticketId/amendments/:amendmentId",
    {
      preHandler: app.authenticate,
      schema: { params: AmendmentParams, body: AmendmentDecisionBody }
    },
    async (request, reply) => {
      const result = await decideAmendment(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.params.amendmentId,
        request.body
      );
      return reply.send(result);
    }
  );
};

export default ticketRoutes;
