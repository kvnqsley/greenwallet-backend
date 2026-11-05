import fp from "fastify-plugin";
import { env } from "../config/env";
import { DojahProvider } from "../modules/verification/dojah.provider";
import { MockVerificationProvider } from "../modules/verification/mock-verification.provider";
import type { VerificationProvider } from "../modules/verification/verification-provider";

declare module "fastify" {
  interface FastifyInstance {
    verification: VerificationProvider;
  }
}

export default fp(
  async (app) => {
    const verification: VerificationProvider =
      env.VERIFICATION_PROVIDER === "dojah"
        ? new DojahProvider({
            appId: env.DOJAH_APP_ID!,
            publicKey: env.DOJAH_PUBLIC_KEY!,
            secretKey: env.DOJAH_SECRET_KEY!,
            widgetId: env.DOJAH_WIDGET_ID!,
            baseUrl: env.DOJAH_BASE_URL
          })
        : new MockVerificationProvider();

    app.decorate("verification", verification);
    app.log.info(
      { verificationProvider: env.VERIFICATION_PROVIDER },
      "verification provider configured"
    );
  },
  { name: "verification" }
);
