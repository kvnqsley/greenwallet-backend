import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  AdminAuditQuery,
  AdminFlagTicketBody,
  AdminTicketListQuery,
  AdminTicketParams
} from "./admin.schemas";
import { flagTicket, listAdminTickets, listAuditEvents } from "./admin.service";

const adminRoutes: FastifyPluginAsync = async (app) => {
  const adminOnly = {
    preHandler: [app.authenticate, app.requirePlatformRole("ADMIN", "SUPER_ADMIN")]
  };

  app.get<{ Querystring: Static<typeof AdminTicketListQuery> }>(
    "/admin/tickets",
    { ...adminOnly, schema: { querystring: AdminTicketListQuery } },
    async (request, reply) => {
      const result = await listAdminTickets(app.prisma, request.query);
      return reply.send(result);
    }
  );

  app.post<{
    Params: Static<typeof AdminTicketParams>;
    Body: Static<typeof AdminFlagTicketBody>;
  }>(
    "/admin/tickets/:ticketId/flag",
    {
      ...adminOnly,
      schema: { params: AdminTicketParams, body: AdminFlagTicketBody }
    },
    async (request, reply) => {
      const ticket = await flagTicket(
        app.prisma,
        request.currentUser!.id,
        request.params.ticketId,
        request.body.reason
      );
      return reply.send({ ticket });
    }
  );

  app.get<{ Querystring: Static<typeof AdminAuditQuery> }>(
    "/admin/audit-events",
    { ...adminOnly, schema: { querystring: AdminAuditQuery } },
    async (request, reply) => {
      const result = await listAuditEvents(app.prisma, request.query);
      return reply.send(result);
    }
  );
};

export default adminRoutes;
