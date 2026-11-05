import fp from "fastify-plugin";
import { env } from "../config/env";
import { MockProvider } from "../payments/mock-provider";
import type { PaymentPort } from "../payments/payment-port";

declare module "fastify" {
  interface FastifyInstance {
    payments: PaymentPort;
  }
}

export default fp(
  async (app) => {
    const provider: PaymentPort = new MockProvider();
    app.decorate("payments", provider);
    app.log.info(
      { paymentProvider: env.PAYMENT_PROVIDER },
      "payment provider configured"
    );
  },
  { name: "payments" }
);
