import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyPluginAsync } from "fastify";
import { env } from "../../config/env";
import { unauthorized } from "../../common/errors";
import { processDojahWebhook } from "./verification.service";

function safeEqual(expected: string, received: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(received);
  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

function verifySignature(
  rawBody: Buffer,
  secret: string,
  headers: Record<string, unknown>
): boolean {
  const signature = headers["x-dojah-signature"];
  const signatureV2 = headers["x-dojah-signature-v2"];

  if (typeof signature === "string" && signature.length > 0) {
    const provided = signature.replace(/^sha256=/, "");
    const expected = createHmac("sha256", secret).update(rawBody).digest("hex");
    if (safeEqual(expected, provided)) {
      return true;
    }
  }

  if (typeof signatureV2 === "string" && signatureV2.length > 0) {
    const provided = signatureV2.replace(/^sha256=/, "");
    const expected = createHash("sha256")
      .update(secret)
      .update(rawBody)
      .digest("hex");
    if (safeEqual(expected, provided)) {
      return true;
    }
  }

  return false;
}

const verificationWebhookRoutes: FastifyPluginAsync = async (app) => {
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

  app.post("/dojah", async (request, reply) => {
    const secret = env.DOJAH_WEBHOOK_SECRET;
    if (!secret) {
      return reply.code(503).send({
        error: { code: "unavailable", message: "Webhook is not configured" }
      });
    }

    const body = request.body as ParsedWebhookBody;
    if (!body?.raw) {
      throw unauthorized("Webhook body is missing");
    }
    if (!verifySignature(body.raw, secret, request.headers)) {
      throw unauthorized("Invalid webhook signature");
    }

    const verification = await processDojahWebhook(app.prisma, body.parsed);
    return reply.send({
      received: true,
      outcome: verification?.status ?? "ignored"
    });
  });
};

export default verificationWebhookRoutes;
