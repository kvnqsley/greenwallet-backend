import type { FastifyPluginAsync } from "fastify";
import type { Static } from "@sinclair/typebox";
import { requireIdempotencyKey } from "../../common/idempotency";
import {
  BankAccountBody,
  LedgerQuery,
  TicketParams,
  WalletParams,
  WithdrawalBody,
  WithdrawalParams
} from "./wallet.schemas";
import {
  getTicketLedger,
  getWalletLedger,
  listWalletsForUser
} from "./wallet.service";
import { ensureTicketCharge } from "../payments/ticket-charge.service";
import {
  addBankAccount,
  getWithdrawal,
  listBankAccounts,
  listBanks,
  listWithdrawals,
  requestWithdrawal
} from "../payments/withdrawal.service";

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

  app.get(
    "/payments/banks",
    { preHandler: app.authenticate },
    async (_request, reply) => {
      const banks = await listBanks(app.payments);
      return reply.send({ banks });
    }
  );

  app.post<{
    Params: Static<typeof WalletParams>;
    Body: Static<typeof BankAccountBody>;
  }>(
    "/wallets/:walletId/bank-accounts",
    {
      preHandler: app.authenticate,
      schema: { params: WalletParams, body: BankAccountBody }
    },
    async (request, reply) => {
      const account = await addBankAccount(
        app.prisma,
        app.payments,
        request.currentUser!.id,
        request.params.walletId,
        request.body
      );
      return reply.code(201).send({ bankAccount: account });
    }
  );

  app.get<{ Params: Static<typeof WalletParams> }>(
    "/wallets/:walletId/bank-accounts",
    { preHandler: app.authenticate, schema: { params: WalletParams } },
    async (request, reply) => {
      const bankAccounts = await listBankAccounts(
        app.prisma,
        request.currentUser!.id,
        request.params.walletId
      );
      return reply.send({ bankAccounts });
    }
  );

  app.post<{
    Params: Static<typeof WalletParams>;
    Body: Static<typeof WithdrawalBody>;
  }>(
    "/wallets/:walletId/withdrawals",
    {
      preHandler: app.authenticate,
      schema: { params: WalletParams, body: WithdrawalBody }
    },
    async (request, reply) => {
      const idempotencyKey = requireIdempotencyKey(
        request.headers["idempotency-key"]
      );
      const result = await requestWithdrawal(
        app.prisma,
        app.payments,
        request.currentUser!.id,
        request.params.walletId,
        request.body,
        idempotencyKey
      );
      return reply.code(result.responseCode).send(result.body);
    }
  );

  app.get<{ Params: Static<typeof WalletParams> }>(
    "/wallets/:walletId/withdrawals",
    { preHandler: app.authenticate, schema: { params: WalletParams } },
    async (request, reply) => {
      const withdrawals = await listWithdrawals(
        app.prisma,
        request.currentUser!.id,
        request.params.walletId
      );
      return reply.send({ withdrawals });
    }
  );

  app.get<{ Params: Static<typeof WithdrawalParams> }>(
    "/withdrawals/:withdrawalId",
    { preHandler: app.authenticate, schema: { params: WithdrawalParams } },
    async (request, reply) => {
      const withdrawal = await getWithdrawal(
        app.prisma,
        request.currentUser!.id,
        request.params.withdrawalId
      );
      return reply.send({ withdrawal });
    }
  );

  app.post<{ Params: Static<typeof TicketParams> }>(
    "/tickets/:ticketId/fund",
    { preHandler: app.authenticate, schema: { params: TicketParams } },
    async (request, reply) => {
      const result = await ensureTicketCharge(
        app.prisma,
        app.payments,
        request.currentUser!.id,
        request.params.ticketId
      );
      return reply.send(result);
    }
  );
};

export default walletRoutes;
