import { createHash } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { badRequest, conflict } from "./errors";
import { withTransaction } from "./db";

export type IdempotencyScope = {
  organizationId: string;
  endpoint: string;
  key: string;
  requestHash: string;
};

export type IdempotentResult<T> = {
  replayed: boolean;
  responseCode: number;
  body: T;
};

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function requireIdempotencyKey(
  value: string | string[] | undefined
): string {
  
  return value as string;
}

export function idempotencyScope(input: {
  organizationId: string;
  endpoint: string;
  key: string;
  request: unknown;
}): IdempotencyScope {
  return {
    organizationId: input.organizationId,
    endpoint: input.endpoint,
    key: input.key,
    requestHash: hash(input.request)
  };
}

export function idempotencyLedgerKey(scope: IdempotencyScope): string {
  return hash({
    organizationId: scope.organizationId,
    endpoint: scope.endpoint,
    key: scope.key
  });
}

export async function readIdempotentResponse<T>(
  prisma: PrismaClient,
  scope: IdempotencyScope
): Promise<IdempotentResult<T> | null> {
  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      organizationId_endpoint_key: {
        organizationId: scope.organizationId,
        endpoint: scope.endpoint,
        key: scope.key
      }
    }
  });

  if (!existing) {
    return null;
  }
  if (existing.requestHash !== scope.requestHash) {
    throw conflict("Idempotency key was reused with a different request");
  }
  if (existing.responseCode === null || existing.responseBody === null) {
    throw conflict("A request with this idempotency key is already in progress");
  }

  return {
    replayed: true,
    responseCode: existing.responseCode,
    body: existing.responseBody as T
  };
}

export async function executeIdempotent<T>(
  prisma: PrismaClient,
  scope: IdempotencyScope,
  handler: (
    tx: Prisma.TransactionClient,
    ledgerIdempotencyKey: string
  ) => Promise<{ code: number; body: T }>
): Promise<IdempotentResult<T>> {
  const replay = await readIdempotentResponse<T>(prisma, scope);
  if (replay) {
    return replay;
  }

  try {
    return await withTransaction(prisma, async (tx) => {
      const existing = await tx.idempotencyKey.findUnique({
        where: {
          organizationId_endpoint_key: {
            organizationId: scope.organizationId,
            endpoint: scope.endpoint,
            key: scope.key
          }
        }
      });

      if (existing) {
        if (existing.requestHash !== scope.requestHash) {
          throw conflict("Idempotency key was reused with a different request");
        }
        if (existing.responseCode === null || existing.responseBody === null) {
          throw conflict(
            "A request with this idempotency key is already in progress"
          );
        }
        return {
          replayed: true,
          responseCode: existing.responseCode,
          body: existing.responseBody as T
        };
      }

      const result = await handler(tx, idempotencyLedgerKey(scope));
      const body = toJson(result.body);

      await tx.idempotencyKey.create({
        data: {
          organizationId: scope.organizationId,
          endpoint: scope.endpoint,
          key: scope.key,
          requestHash: scope.requestHash,
          responseCode: result.code,
          responseBody: body
        }
      });

      return {
        replayed: false,
        responseCode: result.code,
        body: body as T
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const raced = await readIdempotentResponse<T>(prisma, scope);
      if (raced) {
        return raced;
      }
    }
    throw error;
  }
}
