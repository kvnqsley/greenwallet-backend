import type { FastifyBaseLogger } from "fastify";

export type MailMessage = {
  to: string;
  subject: string;
  text: string;
};

export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

export class LogMailer implements Mailer {
  constructor(private readonly log: FastifyBaseLogger) {}

  async send(message: MailMessage): Promise<void> {
    this.log.info({ mail: message }, "outbound email (mock)");
  }
}

const regionHosts = {
  us: {
    accounts: "https://accounts.zoho.com",
    mail: "https://mail.zoho.com"
  },
  eu: {
    accounts: "https://accounts.zoho.eu",
    mail: "https://mail.zoho.eu"
  },
  in: {
    accounts: "https://accounts.zoho.in",
    mail: "https://mail.zoho.in"
  },
  au: {
    accounts: "https://accounts.zoho.com.au",
    mail: "https://mail.zoho.com.au"
  },
  jp: {
    accounts: "https://accounts.zoho.jp",
    mail: "https://mail.zoho.jp"
  },
  ca: {
    accounts: "https://accounts.zohocloud.ca",
    mail: "https://mail.zohocloud.ca"
  }
} as const;

export type ZohoRegion = keyof typeof regionHosts;

export type ZohoMailConfig = {
  region: ZohoRegion;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accountId: string;
  fromAddress: string;
};

type TokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_SAFETY_WINDOW_MS = 60_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class ZohoMailer implements Mailer {
  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;

  constructor(
    private readonly config: ZohoMailConfig,
    private readonly log: FastifyBaseLogger
  ) {}

  async send(message: MailMessage): Promise<void> {
    try {
      await this.deliver(message);
    } catch (error) {
      this.log.warn(
        { err: error, to: message.to, subject: message.subject },
        "email delivery failed (non-blocking)"
      );
    }
  }

  private async deliver(message: MailMessage): Promise<void> {
    const hosts = regionHosts[this.config.region];
    const url = `${hosts.mail}/api/accounts/${encodeURIComponent(
      this.config.accountId
    )}/messages`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const token = await this.getAccessToken();
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Zoho-oauthtoken ${token}`
        },
        body: JSON.stringify({
          fromAddress: this.config.fromAddress,
          toAddress: message.to,
          subject: message.subject,
          content: message.text,
          mailFormat: "plaintext",
          askReceipt: "no"
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      });

      if (response.ok) {
        this.log.info(
          { to: message.to, subject: message.subject },
          "email sent via Zoho Mail"
        );
        return;
      }

      const detail = (await response.text()).slice(0, 500);
      lastError = new Error(
        `Zoho Mail API responded ${response.status}: ${detail}`
      );

      if (response.status === 401 && attempt < 1) {
        this.accessToken = null;
        continue;
      }
      if (
        (response.status === 429 || response.status >= 500) &&
        attempt < 2
      ) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      break;
    }

    throw lastError ?? new Error("Zoho Mail request failed");
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }

    const hosts = regionHosts[this.config.region];
    const response = await fetch(`${hosts.accounts}/oauth/v2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });

    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `Zoho token refresh failed: ${response.status} ${text.slice(0, 300)}`
      );
    }

    let data: TokenResponse;
    try {
      data = JSON.parse(text) as TokenResponse;
    } catch {
      throw new Error("Zoho token refresh returned invalid JSON");
    }

    if (!data.access_token) {
      throw new Error(
        `Zoho token refresh failed: ${data.error ?? "missing access_token"}`
      );
    }

    const expiresIn =
      typeof data.expires_in === "number" ? data.expires_in : 3600;
    this.accessToken = data.access_token;
    this.accessTokenExpiresAt =
      Date.now() + Math.max(60, expiresIn - TOKEN_SAFETY_WINDOW_MS / 1000) * 1000;
    return data.access_token;
  }
}
