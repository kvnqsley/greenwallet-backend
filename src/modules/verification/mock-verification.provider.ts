import type {
  NormalizedVerification,
  VerificationProvider,
  WidgetConfig
} from "./verification-provider";

export class MockVerificationProvider implements VerificationProvider {
  readonly name = "MOCK" as const;

  widgetConfig(referenceId: string): WidgetConfig {
    return {
      provider: "MOCK",
      referenceId,
      appId: null,
      publicKey: null,
      widgetId: null,
      type: "custom"
    };
  }

  async fetchVerification(
    _referenceId: string
  ): Promise<NormalizedVerification> {
    return {
      providerStatus: "MockPending",
      outcome: "PENDING",
      reason: "Mock verification requires admin review",
      completedAt: null,
      raw: { provider: "MOCK" }
    };
  }
}
