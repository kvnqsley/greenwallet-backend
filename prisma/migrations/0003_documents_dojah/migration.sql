ALTER TABLE "VerificationCase"
ADD COLUMN "providerStatus" TEXT,
ADD COLUMN "providerData" JSONB,
ADD COLUMN "completedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "VerificationCase_provider_providerRef_key"
ON "VerificationCase" ("provider", "providerRef");

ALTER TABLE "Document"
ADD COLUMN "verificationCaseId" TEXT,
ADD COLUMN "publicId" TEXT,
ADD COLUMN "secureUrl" TEXT,
ADD COLUMN "resourceType" TEXT,
ADD COLUMN "format" TEXT,
ADD COLUMN "originalName" TEXT;

CREATE INDEX "Document_verificationCaseId_idx" ON "Document" ("verificationCaseId");
CREATE INDEX "Document_publicId_idx" ON "Document" ("publicId");

ALTER TABLE "Document"
ADD CONSTRAINT "Document_verificationCaseId_fkey"
FOREIGN KEY ("verificationCaseId") REFERENCES "VerificationCase" ("id")
ON DELETE SET NULL ON UPDATE CASCADE;

DROP TABLE "VerificationDocument";
