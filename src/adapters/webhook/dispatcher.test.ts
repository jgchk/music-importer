import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixedClock, silentLogger } from '../../application/__fixtures__/fakes.js';
import type { PublishedEvent } from '../../application/ports/published-events-port.js';
import type { HttpClient, HttpRequest, HttpResponse } from '../support/http.js';
import { WebhookDispatcher } from './dispatcher.js';

const KEY = Buffer.from('c2VjcmV0LWtleS1ieXRlcy0xMjM0NTY3ODkwYWJjZGVm', 'base64');
const SECRET = `whsec_${KEY.toString('base64')}`;
const URL = 'https://downloader.example/api/v1/webhooks/verdicts';
const DELIVERY_ID = 'msg_0123456789abcdef0123456789abcdef';

const event: PublishedEvent = {
  type: 'release.verdict',
  timestamp: '2026-07-18T12:00:00.000Z',
  data: { acquisitionId: 'acq-1' },
};

// fixedClock default: 2026-07-18T12:00:00.000Z → unix seconds
const NOW_SECONDS = String(Math.floor(new Date('2026-07-18T12:00:00.000Z').getTime() / 1000));

function capturingHttp(status = 200): { http: HttpClient; requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  const http: HttpClient = {
    send: (request): Promise<HttpResponse> => {
      requests.push(request);
      return Promise.resolve({ status, body: '' });
    },
  };
  return { http, requests };
}

function dispatcher(http: HttpClient, secret = SECRET): WebhookDispatcher {
  return new WebhookDispatcher(silentLogger(), http, fixedClock(), { secret });
}

describe('WebhookDispatcher.deliver', () => {
  it('POSTs the Standard Webhooks envelope body to the subscriber', async () => {
    const { http, requests } = capturingHttp();
    const result = await dispatcher(http).deliver(URL, DELIVERY_ID, event);

    expect(result.isOk()).toBe(true);
    expect(requests).toHaveLength(1);
    const request = requests[0]!;
    expect(request.method).toBe('POST');
    expect(request.url).toBe(URL);
    expect(request.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(request.body!)).toEqual({
      type: event.type,
      timestamp: event.timestamp,
      data: event.data,
    });
  });

  it('carries webhook-id, webhook-timestamp, and a verifiable HMAC-SHA256 signature', async () => {
    const { http, requests } = capturingHttp();
    await dispatcher(http).deliver(URL, DELIVERY_ID, event);

    const headers = requests[0]!.headers!;
    expect(headers['webhook-id']).toBe(DELIVERY_ID);
    expect(headers['webhook-timestamp']).toBe(NOW_SECONDS);

    const signedContent = `${DELIVERY_ID}.${NOW_SECONDS}.${requests[0]!.body!}`;
    const expected = createHmac('sha256', KEY).update(signedContent).digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${expected}`);
  });

  it('accepts a bare base64 secret without the whsec_ prefix', async () => {
    const { http, requests } = capturingHttp();
    await dispatcher(http, KEY.toString('base64')).deliver(URL, DELIVERY_ID, event);

    const signedContent = `${DELIVERY_ID}.${NOW_SECONDS}.${requests[0]!.body!}`;
    const expected = createHmac('sha256', KEY).update(signedContent).digest('base64');
    expect(requests[0]!.headers!['webhook-signature']).toBe(`v1,${expected}`);
  });

  it('treats a non-2xx response as an unacknowledged delivery (InfraError)', async () => {
    const { http } = capturingHttp(500);
    const result = await dispatcher(http).deliver(URL, DELIVERY_ID, event);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe('InfraError');
    expect(error.message).toContain('500');
  });

  it('treats a transport failure as an InfraError', async () => {
    const http: HttpClient = { send: () => Promise.reject(new Error('ECONNREFUSED')) };
    const result = await dispatcher(http).deliver(URL, DELIVERY_ID, event);
    const error = result._unsafeUnwrapErr();
    expect(error.kind).toBe('InfraError');
    expect(error.message).toContain('ECONNREFUSED');
  });
});
