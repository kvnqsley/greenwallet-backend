-- Add index for listing share links by ticket
CREATE INDEX IF NOT EXISTS "ShareLink_ticketId_idx" ON "ShareLink"("ticketId");
