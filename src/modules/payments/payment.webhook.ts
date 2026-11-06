import type { FastifyPluginAsync } from "fastify";
import type { PaymentProvider } from "@prisma/client";
import { env } from "../../config/env";
import { unauthorized } from "../../common/errors";
import {
  applyChargeFailure,
  applyChargeSuccess
} from "./ticket-charge.service";
import {
  applyWithdrawalFailure,
  applyWithdrawalReversal,
  applyWithdrawalSuccess
} from "./withdrawal.service";

const providerName: PaymentProvider =
  env.PAYMENT_PROVIDER === "mock" ? "MOCK" : "PAYSTACK";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(
  record: Record<string, unknown>,
  key: string
): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(
  record: Record<string, unknown>,
  key: string
): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

const paymentWebhookRoutes: FastifyPluginAsync = async (app) => {
  type ParsedWebhookBody = { raw: Buffer; parsed: unknown };

  app.removeContentTypeParser(["application/json"]);
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_request, body, done) => {
      try {
        done(null, {
          raw: body,
          parsed: JSON.parse(body.toString("utf8")) as unknown
        });
      } catch (error) {
        done(error as Error, undefined);
      }
    }
  );

  app.post("/paystack", async (request, reply) => {
    if (
      env.PAYMENT_PROVIDER === "paystack" &&
      !env.PAYSTACK_SECRET_KEY
    ) {
      return reply.code(503).send({
        error: {
          code: "unavailable",
          message: "Payment webhook is not configured"
        }
      });
    }

    const body = request.body as ParsedWebhookBody;
    if (!body?.raw) {
      throw unauthorized("Webhook body is missing");
    }

    const event = app.payments.verifyWebhook(
      request.headers as Record<string, string>,
      body.raw
    );
    const payload = asRecord(event.payload);
    const data = asRecord(payload.data);

    const existing = await app.prisma.providerEvent.findUnique({
      where: {
        provider_eventId: { provider: providerName, eventId: event.eventId }
      }
    });
    if (existing?.processedAt) {
      return reply.send({ received: true, outcome: "duplicate" });
    }

    const stored =
      existing ??
      (await app.prisma.providerEvent.create({
        data: {
          provider: providerName,
          eventId: event.eventId,
          payload: event.payload as object
        }
      }));

    let outcome = "ignored";
    try {
      if (event.type === "charge.success" || event.type === "charge.failed") {
        const reference = stringField(data, "reference");
        const charge = reference
          ? await app.prisma.ticketCharge.findUnique({
              where: { reference }
            })
          : null;

        if (!charge) {
          outcome = "charge_not_found";
        } else if (event.type === "charge.success") {
          await applyChargeSuccess(app.prisma, charge.id, {
            providerRef: reference ?? charge.reference,
            status: "SUCCEEDED",
            amountMinor:
              numberField(data, "amount") !== null
                ? BigInt(numberField(data, "amount") as number)
                : 0n,
            currency: stringField(data, "currency") ?? charge.currency,
            transactionId:
              numberField(data, "id") !== null
                ? String(numberField(data, "id"))
                : null,
            channel: stringField(data, "channel"),
            paidAt: stringField(data, "paid_at")
              ? new Date(stringField(data, "paid_at") as string)
              : new Date(),
            failureReason: stringField(data, "gateway_response"),
            metadata: asRecord(data.metadata)
          });
          outcome = "charge_paid";
        } else {
          await applyChargeFailure(
            app.prisma,
            charge.id,
            stringField(data, "gateway_response")
          );
          outcome = "charge_failed";
        }
      } else if (
        event.type === "transfer.success" ||
        event.type === "transfer.failed" ||
        event.type === "transfer.reversed"
      ) {
        const reference =
          stringField(data, "reference") ??
          stringField(data, "transfer_code");
        const withdrawal = reference
          ? await app.prisma.withdrawal.findUnique({
              where: { providerRef: reference }
            })
          : null;

        if (!withdrawal) {
          outcome = "withdrawal_not_found";
        } else if (event.type === "transfer.success") {
          await applyWithdrawalSuccess(
            app.prisma,
            withdrawal.id,
            numberField(data, "amount") !== null
              ? BigInt(numberField(data, "amount") as number)
              : 0n,
            stringField(data, "currency") ?? withdrawal.currency
          );
          outcome = "withdrawal_paid";
        } else if (event.type === "transfer.reversed") {
          if (withdrawal.status === "SUCCESS") {
            await applyWithdrawalReversal(
              app.prisma,
              withdrawal.id,
              stringField(data, "gateway_response")
            );
            outcome = "withdrawal_reversed";
          } else {
            await applyWithdrawalFailure(
              app.prisma,
              withdrawal.id,
              stringField(data, "gateway_response")
            );
            outcome = "withdrawal_failed";
          }
        } else {
          await applyWithdrawalFailure(
            app.prisma,
            withdrawal.id,
            stringField(data, "gateway_response")
          );
          outcome = "withdrawal_failed";
        }
      }

      await app.prisma.providerEvent.update({
        where: { id: stored.id },
        data: { processedAt: new Date() }
      });
      return reply.send({ received: true, outcome });
    } catch (error) {
      request.log.error(
        { err: error, eventId: event.eventId },
        "payment webhook processing failed"
      );
      throw error;
    }
  });
};

export default paymentWebhookRoutes;
