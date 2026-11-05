import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  CreateShareLinkBody,
  PublicTicketParams,
  ShareLinkParams,
  ShareTicketParams
} from "./share.schemas";
import {
  createShareLink,
  listShareLinks,
  resolvePublicTicket,
  revokeShareLink
} from "./share.service";

const shareRoutes: FastifyPluginAsync = async (app) => {
  app.post<{
    Params: Static<typeof ShareTicketParams>;
    Body: Static<typeof CreateShareLinkBody>;
  }>(
    "/tickets/:ticketId/share-links",
    {
      preHandler: app.authenticate,
      schema: { params: ShareTicketParams, body: CreateShareLinkBody }
    },
    async (request, reply) => {
      const result = await createShareLink(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId,
        request.body
      );
      return reply.code(201).send(result);
    }
  );

  app.get<{ Params: Static<typeof ShareTicketParams> }>(
    "/tickets/:ticketId/share-links",
    { preHandler: app.authenticate, schema: { params: ShareTicketParams } },
    async (request, reply) => {
      const shareLinks = await listShareLinks(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send({ shareLinks });
    }
  );

  app.delete<{ Params: Static<typeof ShareLinkParams> }>(
    "/share-links/:shareLinkId",
    { preHandler: app.authenticate, schema: { params: ShareLinkParams } },
    async (request, reply) => {
      const result = await revokeShareLink(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.shareLinkId
      );
      return reply.send(result);
    }
  );

  app.get<{ Params: Static<typeof PublicTicketParams> }>(
    "/public/tickets/:token",
    { schema: { params: PublicTicketParams } },
    async (request, reply) => {
      const result = await resolvePublicTicket(
        app.prisma,
        request.params.token
      );
      return reply.send(result);
    }
  );
};

export default shareRoutes;
