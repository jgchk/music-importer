import type { FastifyInstance } from 'fastify';
import { findAcquisitionImport, submitImport } from '../../application/import/use-cases.js';
import type { UseCaseDeps } from '../../application/import/use-cases.js';
import { fulfilledToSubmission, rerootLocation } from '../contracts/intake/mapping.js';
import {
  acquisitionFulfilledSchema,
  intakeEventEnvelopeSchema,
} from '../contracts/intake/schemas.js';
import { signingKeyOf, verifyWebhookDelivery } from './webhook-verification.js';

/**
 * The inbound acquisition webhook receiver (downloader-intake): a Standard Webhooks-style edge
 * that verifies the shared-secret signature and timestamp over the *raw* body before any parsing,
 * tolerantly reads only the fields this service needs, re-roots the sender's location into the
 * importer's namespace, and converges redeliveries durably by acquisition id before reusing the
 * native submission path. Config-dormant: the composition root supplies these options only when a
 * receiver secret is configured; without one the endpoint does not exist. Hidden from the OpenAPI
 * document — a machine-to-machine surface documented by its spec, not part of the human/agent API.
 */

export const INTAKE_WEBHOOK_PATH = '/api/v1/webhooks/acquisitions';

export interface IntakeWebhookOptions {
  /** The shared signing secret (`whsec_<base64>`), identical to the sender's. */
  readonly secret: string;
  /** The sender's root prefix under which every delivered `location` must fall. */
  readonly sourceRoot: string;
  /** The importer's own intake root the stripped remainder is re-joined onto. */
  readonly intakeRoot: string;
  /** Filesystem probe injected by the composition root (the interface layer does no I/O itself). */
  readonly directoryExists: (directory: string) => Promise<boolean>;
}

function headerOf(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export async function registerIntakeWebhook(
  app: FastifyInstance,
  deps: UseCaseDeps,
  options: IntakeWebhookOptions,
): Promise<void> {
  const key = signingKeyOf(options.secret);

  await app.register((scope, _opts, done) => {
    // The signature covers the exact request bytes, so this scope keeps the body a raw string —
    // verification strictly precedes parsing (encapsulated: other routes parse JSON as usual).
    scope.addContentTypeParser<string>(
      'application/json',
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.post<{ Body: string }>(
      INTAKE_WEBHOOK_PATH,
      { schema: { hide: true } },
      async (request, reply) => {
        const body = request.body;
        const verified = verifyWebhookDelivery({
          key,
          headers: {
            id: headerOf(request.headers['webhook-id']),
            timestamp: headerOf(request.headers['webhook-timestamp']),
            signature: headerOf(request.headers['webhook-signature']),
          },
          body,
          now: deps.clock.now(),
        });
        if (verified.isErr()) {
          return reply.code(401).send({ error: verified.error });
        }
        const { deliveryId } = verified.value;

        let payload: unknown;
        try {
          payload = JSON.parse(body);
        } catch {
          return reply.code(400).send({ error: 'InvalidPayload' });
        }
        const envelope = intakeEventEnvelopeSchema.safeParse(payload);
        if (!envelope.success) {
          return reply.code(400).send({ error: 'InvalidPayload' });
        }
        if (envelope.data.type !== 'acquisition.fulfilled') {
          // The sender may add event types; acknowledge and ignore rather than poison its retries.
          request.log.info({ deliveryId, type: envelope.data.type }, 'intake event ignored');
          return reply.code(204).send();
        }
        const parsed = acquisitionFulfilledSchema.safeParse(payload);
        if (!parsed.success) {
          return reply.code(400).send({ error: 'InvalidPayload' });
        }

        const { acquisitionId, location, hints, candidate } = fulfilledToSubmission(parsed.data);
        // Durable convergence first: a redelivered acquisition no-ops even after the import
        // applied and the intake directory is long gone.
        const existing = findAcquisitionImport(deps, acquisitionId);
        if (existing !== undefined) {
          request.log.info({ acquisitionId, deliveryId, importId: existing }, 'intake converged');
          return reply.code(204).send();
        }

        const rerooted = rerootLocation({
          location,
          sourceRoot: options.sourceRoot,
          intakeRoot: options.intakeRoot,
        });
        if (rerooted.isErr()) {
          return reply.code(400).send({ error: rerooted.error });
        }
        const directory = rerooted.value;
        if (!(await options.directoryExists(directory))) {
          // Not visible (yet): answer retryably so the sender's at-least-once retry redelivers —
          // a silent 2xx here would drop the release on the floor.
          return reply.code(503).send({ error: 'IntakeDirectoryMissing' });
        }

        const result = await submitImport(deps, {
          directory,
          hints,
          source: { acquisitionId, candidate },
        });
        return result.match(
          ({ importId }) => {
            request.log.info({ acquisitionId, deliveryId, importId }, 'intake import submitted');
            return reply.code(204).send();
          },
          // As on the manual route: submission never fails on domain grounds — the sad paths are
          // infra faults and append races, both of which the sender redelivers.
          (error) =>
            reply.code(error.kind === 'InfraError' ? 500 : 409).send({ error: error.kind }),
        );
      },
    );

    done();
  });
}
