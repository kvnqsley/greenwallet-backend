export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string) =>
  new AppError(400, message, "bad_request");
export const unauthorized = (message = "Authentication required") =>
  new AppError(401, message, "unauthorized");
export const forbidden = (message = "Insufficient permissions") =>
  new AppError(403, message, "forbidden");
export const notFound = (message = "Resource not found") =>
  new AppError(404, message, "not_found");
export const conflict = (message: string) =>
  new AppError(409, message, "conflict");
export const badGateway = (message: string) =>
  new AppError(502, message, "bad_gateway");
