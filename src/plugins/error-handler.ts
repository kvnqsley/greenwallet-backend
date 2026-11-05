import fp from "fastify-plugin";
import type { FastifyError } from "fastify";
import { Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { AppError } from "../common/errors";

type Problem = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance: string;
  errors?: unknown;
};

export default fp(
  async (app) => {
    app.setNotFoundHandler((request, reply) => {
      const problem: Problem = {
        type: "about:blank",
        title: "Not Found",
        status: 404,
        detail: `Route ${request.method} ${request.url} not found`,
        instance: request.id
      };
      return reply.code(404).send(problem);
    });

    app.setErrorHandler((error: FastifyError, request, reply) => {
      if (error instanceof ZodError) {
        const problem: Problem = {
          type: "about:blank",
          title: "Validation Error",
          status: 422,
          detail: "Request validation failed",
          instance: request.id,
          errors: error.flatten().fieldErrors
        };
        return reply.code(422).send(problem);
      }

      let status =
        error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
      let title = error.name;
      let detail = error.message;

      if (error instanceof AppError) {
        status = error.statusCode;
        title = error.code ?? "Error";
        detail = error.message;
      } else if (error instanceof Prisma.PrismaClientKnownRequestError) {
        if (error.code === "P2002") {
          status = 409;
          title = "conflict";
          detail = "A record with these values already exists";
        } else if (error.code === "P2025") {
          status = 404;
          title = "not_found";
          detail = "The requested record was not found";
        } else {
          status = 400;
          title = "database_error";
          detail = "The database rejected this operation";
        }
      } else if (error.validation) {
        status = 400;
        title = "validation_error";
      }

      if (status >= 500) {
        request.log.error({ err: error }, "request failed");
        title = "Internal Server Error";
        detail = "An unexpected error occurred";
      }

      const problem: Problem = {
        type: "about:blank",
        title,
        status,
        detail,
        instance: request.id
      };

      return reply.code(status).send(problem);
    });
  },
  { name: "error-handler" }
);
