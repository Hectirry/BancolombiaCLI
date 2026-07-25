/**
 * Small fetch wrapper with JSON handling, timeouts and typed errors. Used by
 * the headless `connect` proxy client and anywhere else we talk HTTP.
 */

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly body: string,
  ) {
    super(`HTTP ${status} ${statusText}: ${body.slice(0, 500)}`);
    this.name = "HttpError";
  }
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Bearer token added as `Authorization: Bearer <token>`. */
  token?: string;
  /** Abort after this many ms. Defaults to 30s. */
  timeoutMs?: number;
}

export async function request<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = "GET", headers = {}, body, token, timeoutMs = 30_000 } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const finalHeaders: Record<string, string> = {
    Accept: "application/json",
    ...headers,
  };
  if (token) finalHeaders.Authorization = `Bearer ${token}`;

  let payload: string | undefined;
  if (body !== undefined) {
    finalHeaders["Content-Type"] ??= "application/json";
    payload = typeof body === "string" ? body : JSON.stringify(body);
  }

  try {
    const res = await fetch(url, {
      method,
      headers: finalHeaders,
      body: payload,
      signal: controller.signal,
    });

    const text = await res.text();
    if (!res.ok) throw new HttpError(res.status, res.statusText, text);

    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  } finally {
    clearTimeout(timer);
  }
}
