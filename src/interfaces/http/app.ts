import Fastify from 'fastify';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { CommandError } from '../../application/import/command-handler.js';
import {
  getImport,
  listImports,
  listPendingReviews,
  resolveReview,
  submitImport,
} from '../../application/import/use-cases.js';
import type { UseCaseDeps } from '../../application/import/use-cases.js';
import type { Logger } from '../../application/logging/logger.js';
import type { TaggerConfiguration } from '../../application/ports/outbound-ports.js';
import {
  errorResponseSchema,
  hintsToDomain,
  importIdParamsSchema,
  importListResponseSchema,
  importStatusResponseSchema,
  pendingReviewToDto,
  resolutionToDomain,
  resolveReviewRequestSchema,
  resolveReviewResponseSchema,
  reviewListResponseSchema,
  statusViewToDto,
  submitImportRequestSchema,
  submitImportResponseSchema,
} from '../contracts/index.js';
import { registerIntakeWebhook } from './intake-webhook.js';
import type { IntakeWebhookOptions } from './intake-webhook.js';
import { registerMcpEndpoint } from '../mcp/server.js';

/**
 * The versioned HTTP API. A thin inbound adapter: it validates against the shared zod contracts,
 * maps DTOs to/from the domain via the anti-corruption layer, and delegates to the application
 * use-cases — it never touches domain types directly. Submissions are accepted asynchronously
 * (`202`) with a status URL to observe. The same zod schemas drive request validation, the OpenAPI
 * document, and the MCP tool schemas. The MCP server is mounted on this same app (streamable
 * HTTP, `POST /mcp`) so one process serves both surfaces over one port.
 */

const BASE_PATH = '/api/v1/imports';

/**
 * Map a use-case command failure to an HTTP status: infra faults are 5xx, an unknown import is
 * 404, and the rest are conflicts with the stream's current state.
 */
export function statusForCommandError(error: CommandError): 500 | 404 | 409 {
  if (error.kind === 'InfraError') return 500;
  if (error.kind === 'UnknownImport') return 404;
  return 409;
}

export interface HttpAppOptions {
  /** The effective beets configuration reported at startup, exposed on the debug endpoint. */
  readonly beetsConfig?: TaggerConfiguration;
  /** When configured, the signed acquisition webhook receiver; absent → the route does not exist. */
  readonly intake?: IntakeWebhookOptions;
}

export async function buildHttpApp(
  deps: UseCaseDeps,
  logger: Logger,
  version: string,
  options: HttpAppOptions = {},
): Promise<FastifyInstance> {
  let requestSeq = 0;
  // Widen to Fastify's logger interface so the instance keeps the default logger generic.
  const baseLogger: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance: baseLogger,
    // Honor an inbound trace id at the edge; otherwise mint a per-request id.
    genReqId: (req) => {
      const header = req.headers['x-request-id'];
      return typeof header === 'string' ? header : `req-${(requestSeq += 1)}`;
    },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(fastifySwagger, {
    openapi: {
      info: { title: 'Music Importer API', version },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(fastifySwaggerUi, { routePrefix: '/docs' });

  registerImportRoutes(app, deps);
  registerDebugRoutes(app, options);
  if (options.intake !== undefined) {
    await registerIntakeWebhook(app, deps, options.intake);
  }
  registerMcpEndpoint(app, deps, logger, version);

  await app.ready();
  return app;
}

function registerImportRoutes(app: FastifyInstance, deps: UseCaseDeps): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();

  typed.post(
    BASE_PATH,
    {
      schema: {
        body: submitImportRequestSchema,
        response: {
          202: submitImportResponseSchema,
          400: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const result = await submitImport(deps, {
        directory: request.body.path,
        hints: hintsToDomain(request.body),
      });
      return result.match(
        ({ importId }) => {
          request.log.info({ importId }, 'import submitted');
          return reply.code(202).send({ importId, statusUrl: `${BASE_PATH}/${importId}` });
        },
        // Submission is keyed by directory and idempotent, so `decide` never refuses it with a
        // domain error: the sad paths here are infra faults and append races.
        (error) => reply.code(error.kind === 'InfraError' ? 500 : 409).send({ error: error.kind }),
      );
    },
  );

  typed.get(BASE_PATH, { schema: { response: { 200: importListResponseSchema } } }, () => ({
    imports: listImports(deps).map(statusViewToDto),
  }));

  // A static segment: Fastify routes it ahead of the `/:id` parameter route.
  typed.get(
    `${BASE_PATH}/reviews`,
    { schema: { response: { 200: reviewListResponseSchema } } },
    () => ({ reviews: listPendingReviews(deps).map(pendingReviewToDto) }),
  );

  typed.get(
    `${BASE_PATH}/:id`,
    {
      schema: {
        params: importIdParamsSchema,
        response: { 200: importStatusResponseSchema, 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const view = getImport(deps, request.params.id);
      if (view === undefined) {
        return reply.code(404).send({ error: 'NotFound' });
      }
      return statusViewToDto(view);
    },
  );

  typed.post(
    `${BASE_PATH}/:id/review`,
    {
      schema: {
        params: importIdParamsSchema,
        body: resolveReviewRequestSchema,
        response: {
          202: resolveReviewResponseSchema,
          400: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          500: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await resolveReview(deps, id, resolutionToDomain(request.body));
      return result.match(
        () => {
          request.log.info({ importId: id, verb: request.body.verb }, 'review resolved');
          return reply.code(202).send({ importId: id });
        },
        (error) => reply.code(statusForCommandError(error)).send({ error: error.kind }),
      );
    },
  );
}

/**
 * The startup-validated effective beets configuration (design D3), for operator inspection. Kept
 * off the OpenAPI document: it is a debug surface, not part of the versioned `/api/v1` contract.
 */
function registerDebugRoutes(app: FastifyInstance, options: HttpAppOptions): void {
  app.get('/debug/beets-config', { schema: { hide: true } }, (_request, reply) => {
    if (options.beetsConfig === undefined) {
      return reply.code(404).send({ error: 'NotAvailable' });
    }
    return reply.send(options.beetsConfig);
  });
}
