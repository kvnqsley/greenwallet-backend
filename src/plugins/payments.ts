import fp from "fastify-plugin";
import { env } from "../config/env";
import { MockProvider } from "../payments/mock-provider";
import { PaystackProvider } from "../payments/paystack-provider";
import type { PaymentPort } from "../payments/payment-port";

declare module "fastify" {
  interface FastifyInstance {
    payments: PaymentPort;
  }
}

export default fp(
  async (app) => {
    let provider: PaymentPort;
    if (env.PAYMENT_PROVIDER === "paystack") {
      if (!env.PAYSTACK_SECRET_KEY) {
        throw new Error("PAYSTACK_SECRET_KEY is required for paystack");
      }
      provider = new PaystackProvider(
        env.PAYSTACK_SECRET_KEY,
        env.PAYSTACK_BASE_URL
      );
    } else {
      provider = new MockProvider();
    }

    app.decorate("payments", provider);
    app.log.info(
      { paymentProvider: env.PAYMENT_PROVIDER },
      "payment provider configured"
    );
  },
  { name: "payments" }
);
