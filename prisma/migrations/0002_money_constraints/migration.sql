ALTER TABLE "WalletBalance"
ADD CONSTRAINT "WalletBalance_non_negative"
CHECK ("availableMinor" >= 0 AND "heldMinor" >= 0);

CREATE UNIQUE INDEX "LedgerAccount_wallet_type_currency_key"
ON "LedgerAccount" ("walletId", "type", "currency")
WHERE "walletId" IS NOT NULL;

CREATE UNIQUE INDEX "LedgerAccount_external_settlement_key"
ON "LedgerAccount" ("type", "currency")
WHERE "walletId" IS NULL AND "ticketId" IS NULL;

CREATE UNIQUE INDEX "LedgerTransaction_ticket_funding_key"
ON "LedgerTransaction" ("ticketId")
WHERE "type" = 'TICKET_FUNDING';

CREATE UNIQUE INDEX "LedgerTransaction_milestone_release_key"
ON "LedgerTransaction" ("milestoneId")
WHERE "type" = 'MILESTONE_RELEASE';
