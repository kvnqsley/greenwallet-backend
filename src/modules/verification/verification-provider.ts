export type VerificationOutcome = "PASSED" | "FAILED" | "PENDING";

export type NormalizedVerification = {
  providerStatus: string;
  outcome: VerificationOutcome;
  reason: string | null;
  completedAt: Date | null;
  raw: unknown;
};

export type WidgetConfig = {
  provider: "DOJAH" | "MOCK";
  referenceId: string;
  appId: string | null;
  publicKey: string | null;
  widgetId: string | null;
  type: "custom";
};

export interface VerificationProvider {
  readonly name: "MOCK" | "DOJAH";
  widgetConfig(referenceId: string): WidgetConfig;
  fetchVerification(
    referenceId: string
  ): Promise<NormalizedVerification | null>;
}
