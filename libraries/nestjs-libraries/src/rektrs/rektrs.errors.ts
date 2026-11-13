import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * REKTRS P3 — stable machine-readable error codes (design P3-1 §3.1).
 * Every REKTRS API failure is an HttpException whose body is { code, message }.
 */
export class RektrsException extends HttpException {
  constructor(
    status: HttpStatus,
    public code: string,
    message: string
  ) {
    super({ code, message }, status);
    this.name = 'RektrsException';
  }
}

export const rektrsError = {
  notFound: (code: string, message: string) =>
    new RektrsException(HttpStatus.NOT_FOUND, code, message),
  forbidden: (code: string, message: string) =>
    new RektrsException(HttpStatus.FORBIDDEN, code, message),
  conflict: (code: string, message: string) =>
    new RektrsException(HttpStatus.CONFLICT, code, message),
  unprocessable: (code: string, message: string) =>
    new RektrsException(HttpStatus.UNPROCESSABLE_ENTITY, code, message),
  badRequest: (code: string, message: string) =>
    new RektrsException(HttpStatus.BAD_REQUEST, code, message),
};
