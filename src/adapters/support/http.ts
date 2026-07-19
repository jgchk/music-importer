/**
 * A tiny HTTP seam for the outbound network adapters (the webhook dispatcher). Keeping it behind
 * an interface lets those adapters be unit-tested against canned responses — no live calls in the
 * unit tier — while the default implementation is a thin wrapper over `fetch`.
 */
export interface HttpRequest {
  readonly method?: 'GET' | 'POST';
  readonly url: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  readonly body: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpResponse>;
}

export const fetchHttpClient: HttpClient = {
  async send({ method = 'GET', url, headers, body }) {
    const response = await fetch(url, { method, headers, body });
    return { status: response.status, body: await response.text() };
  },
};
