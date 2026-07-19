import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { candidate } from '../../domain/import/__fixtures__/import-fixtures.js';
import { buildHttpApp } from '../http/app.js';
import { silentLogger, testWiring } from '../__fixtures__/wiring.js';
import type { TestWiring } from '../__fixtures__/wiring.js';
import { buildMcpServer } from './server.js';

const INTAKE = '/intake/Artist - Album';

interface CallToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
}

/** Parse the first (text) content of a resource read, sidestepping the text|blob content union. */
function firstJson(res: { contents: unknown[] }): unknown {
  return JSON.parse((res.contents[0] as { text: string }).text);
}

describe('MCP server', () => {
  let wiring: TestWiring;
  let client: Client;

  beforeEach(async () => {
    wiring = testWiring();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await buildMcpServer(wiring.deps, silentLogger(), '9.9.9').connect(serverTransport);
    client = new Client({ name: 'test', version: '0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
  });

  async function submit(): Promise<string> {
    const result = (await client.callTool({
      name: 'submit_import',
      arguments: { path: INTAKE },
    })) as CallToolResult;
    const { importId } = JSON.parse(result.content[0]!.text) as { importId: string };
    await wiring.dispatch(importId, { type: 'Propose', directory: INTAKE });
    return importId;
  }

  it('advertises the injected release version as its server version', () => {
    expect(client.getServerVersion()?.version).toBe('9.9.9');
  });

  it('advertises the submit and resolve tools with derived input schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['resolve_review', 'submit_import']);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }
  });

  it('submits an import and returns its id', async () => {
    const result = (await client.callTool({
      name: 'submit_import',
      arguments: { path: INTAKE, hints: { mbReleaseId: 'mb-1' } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const { importId } = JSON.parse(result.content[0]!.text) as { importId: string };
    expect(importId).toMatch(/^imp-/);
  });

  it('reports invalid submit arguments as a tool error', async () => {
    const result = (await client.callTool({
      name: 'submit_import',
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('invalid arguments');
  });

  it('reports an event-store fault during submit as a tool error', async () => {
    wiring.store.failReads = true;

    const result = (await client.callTool({
      name: 'submit_import',
      arguments: { path: INTAKE },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('InfraError');
  });

  it('resolves a pending review — the same operation the HTTP surface offers', async () => {
    wiring.setProposal({
      kind: 'proposal',
      candidates: [candidate({ distance: 0.9 })],
      duplicates: [],
    });
    const importId = await submit();

    const result = (await client.callTool({
      name: 'resolve_review',
      arguments: {
        id: importId,
        resolution: {
          verb: 'apply-candidate',
          candidate: { dataSource: 'MusicBrainz', albumId: 'album-1' },
        },
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0]!.text)).toEqual({ importId });
  });

  it('reports invalid resolve arguments as a tool error', async () => {
    const result = (await client.callTool({
      name: 'resolve_review',
      arguments: { id: 'imp-1' },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
  });

  it('reports a domain refusal during resolve as a tool error', async () => {
    const result = (await client.callTool({
      name: 'resolve_review',
      arguments: { id: 'imp-missing', resolution: { verb: 'import-as-is' } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('UnknownImport');
  });

  it('refuses reject-and-retry-download without a retained candidate — same shape as HTTP', async () => {
    const importId = await submit(); // manual submission: no source, no candidate

    const result = (await client.callTool({
      name: 'resolve_review',
      arguments: {
        id: importId,
        resolution: { verb: 'reject-and-retry-download', reasons: ['corrupt rip'] },
      },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toBe('NoRetainedCandidate');
  });

  it('reports an unknown tool as a tool error', async () => {
    const result = (await client.callTool({ name: 'nope', arguments: {} })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('unknown tool');
  });

  it('lists the collection, the reviews queue, and per-import resources', async () => {
    const id = await submit();

    const { resources } = await client.listResources();

    expect(resources.map((r) => r.uri)).toEqual([
      'mi://imports',
      'mi://imports/reviews',
      `mi://imports/${id}`,
    ]);
  });

  it('reads the collection, the reviews queue, and a single import', async () => {
    const id = await submit(); // default stub: no candidates → a no-match review

    const collection = firstJson(await client.readResource({ uri: 'mi://imports' }));
    expect((collection as { imports: unknown[] }).imports).toHaveLength(1);

    const reviews = firstJson(await client.readResource({ uri: 'mi://imports/reviews' }));
    expect(reviews).toEqual({
      reviews: [{ importId: id, path: INTAKE, review: { kind: 'no-match' } }],
    });

    const status = firstJson(await client.readResource({ uri: `mi://imports/${id}` }));
    expect(status).toMatchObject({ importId: id, status: 'awaiting-review' });
  });

  it('rejects reads of unknown imports and unknown resources', async () => {
    await expect(client.readResource({ uri: 'mi://imports/missing' })).rejects.toThrow();
    await expect(client.readResource({ uri: 'mi://other' })).rejects.toThrow();
  });
});

describe('MCP over streamable HTTP', () => {
  let wiring: TestWiring;
  let app: FastifyInstance;
  let client: Client;

  beforeEach(async () => {
    wiring = testWiring();
    app = await buildHttpApp(wiring.deps, silentLogger(), '0.0.0-test');
    await app.listen({ port: 0, host: '127.0.0.1' });
    const { port } = app.server.address() as AddressInfo;
    client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)),
    );
  });

  afterEach(async () => {
    await client.close();
    await app.close();
  });

  it('completes the handshake and advertises the tools with derived schemas', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(['resolve_review', 'submit_import']);
  });

  it('round-trips a submission over the same server the HTTP API uses', async () => {
    const submitted = (await client.callTool({
      name: 'submit_import',
      arguments: { path: INTAKE },
    })) as CallToolResult;
    expect(submitted.isError).toBeFalsy();
    wiring.sync();

    const { importId } = JSON.parse(submitted.content[0]!.text) as { importId: string };
    const status = firstJson(await client.readResource({ uri: `mi://imports/${importId}` }));
    expect(status).toMatchObject({ importId, status: 'requested' });
  });

  it('refuses the SSE stream methods on the stateless endpoint', async () => {
    const get = await app.inject({ method: 'GET', url: '/mcp' });
    const del = await app.inject({ method: 'DELETE', url: '/mcp' });
    expect(get.statusCode).toBe(405);
    expect(del.statusCode).toBe(405);
  });
});
