import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fetchHttpClient } from './http.js';

// Drive the real fetch wrapper against a throwaway localhost server — deterministic, no network.
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(`${req.method ?? ''} ${req.url ?? ''} ${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(
  () =>
    new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    }),
);

describe('fetchHttpClient', () => {
  it('performs a GET by default', async () => {
    const response = await fetchHttpClient.send({ url: `${base}/get` });

    expect(response.status).toBe(200);
    expect(response.body).toBe('GET /get ');
  });

  it('sends a POST with a body', async () => {
    const response = await fetchHttpClient.send({
      method: 'POST',
      url: `${base}/post`,
      headers: { 'content-type': 'text/plain' },
      body: 'payload',
    });

    expect(response.body).toBe('POST /post payload');
  });
});
