import fp from "fastify-plugin";
import { env } from "../config/env";
import { CloudinaryStorage } from "../modules/documents/cloudinary-storage";
import { MockStorage } from "../modules/documents/mock-storage";
import type { StoragePort } from "../modules/documents/storage.port";

declare module "fastify" {
  interface FastifyInstance {
    storage: StoragePort;
  }
}

export default fp(
  async (app) => {
    const storage: StoragePort =
      env.STORAGE_PROVIDER === "cloudinary"
        ? new CloudinaryStorage({
            cloudName: env.CLOUDINARY_CLOUD_NAME!,
            apiKey: env.CLOUDINARY_API_KEY!,
            apiSecret: env.CLOUDINARY_API_SECRET!,
            folderPrefix: env.CLOUDINARY_FOLDER_PREFIX,
            maxBytes: env.CLOUDINARY_MAX_BYTES,
            presets: {
              VERIFICATION: env.CLOUDINARY_VERIFICATION_PRESET!,
              TICKET: env.CLOUDINARY_TICKET_PRESET!,
              EVIDENCE: env.CLOUDINARY_EVIDENCE_PRESET!
            }
          })
        : new MockStorage(env.CLOUDINARY_FOLDER_PREFIX);

    app.decorate("storage", storage);
    app.log.info(
      { storageProvider: env.STORAGE_PROVIDER },
      "document storage configured"
    );
  },
  { name: "storage" }
);
