import "dotenv/config";
import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional()
);

const optionalEmail = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().email().optional()
);

const booleanFromEnv = z.preprocess((value) => {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value.toLowerCase() === "true";
  }
  return value;
}, z.boolean());

const envSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().min(1).default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3000),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
    DATABASE_SSL_REJECT_UNAUTHORIZED: booleanFromEnv.default(true),
    DATABASE_SSL_CA: optionalString,
    CORS_ORIGINS: z.string().default("http://localhost:3001"),
    APP_URL: z.string().default("http://localhost:3001"),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    AUTH_RATE_LIMIT_WINDOW: z.string().min(1).default("1 minute"),
    BODY_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    JWT_ACCESS_SECRET: z
      .string()
      .min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
    JWT_ACCESS_TTL: z.string().default("15m"),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    PAYMENT_PROVIDER: z.enum(["mock"]).default("mock"),
    MAIL_PROVIDER: z.enum(["log", "zoho"]).default("log"),
    MAIL_FROM_ADDRESS: optionalEmail,
    ZOHO_MAIL_REGION: z
      .enum(["us", "eu", "in", "au", "jp", "ca"])
      .default("us"),
    ZOHO_MAIL_CLIENT_ID: optionalString,
    ZOHO_MAIL_CLIENT_SECRET: optionalString,
    ZOHO_MAIL_REFRESH_TOKEN: optionalString,
    ZOHO_MAIL_ACCOUNT_ID: optionalString,
    STORAGE_PROVIDER: z.enum(["mock", "cloudinary"]).default("mock"),
    CLOUDINARY_CLOUD_NAME: optionalString,
    CLOUDINARY_API_KEY: optionalString,
    CLOUDINARY_API_SECRET: optionalString,
    CLOUDINARY_VERIFICATION_PRESET: optionalString,
    CLOUDINARY_TICKET_PRESET: optionalString,
    CLOUDINARY_EVIDENCE_PRESET: optionalString,
    CLOUDINARY_FOLDER_PREFIX: z.string().min(1).default("greenwallet"),
    CLOUDINARY_MAX_BYTES: z.coerce
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    VERIFICATION_PROVIDER: z.enum(["mock", "dojah"]).default("mock"),
    DOJAH_APP_ID: optionalString,
    DOJAH_PUBLIC_KEY: optionalString,
    DOJAH_SECRET_KEY: optionalString,
    DOJAH_WIDGET_ID: optionalString,
    DOJAH_WEBHOOK_SECRET: optionalString,
    DOJAH_BASE_URL: z.string().default("https://api.dojah.io")
  })
  .superRefine((value, context) => {
    const requireWhen = (
      enabled: boolean,
      label: string,
      required: Record<string, string | undefined>
    ) => {
      if (!enabled) {
        return;
      }
      for (const [key, current] of Object.entries(required)) {
        if (!current) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when ${label}`
          });
        }
      }
    };

    requireWhen(value.MAIL_PROVIDER === "zoho", "MAIL_PROVIDER=zoho", {
      MAIL_FROM_ADDRESS: value.MAIL_FROM_ADDRESS,
      ZOHO_MAIL_CLIENT_ID: value.ZOHO_MAIL_CLIENT_ID,
      ZOHO_MAIL_CLIENT_SECRET: value.ZOHO_MAIL_CLIENT_SECRET,
      ZOHO_MAIL_REFRESH_TOKEN: value.ZOHO_MAIL_REFRESH_TOKEN,
      ZOHO_MAIL_ACCOUNT_ID: value.ZOHO_MAIL_ACCOUNT_ID
    });

    requireWhen(
      value.STORAGE_PROVIDER === "cloudinary",
      "STORAGE_PROVIDER=cloudinary",
      {
        CLOUDINARY_CLOUD_NAME: value.CLOUDINARY_CLOUD_NAME,
        CLOUDINARY_API_KEY: value.CLOUDINARY_API_KEY,
        CLOUDINARY_API_SECRET: value.CLOUDINARY_API_SECRET,
        CLOUDINARY_VERIFICATION_PRESET: value.CLOUDINARY_VERIFICATION_PRESET,
        CLOUDINARY_TICKET_PRESET: value.CLOUDINARY_TICKET_PRESET,
        CLOUDINARY_EVIDENCE_PRESET: value.CLOUDINARY_EVIDENCE_PRESET
      }
    );

    requireWhen(
      value.VERIFICATION_PROVIDER === "dojah",
      "VERIFICATION_PROVIDER=dojah",
      {
        DOJAH_APP_ID: value.DOJAH_APP_ID,
        DOJAH_PUBLIC_KEY: value.DOJAH_PUBLIC_KEY,
        DOJAH_SECRET_KEY: value.DOJAH_SECRET_KEY,
        DOJAH_WIDGET_ID: value.DOJAH_WIDGET_ID,
        DOJAH_WEBHOOK_SECRET: value.DOJAH_WEBHOOK_SECRET
      }
    );
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("Invalid environment configuration:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
