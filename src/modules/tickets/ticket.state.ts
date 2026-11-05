import type { TicketStatus } from "@prisma/client";
import { conflict } from "../../common/errors";

const transitions: Record<TicketStatus, readonly TicketStatus[]> = {
  DRAFT: ["AWAITING_ACCEPTANCE", "CANCELLED"],
  AWAITING_ACCEPTANCE: ["ACTIVE", "CANCELLED"],
  ACTIVE: ["FUNDED", "CANCELLED", "DISPUTED"],
  FUNDED: ["IN_PROGRESS", "DISPUTED"],
  IN_PROGRESS: ["COMPLETED", "DISPUTED"],
  COMPLETED: [],
  CANCELLED: [],
  DISPUTED: []
};

export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  return transitions[from].includes(to);
}

export function assertTicketTransition(
  from: TicketStatus,
  to: TicketStatus
): void {
  if (!canTransition(from, to)) {
    throw conflict(`Cannot move a ticket from ${from} to ${to}`);
  }
}
