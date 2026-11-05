-- Add index for listing share links by ticket
CREATE INDEX "ShareLink_ticketId_idx" ON "ShareLink"("ticketId");
