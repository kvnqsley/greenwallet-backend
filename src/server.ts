import { buildApp } from "./app";
import { env } from "./config/env";

async function main() {
  const app = await buildApp();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, "error during shutdown");
      process.exit(1);
    }
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await app.listen({ host: env.HOST, port: env.PORT });
  } catch (error) {
    app.log.error({ err: error }, "failed to start server");
    process.exit(1);
  }

  try {
    await app.startJobs();
  } catch (error) {
    app.log.error(
      { err: error },
      "failed to start background jobs (check DATABASE_URL TLS settings: DATABASE_SSL_CA / DATABASE_SSL_REJECT_UNAUTHORIZED)"
    );
  }
}

void main();
