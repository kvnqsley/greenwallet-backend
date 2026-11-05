import fp from "fastify-plugin";
import { env } from "../config/env";
import {
  LogMailer,
  ZohoMailer,
  type Mailer
} from "../modules/notifications/mailer";

declare module "fastify" {
  interface FastifyInstance {
    mailer: Mailer;
  }
}

export default fp(
  async (app) => {
    const mailer: Mailer =
      env.MAIL_PROVIDER === "zoho"
        ? new ZohoMailer(
            {
              region: env.ZOHO_MAIL_REGION,
              clientId: env.ZOHO_MAIL_CLIENT_ID!,
              clientSecret: env.ZOHO_MAIL_CLIENT_SECRET!,
              refreshToken: env.ZOHO_MAIL_REFRESH_TOKEN!,
              accountId: env.ZOHO_MAIL_ACCOUNT_ID!,
              fromAddress: env.MAIL_FROM_ADDRESS!
            },
            app.log
          )
        : new LogMailer(app.log);

    app.decorate("mailer", mailer);
  },
  { name: "mailer" }
);
