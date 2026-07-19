import type { ImportEvent } from '../../domain/import/events.js';

/**
 * Event versioning / upcasting seam: persisted events are immutable facts that live forever,
 * so every stored event carries a schema version, and read-side upcasters transform an old shape
 * forward (`v1 → v2 → …`) before `evolve` ever sees it. The MVP registry is pass-through — the
 * seam exists so the first real schema change is a localized, tested upcaster rather than a
 * migration, exactly the ES form of the no-breaking-change policy.
 */

/** The schema version stamped on every event written today. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Transforms one on-disk event payload from version N to version N+1. */
export type Upcaster = (data: Record<string, unknown>) => Record<string, unknown>;

export class UpcasterRegistry {
  // event type -> (fromVersion -> upcaster that produces fromVersion + 1)
  private readonly upcasters = new Map<string, Map<number, Upcaster>>();

  /** Register the upcaster that lifts `type` events from `fromVersion` to the next version. */
  register(type: string, fromVersion: number, upcaster: Upcaster): this {
    const forType = this.upcasters.get(type) ?? new Map<number, Upcaster>();
    forType.set(fromVersion, upcaster);
    this.upcasters.set(type, forType);
    return this;
  }

  /**
   * Apply the chain of registered upcasters from `schemaVersion` up to the latest known shape.
   * With nothing registered (the MVP), this is a pass-through: the stored payload is already
   * current and is returned untouched.
   */
  upcast(type: string, schemaVersion: number, data: Record<string, unknown>): ImportEvent {
    const forType = this.upcasters.get(type);
    if (forType === undefined) return data as unknown as ImportEvent;

    let version = schemaVersion;
    let current = data;
    for (let step = forType.get(version); step !== undefined; step = forType.get(version)) {
      current = step(current);
      version += 1;
    }
    return current as unknown as ImportEvent;
  }
}
