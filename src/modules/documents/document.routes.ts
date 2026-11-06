import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import {
  DocumentParams,
  MilestoneParams,
  RegisterDocumentBody,
  TicketParams,
  UploadConfigQuery,
  UploadMilestoneEvidenceBody
} from "./document.schemas";
import {
  deleteDocument,
  getDocumentDownload,
  listMilestoneEvidence,
  listTicketDocuments,
  registerDocument,
  uploadMilestoneEvidence
} from "./document.service";
import { generateTicketPdf } from "./ticket-pdf.service";

const documentRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: Static<typeof UploadConfigQuery> }>(
    "/uploads/config",
    {
      preHandler: app.authenticate,
      schema: { querystring: UploadConfigQuery }
    },
    async (request, reply) => {
      const config = app.storage.getUploadConfig(request.query.purpose);
      return reply.send({ purpose: request.query.purpose, ...config });
    }
  );

  app.post<{ Body: Static<typeof RegisterDocumentBody> }>(
    "/documents",
    {
      preHandler: app.authenticate,
      schema: { body: RegisterDocumentBody }
    },
    async (request, reply) => {
      const document = await registerDocument(
        app.prisma,
        app.storage,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.body
      );
      return reply.code(201).send({ document });
    }
  );

  app.get<{ Params: Static<typeof DocumentParams> }>(
    "/documents/:documentId/download",
    { preHandler: app.authenticate, schema: { params: DocumentParams } },
    async (request, reply) => {
      const result = await getDocumentDownload(
        app.prisma,
        app.storage,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.documentId
      );
      return reply.send(result);
    }
  );

  app.delete<{ Params: Static<typeof DocumentParams> }>(
    "/documents/:documentId",
    { preHandler: app.authenticate, schema: { params: DocumentParams } },
    async (request, reply) => {
      await deleteDocument(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.documentId
      );
      return reply.code(204).send();
    }
  );

  app.get<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/documents",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const documents = await listTicketDocuments(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send({ documents });
    }
  );

  app.get<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/pdf",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const result = await generateTicketPdf(
        app.prisma,
        app.storage,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId
      );
      return reply.send(result);
    }
  );

  app.post<{
    Params: Static<typeof MilestoneParams>;
    Body: Static<typeof UploadMilestoneEvidenceBody>;
  }>(
    "/tickets/:ticketId/milestones/:milestoneId/evidence",
    {
      preHandler: app.authenticate,
      bodyLimit: 16 * 1024 * 1024,
      schema: { params: MilestoneParams, body: UploadMilestoneEvidenceBody }
    },
    async (request, reply) => {
      const document = await uploadMilestoneEvidence(
        app.prisma,
        app.storage,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId,
        request.params.milestoneId,
        request.body
      );
      return reply.code(201).send({ document });
    }
  );

  app.get<{ Params: Static<typeof MilestoneParams> }>(
    "/tickets/:ticketId/milestones/:milestoneId/evidence",
    { preHandler: app.authenticate, schema: { params: MilestoneParams } },
    async (request, reply) => {
      const documents = await listMilestoneEvidence(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId,
        request.params.milestoneId
      );
      return reply.send({ documents });
    }
  );
};

export default documentRoutes;
