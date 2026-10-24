export type ErrorCode =
  | 'server'
  | 'network'
  | 'usage'
  | 'invalid_request'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'payment_required'
  | 'timeout';

export const EXIT_CODES: Record<ErrorCode, number> = {
  server: 1,
  network: 1,
  usage: 2,
  invalid_request: 2,
  unauthenticated: 3,
  forbidden: 4,
  not_found: 5,
  conflict: 6,
  rate_limited: 7,
  payment_required: 8,
  timeout: 9,
};

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly status?: number;
  readonly retryAfter?: number;
  readonly hint?: string;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { status?: number; retryAfter?: number; hint?: string } = {},
  ) {
    super(message);
    this.code = code;
    this.status = opts.status;
    this.retryAfter = opts.retryAfter;
    this.hint = opts.hint;
  }

  get exitCode(): number {
    return EXIT_CODES[this.code];
  }
}

export function usageError(message: string): CliError {
  return new CliError('usage', message);
}

export function statusToError(
  status: number,
  message: string,
  retryAfter?: number,
): CliError {
  let code: ErrorCode;
  if (status === 400 || status === 422) code = 'invalid_request';
  else if (status === 401) code = 'unauthenticated';
  else if (status === 402) code = 'payment_required';
  else if (status === 403) code = 'forbidden';
  else if (status === 404) code = 'not_found';
  else if (status === 409) code = 'conflict';
  else if (status === 429) code = 'rate_limited';
  else code = 'server';
  return new CliError(code, message, { status, retryAfter });
}
