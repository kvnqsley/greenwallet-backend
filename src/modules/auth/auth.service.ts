import argon2 from "argon2";
import type { PlatformRole, PrismaClient, User } from "@prisma/client";
import { env } from "../../config/env";
import { badRequest, conflict, unauthorized } from "../../common/errors";
import { withTransaction } from "../../common/db";
import { generateToken, hashToken } from "../../common/tokens";

const EMAIL_VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000;

export type ClientMeta = {
  ip?: string;
  userAgent?: string;
};

export type PublicUser = {
  id: string;
  email: string;
  phone: string | null;
  name: string;
  platformRole: PlatformRole;
  emailVerifiedAt: Date | null;
  createdAt: Date;
};

export type RegisterInput = {
  email: string;
  password: string;
  name: string;
  phone?: string;
  organizationName: string;
  organizationType: "BUSINESS" | "INDIVIDUAL";
  roles: Array<"BUYER" | "SUPPLIER" | "EXPORTER">;
};

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    name: user.name,
    platformRole: user.platformRole,
    emailVerifiedAt: user.emailVerifiedAt,
    createdAt: user.createdAt
  };
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(
  hash: string,
  password: string
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export async function registerAccount(
  prisma: PrismaClient,
  input: RegisterInput
) {
  const email = input.email.trim().toLowerCase();
  const phone = input.phone?.trim() || undefined;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    throw conflict("An account with this email already exists");
  }

  if (phone) {
    const phoneOwner = await prisma.user.findUnique({ where: { phone } });
    if (phoneOwner) {
      throw conflict("An account with this phone number already exists");
    }
  }

  const passwordHash = await hashPassword(input.password);
  const verificationToken = generateToken();

  const { user, organization } = await withTransaction(prisma, async (tx) => {
    const createdUser = await tx.user.create({
      data: {
        email,
        phone,
        name: input.name,
        passwordHash,
        emailVerificationTokenHash: hashToken(verificationToken),
        emailVerificationExpiresAt: new Date(
          Date.now() + EMAIL_VERIFICATION_TTL_MS
        )
      }
    });

    const createdOrganization = await tx.organization.create({
      data: {
        name: input.organizationName,
        type: input.organizationType,
        roles: input.roles
      }
    });

    await tx.membership.create({
      data: {
        userId: createdUser.id,
        organizationId: createdOrganization.id,
        role: "OWNER"
      }
    });

    return { user: createdUser, organization: createdOrganization };
  });

  return { user, organization, verificationToken };
}

export async function authenticateCredentials(
  prisma: PrismaClient,
  email: string,
  password: string
): Promise<User> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() }
  });

  if (!user || !(await verifyPassword(user.passwordHash, password))) {
    throw unauthorized("Invalid email or password");
  }

  return user;
}

export async function createRefreshToken(
  prisma: PrismaClient,
  userId: string,
  meta: ClientMeta
) {
  const token = generateToken(48);
  const expiresAt = new Date(
    Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000
  );

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(token),
      expiresAt,
      ip: meta.ip,
      userAgent: meta.userAgent
    }
  });

  return { token, expiresAt };
}

export async function rotateRefreshToken(
  prisma: PrismaClient,
  rawToken: string,
  meta: ClientMeta
) {
  const record = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashToken(rawToken) },
    include: { user: true }
  });

  if (!record || record.revokedAt || record.expiresAt <= new Date()) {
    throw unauthorized("Invalid or expired refresh token");
  }

  await prisma.refreshToken.update({
    where: { id: record.id },
    data: { revokedAt: new Date(), lastUsedAt: new Date() }
  });

  const next = await createRefreshToken(prisma, record.userId, meta);

  return { user: record.user, refreshToken: next.token, refreshExpiresAt: next.expiresAt };
}

export async function revokeRefreshToken(
  prisma: PrismaClient,
  rawToken: string
): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(rawToken), revokedAt: null },
    data: { revokedAt: new Date() }
  });
}

export async function verifyEmail(
  prisma: PrismaClient,
  rawToken: string
): Promise<User> {
  const user = await prisma.user.findFirst({
    where: {
      emailVerificationTokenHash: hashToken(rawToken),
      emailVerificationExpiresAt: { gt: new Date() }
    }
  });

  if (!user) {
    throw badRequest("Invalid or expired verification token");
  }

  return prisma.user.update({
    where: { id: user.id },
    data: {
      emailVerifiedAt: new Date(),
      emailVerificationTokenHash: null,
      emailVerificationExpiresAt: null
    }
  });
}

export async function createEmailVerificationToken(
  prisma: PrismaClient,
  userId: string
): Promise<string> {
  const token = generateToken();
  await prisma.user.update({
    where: { id: userId },
    data: {
      emailVerificationTokenHash: hashToken(token),
      emailVerificationExpiresAt: new Date(
        Date.now() + EMAIL_VERIFICATION_TTL_MS
      )
    }
  });
  return token;
}

export async function createPasswordResetToken(
  prisma: PrismaClient,
  email: string
): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { email: email.trim().toLowerCase() }
  });

  if (!user) {
    return null;
  }

  const token = generateToken();
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: hashToken(token),
      passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS)
    }
  });

  return token;
}

export async function resetPassword(
  prisma: PrismaClient,
  rawToken: string,
  password: string
): Promise<void> {
  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash: hashToken(rawToken),
      passwordResetExpiresAt: { gt: new Date() }
    }
  });

  if (!user) {
    throw badRequest("Invalid or expired password reset token");
  }

  const passwordHash = await hashPassword(password);

  await withTransaction(prisma, async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null
      }
    });

    await tx.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() }
    });
  });
}
