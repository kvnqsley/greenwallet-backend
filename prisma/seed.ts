import "dotenv/config";
import argon2 from "argon2";
import {
  type Organization,
  type OrgType,
  type PlatformRole,
  PrismaClient,
  type VerificationStatus
} from "@prisma/client";

const prisma = new PrismaClient();

const DEMO_PASSWORD = "Password123!";

async function upsertOrganization(
  name: string,
  type: OrgType,
  verification: VerificationStatus
): Promise<Organization> {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) {
    return existing;
  }

  return prisma.organization.create({
    data: { name, type, verification, country: "NG" }
  });
}

async function upsertUser(
  email: string,
  name: string,
  platformRole: PlatformRole = "USER"
) {
  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id
  });

  return prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      name,
      passwordHash,
      platformRole,
      emailVerifiedAt: new Date()
    }
  });
}

async function ensureWallet(organizationId: string) {
  const existing = await prisma.wallet.findUnique({
    where: { organizationId_currency: { organizationId, currency: "NGN" } },
    include: { balance: true }
  });

  if (existing) {
    if (!existing.balance) {
      await prisma.walletBalance.create({
        data: { walletId: existing.id, availableMinor: 0n, heldMinor: 0n }
      });
    }
    return existing;
  }

  return prisma.wallet.create({
    data: {
      organizationId,
      currency: "NGN",
      provider: "MOCK",
      balance: { create: { availableMinor: 0n, heldMinor: 0n } }
    }
  });
}

async function ensureMembership(
  userId: string,
  organizationId: string,
  role: "OWNER" | "ADMIN" | "MEMBER"
) {
  return prisma.membership.upsert({
    where: { userId_organizationId: { userId, organizationId } },
    update: { role },
    create: { userId, organizationId, role }
  });
}

async function main() {
  const buyerOrg = await upsertOrganization(
    "Sahel Agro Buyers Ltd",
    "BUSINESS",
    "VERIFIED"
  );
  const supplierOrg = await upsertOrganization(
    "Kano Grain Cooperative",
    "BUSINESS",
    "VERIFIED"
  );

  const admin = await upsertUser(
    "admin@greenwallet.test",
    "GreenWallet Admin",
    "ADMIN"
  );
  const buyer = await upsertUser("buyer@greenwallet.test", "Bilkisu Buyer");
  const supplier = await upsertUser(
    "supplier@greenwallet.test",
    "Musa Supplier"
  );

  await ensureMembership(buyer.id, buyerOrg.id, "OWNER");
  await ensureMembership(supplier.id, supplierOrg.id, "OWNER");
  await ensureMembership(admin.id, buyerOrg.id, "ADMIN");

  await ensureWallet(buyerOrg.id);
  await ensureWallet(supplierOrg.id);

  console.log("Seed complete:");
  console.log(`  Organizations: ${buyerOrg.name}, ${supplierOrg.name}`);
  console.log(
    `  Users: ${buyer.email}, ${supplier.email}, ${admin.email} (password: ${DEMO_PASSWORD})`
  );
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
