import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import { requireIdempotencyKey } from "../../common/idempotency";
import {
  LedgerQuery,
  TicketParams,
  WalletParams
} from "./wallet.schemas";
import {
  fundTicket,
  getTicketLedger,
  getWalletLedger,
  listWalletsForUser
} from "./wallet.service";

const walletRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    "/wallets",
    { preHandler: app.authenticate },
    async (request, reply) => {
      const wallets = await listWalletsForUser(
        app.prisma,
        request.currentUser!.id
      );
      return reply.send({ wallets });
    }
  );

  app.get<{
    Params: Static<typeof WalletParams>;
    Querystring: Static<typeof LedgerQuery>;
  }>(
    "/wallets/:walletId/ledger",
    {
      preHandler: app.authenticate,
      schema: { params: WalletParams, querystring: LedgerQuery }
    },
    async (request, reply) => {
      const result = await getWalletLedger(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.walletId,
        request.query
      );
      return reply.send(result);
    }
  );

  app.get<{
    Params: Static<typeof TicketParams>;
    Querystring: Static<typeof LedgerQuery>;
  }>(
    "/tickets/:ticketId/ledger",
    {
      preHandler: app.authenticate,
      schema: { params: TicketParams, querystring: LedgerQuery }
    },
    async (request, reply) => {
      const result = await getTicketLedger(
        app.prisma,
        request.currentUser!.id,
        request.currentUser!.platformRole,
        request.params.ticketId,
        request.query
      );
      return reply.send(result);
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/fund",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await fundTicket(
        app.prisma,
        app.payments,
        request.currentUser!.id,
        request.params.ticketId,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );
};

export default walletRoutes;
