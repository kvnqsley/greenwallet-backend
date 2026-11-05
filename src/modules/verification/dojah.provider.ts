import { badGateway } from "../../common/errors";
import type {
  NormalizedVerification,
  VerificationOutcome,
  VerificationProvider,
  WidgetConfig
} from "./verification-provider";

type DojahProviderOptions = {
  appId: string;
  publicKey: string;
  secretKey: string;
  widgetId: string;
  baseUrl: string;
};

export class DojahProvider implements VerificationProvider {
  readonly name = "DOJAH" as const;

  constructor(private readonly options: DojahProviderOptions) {}

  widgetConfig(referenceId: string): WidgetConfig {
    return {
      provider: "DOJAH",
      referenceId,
      appId: this.options.appId,
      publicKey: this.options.publicKey,
      widgetId: this.options.widgetId,
      type: "custom"
    };
  }

  async fetchVerification(
    referenceId: string
  ): Promise<NormalizedVerification | null> {
    const url = new URL("/api/v1/kyc/verification", this.options.baseUrl);
    url.searchParams.set("reference_id", referenceId);

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: this.options.secretKey,
          AppId: this.options.appId
        }
      });
    } catch {
      throw badGateway("Could not reach the Dojah verification service");
    }

    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw badGateway(`Dojah verification lookup failed (${response.status})`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw badGateway("Dojah returned an invalid verification response");
    }
    return normalizeDojahVerification(payload);
  }
}

export function normalizeDojahVerification(
  payload: unknown
): NormalizedVerification {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw badGateway("Dojah returned an invalid verification response");
  }

  const record = payload as Record<string, unknown>;
  const providerStatus =
    typeof record.verification_status === "string"
      ? record.verification_status
      : "Unknown";
  const overallStatus = record.status === true;
  const parts = record.data;

  let allStepsPassed = true;
  if (typeof parts === "object" && parts !== null && !Array.isArray(parts)) {
    for (const part of Object.values(parts as Record<string, unknown>)) {
      if (
        typeof part === "object" &&
        part !== null &&
        !Array.isArray(part) &&
        typeof (part as Record<string, unknown>).status === "boolean"
      ) {
        if ((part as Record<string, boolean>).status !== true) {
          allStepsPassed = false;
        }
      }
    }
  }

  const completed =
    providerStatus === "Completed" ||
    providerStatus === "Failed" ||
    providerStatus === "Abandoned";

  let outcome: VerificationOutcome = "PENDING";
  if (providerStatus === "Completed") {
    outcome = overallStatus && allStepsPassed ? "PASSED" : "FAILED";
  } else if (providerStatus === "Failed" || providerStatus === "Abandoned") {
    outcome = "FAILED";
  }

  const reason =
    typeof record.message === "string" && record.message.length > 0
      ? record.message
      : outcome === "FAILED"
        ? `Dojah verification ended with status ${providerStatus}`
        : null;

  return {
    providerStatus,
    outcome,
    reason,
    completedAt: completed ? new Date() : null,
    raw: payload
  };
}
