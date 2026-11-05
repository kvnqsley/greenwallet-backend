import type { Prisma, PrismaClient } from "@prisma/client";

export const transactionOptions = {
  maxWait: 15_000,
  timeout: 30_000
};

export function withTransaction<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  return prisma.$transaction(fn, transactionOptions);
}
