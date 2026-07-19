import type { IncomingMessage, ServerResponse } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getImport,
  listImports,
  listPendingReviews,
  resolveReview,
  submitImport,
} from '../../application/import/use-cases.js';
import type { UseCaseDeps } from '../../application/import/use-cases.js';
import type { Logger } from '../../application/logging/logger.js';
import {
  hintsToDomain,
  pendingReviewToDto,
  resolutionToDomain,
  resolveReviewArgsSchema,
  statusViewToDto,
  submitImportRequestSchema,
} from '../contracts/index.js';

/**
 * The MCP inbound adapter: the same application use-cases, exposed idiomatically. Commands become
 * tools (`submit_import`, `resolve_review`) and queries become resources (`mi://imports`,
 * `mi://imports/{id}`, `mi://imports/reviews`). Tool input schemas are derived from the shared
 * zod contracts via `z.toJSONSchema`, so HTTP validation, OpenAPI, and MCP cannot drift.
 *
 * MCP is served over the streamable HTTP transport on the application's own HTTP server
 * (`registerMcpEndpoint`), so every client talks to the one running instance — no stdio, no
 * client-spawned second process racing the reactor. The transport runs stateless: a fresh server
 * and transport are built per request (nothing here pushes to clients, so sessions buy nothing).
 */

const MCP_PATH = '/mcp';

const COLLECTION_URI = 'mi://imports';
const REVIEWS_URI = 'mi://imports/reviews';
const STATUS_URI = /^mi:\/\/imports\/([^/]+)$/;

function text(payload: unknown): { content: [{ type: 'text'; text: string }] } {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function toolError(message: string): {
  content: [{ type: 'text'; text: string }];
  isError: true;
} {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function resource(
  uri: string,
  payload: unknown,
): {
  contents: [{ uri: string; mimeType: string; text: string }];
} {
  return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload) }] };
}

export function buildMcpServer(deps: UseCaseDeps, logger: Logger, version: string): Server {
  const server = new Server(
    { name: 'music-importer', version },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, () => ({
    tools: [
      {
        name: 'submit_import',
        description:
          'Submit a directory of music files for import; returns the import id. Idempotent per directory.',
        inputSchema: z.toJSONSchema(submitImportRequestSchema),
      },
      {
        name: 'resolve_review',
        description:
          'Resolve a pending review by verb (apply-candidate, supply-id, refresh-candidates, manual-tags, import-as-is, reject, reject-and-retry-download, accept, retry-enrichment). reject deletes the files ("wrong thing to have"); reject-and-retry-download additionally records a release verdict so the delivering downloader retries with a different copy ("right thing, bad copy") — available only for downloader-delivered imports with a retained candidate, otherwise refused with NoRetainedCandidate.',
        inputSchema: z.toJSONSchema(resolveReviewArgsSchema),
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'submit_import') {
      const parsed = submitImportRequestSchema.safeParse(args);
      if (!parsed.success) return toolError('invalid arguments');
      const result = await submitImport(deps, {
        directory: parsed.data.path,
        hints: hintsToDomain(parsed.data),
      });
      return result.match(
        ({ importId }) => {
          logger.info({ importId }, 'mcp import submitted');
          return text({ importId });
        },
        (error) => toolError(error.kind),
      );
    }
    if (name === 'resolve_review') {
      const parsed = resolveReviewArgsSchema.safeParse(args);
      if (!parsed.success) return toolError('invalid arguments');
      const result = await resolveReview(
        deps,
        parsed.data.id,
        resolutionToDomain(parsed.data.resolution),
      );
      return result.match(
        () => {
          logger.info(
            { importId: parsed.data.id, verb: parsed.data.resolution.verb },
            'mcp review resolved',
          );
          return text({ importId: parsed.data.id });
        },
        (error) => toolError(error.kind),
      );
    }
    return toolError(`unknown tool: ${name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, () => ({
    resources: [
      { uri: COLLECTION_URI, name: 'imports', mimeType: 'application/json' },
      { uri: REVIEWS_URI, name: 'pending reviews', mimeType: 'application/json' },
      ...listImports(deps).map((view) => ({
        uri: `${COLLECTION_URI}/${view.importId}`,
        name: `import ${view.importId}`,
        mimeType: 'application/json',
      })),
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, (request) => {
    const { uri } = request.params;
    if (uri === COLLECTION_URI) {
      return resource(uri, { imports: listImports(deps).map(statusViewToDto) });
    }
    if (uri === REVIEWS_URI) {
      return resource(uri, { reviews: listPendingReviews(deps).map(pendingReviewToDto) });
    }
    const statusMatch = STATUS_URI.exec(uri);
    if (statusMatch) {
      const view = getImport(deps, statusMatch[1]!);
      if (view === undefined) throw new McpError(ErrorCode.InvalidParams, 'unknown import');
      return resource(uri, statusViewToDto(view));
    }
    throw new McpError(ErrorCode.InvalidParams, `unknown resource: ${uri}`);
  });

  return server;
}

/**
 * Mount the MCP server on the given Fastify app at `POST /mcp` (streamable HTTP). `/mcp` sits
 * outside the `/api/v1` REST prefix on purpose: MCP versions its own protocol at initialize, so it
 * must not be coupled to the REST resource version. The POST route hijacks the reply and lets the
 * transport write the raw response directly. `GET`/`DELETE` — which the streamable HTTP protocol
 * uses only to open or tear down server-push SSE streams — are refused with a method-not-allowed
 * JSON-RPC error, since this stateless surface never pushes to clients.
 */
export function registerMcpEndpoint(
  app: FastifyInstance,
  deps: UseCaseDeps,
  logger: Logger,
  version: string,
): void {
  // `hide: true` keeps MCP off the derived OpenAPI document: `/mcp` is a JSON-RPC surface, not
  // part of the versioned REST contract the OpenAPI snapshot guards.
  const hidden = { schema: { hide: true } };

  app.post(
    MCP_PATH,
    hidden,
    async (
      request: { raw: IncomingMessage; body?: unknown },
      reply: { hijack: () => void; raw: ServerResponse },
    ): Promise<void> => {
      const server = buildMcpServer(deps, logger, version);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      reply.hijack();
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  );

  const methodNotAllowed = (
    _request: unknown,
    reply: { code: (status: number) => { send: (body: unknown) => void } },
  ): void => {
    reply.code(405).send({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    });
  };
  app.get(MCP_PATH, hidden, methodNotAllowed);
  app.delete(MCP_PATH, hidden, methodNotAllowed);
}
