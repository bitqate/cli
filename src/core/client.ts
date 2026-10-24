import { CliError, statusToError } from './errors';
import { buildApiPath, validateApiUrl } from './validate';
import pkg from '../../package.json';

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const MAX_429_RETRIES = 2;
const MAX_NETWORK_RETRIES = 1;
const RETRY_AFTER_CAP_S = 30;

export interface ClientOptions {
  apiUrl: string;
  token: string;
  verbose?: boolean;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class DryRunRequest extends Error {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;

  constructor(method: string, url: string, body: unknown) {
    super('dry run');
    this.method = method;
    this.url = url;
    this.body = body;
  }
}

function userAgent(): string {
  return `bitqate-cli/${pkg.version} (${process.platform}; ${process.arch})`;
}

async function readCappedText(resp: Response, limit: number): Promise<string> {
  if (!resp.body) return resp.text();
  const reader = resp.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new CliError('server', 'Response body too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string;
  private readonly verbose: boolean;
  private readonly dryRun: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: ClientOptions) {
    this.baseUrl = validateApiUrl(opts.apiUrl);
    this.token = opts.token;
    this.verbose = !!opts.verbose;
    this.dryRun = !!opts.dryRun;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  async request(
    method: string,
    segments: string[],
    opts: {
      query?: Record<string, string | number | undefined>;
      body?: unknown;
    } = {},
  ): Promise<any> {
    const path = buildApiPath(...segments);
    const url = new URL(this.baseUrl + path);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const target = url.toString();

    if (this.dryRun && method !== 'GET') {
      throw new DryRunRequest(method, target, opts.body ?? null);
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/json',
      'User-Agent': userAgent(),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    const idempotent = method === 'GET';
    let retries429 = 0;
    let retriesNet = 0;

    for (;;) {
      const init: RequestInit = {
        method,
        headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      const started = Date.now();
      let resp: Response;
      try {
        resp = await this.fetchImpl(target, init);
      } catch (err) {
        if (idempotent && retriesNet < MAX_NETWORK_RETRIES) {
          retriesNet++;
          continue;
        }
        throw new CliError(
          'network',
          `Could not reach the API: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (this.verbose) {
        process.stderr.write(
          `${method} ${target} -> ${resp.status} (${Date.now() - started}ms)\n`,
        );
      }

      if (resp.status >= 300 && resp.status < 400) {
        throw new CliError(
          'server',
          `API returned an unexpected redirect (HTTP ${resp.status})`,
          { status: resp.status },
        );
      }

      if (resp.status === 429 && idempotent && retries429 < MAX_429_RETRIES) {
        retries429++;
        const retryAfter = Math.min(
          Number(resp.headers.get('Retry-After')) || 1,
          RETRY_AFTER_CAP_S,
        );
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
        continue;
      }

      const text = await readCappedText(resp, MAX_BODY_BYTES);
      let data: any = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        throw new CliError(
          'server',
          `API returned an unreadable response (HTTP ${resp.status})`,
          { status: resp.status },
        );
      }

      if (!resp.ok || (data && data.success === false)) {
        const message =
          data && typeof data.message === 'string'
            ? data.message
            : `Request failed (HTTP ${resp.status})`;
        const retryAfter = resp.headers.get('Retry-After');
        throw statusToError(
          resp.status,
          message,
          retryAfter ? Number(retryAfter) : undefined,
        );
      }
      return data;
    }
  }

  get(segments: string[], query?: Record<string, string | number | undefined>) {
    return this.request('GET', segments, { query });
  }

  post(segments: string[], body?: unknown) {
    return this.request('POST', segments, { body });
  }

  put(segments: string[], body?: unknown) {
    return this.request('PUT', segments, { body });
  }

  patch(segments: string[], body?: unknown) {
    return this.request('PATCH', segments, { body });
  }

  delete(segments: string[]) {
    return this.request('DELETE', segments);
  }
}
