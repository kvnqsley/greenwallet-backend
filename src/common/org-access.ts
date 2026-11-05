import type { Membership, OrgRole, PrismaClient } from "@prisma/client";
import { forbidden, notFound } from "./errors";

export type MembershipWithOrganization = Membership & {
  organization: {
    id: string;
    name: string;
    type: string;
    roles: string[];
    verification: string;
  };
};

export async function requireMembership(
  prisma: PrismaClient,
  userId: string,
  organizationId: string,
  roles?: OrgRole[]
): Promise<MembershipWithOrganization> {
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId } },
    include: {
      organization: {
        select: {
          id: true,
          name: true,
          type: true,
          roles: true,
          verification: true
        }
      }
    }
  });

  if (!membership) {
    throw notFound("Organization not found");
  }

  if (roles && !roles.includes(membership.role)) {
    throw forbidden("You do not have permission to perform this action");
  }

  return membership as MembershipWithOrganization;
}
