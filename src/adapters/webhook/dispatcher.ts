import { createHmac } from 'node:crypto';
import { ResultAsync, errAsync, okAsync } from 'neverthrow';
import type { Logger } from '../../application/logging/logger.js';
import { infraError } from '../../application/ports/errors.js';
import type { InfraError } from '../../application/ports/errors.js';
import type {
  PublishedEvent,
  WebhookDeliveryPort,
} from '../../application/ports/published-events-port.js';
import type { Clock } from '../../application/ports/system-ports.js';
import type { HttpClient } from '../support/http.js';

/**
 * The webhook dispatcher (change: outbound-release-verdicts): delivers one published event to
 * one subscriber per the Standard Webhooks conventions — a `{type, timestamp, data}` JSON body
 * with `webhook-id` (the caller-supplied deterministic idempotency key), `webhook-timestamp`
 * (delivery time, for the receiver's replay window), and `webhook-signature`
 * (`v1,` + base64 HMAC-SHA256 over `id.timestamp.body` with the shared secret, `whsec_<base64>`).
 * Only a 2xx response acknowledges the delivery; everything else is an {@link InfraError} the
 * publisher retries.
 */

export interface WebhookDispatcherConfig {
  readonly secret: string; // `whsec_<base64>` (the bare base64 is tolerated)
}

const SECRET_PREFIX = 'whsec_';

export class WebhookDispatcher implements WebhookDeliveryPort {
  private readonly key: Buffer;

  constructor(
    private readonly logger: Logger,
    private readonly http: HttpClient,
    private readonly clock: Clock,
    config: WebhookDispatcherConfig,
  ) {
    const encoded = config.secret.startsWith(SECRET_PREFIX)
      ? config.secret.slice(SECRET_PREFIX.length)
      : config.secret;
    this.key = Buffer.from(encoded, 'base64');
  }

  deliver(url: string, deliveryId: string, event: PublishedEvent): ResultAsync<void, InfraError> {
    const body = JSON.stringify({ type: event.type, timestamp: event.timestamp, data: event.data });
    const timestamp = String(Math.floor(this.clock.now().getTime() / 1000));
    const signature = createHmac('sha256', this.key)
      .update(`${deliveryId}.${timestamp}.${body}`)
      .digest('base64');
    this.logger.debug({ url, deliveryId, type: event.type }, 'dispatching webhook');
    return ResultAsync.fromPromise(
      this.http.send({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/json',
          'webhook-id': deliveryId,
          'webhook-timestamp': timestamp,
          'webhook-signature': `v1,${signature}`,
        },
        body,
      }),
      (cause) => infraError('webhook.deliver', String(cause), cause),
    ).andThen((response) =>
      response.status >= 200 && response.status < 300
        ? okAsync<void, InfraError>(undefined)
        : errAsync(
            infraError('webhook.deliver', `subscriber responded ${String(response.status)}`),
          ),
    );
  }
}
