export class HttpError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown, code?: string) {
    super(message);
    this.status = status;
    this.code = code ?? String(status);
    this.details = details;
  }
}

export function badRequest(message: string, details?: unknown, code?: string) {
  // Support passing { code: "..." } inside details (used throughout the codebase).
  const resolvedCode =
    code ??
    (typeof details === "object" && details !== null && "code" in details
      ? String((details as Record<string, unknown>).code)
      : undefined);
  return new HttpError(400, message, details, resolvedCode);
}

export function unauthorized(message = "Unauthorized") {
  return new HttpError(401, message);
}

export function forbidden(message = "Forbidden") {
  return new HttpError(403, message);
}

export function notFound(message = "Not found") {
  return new HttpError(404, message);
}

export function conflict(message: string, details?: unknown) {
  return new HttpError(409, message, details);
}

export function unprocessable(message: string, details?: unknown) {
  return new HttpError(422, message, details);
}
