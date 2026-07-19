import { describe, expect, it } from 'vitest';
import { additivityViolations } from '../../scripts/contracts/event-schemas.js';

/** The additive-only rule's mechanization must itself be trustworthy: prove what it catches. */

const base = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['album', 'track'] },
    year: { default: null, anyOf: [{ type: 'integer' }, { type: 'null' }] },
    files: {
      type: 'array',
      items: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
  },
  required: ['id', 'kind'],
};

function withPatch(patch: (schema: typeof base) => unknown): unknown {
  return patch(JSON.parse(JSON.stringify(base)) as typeof base);
}

describe('additivityViolations', () => {
  it('accepts an identical schema', () => {
    expect(additivityViolations(base, base)).toEqual([]);
  });

  it('accepts a new optional property, a new enum value, and a newly required new field', () => {
    const next = withPatch((schema) => {
      const s = schema as unknown as Record<string, unknown>;
      (s.properties as Record<string, unknown>).extra = { type: 'string' };
      ((s.properties as Record<string, { enum?: string[] }>).kind.enum ??= []).push('single');
      (s.required as string[]).push('extra');
      return s;
    });
    expect(additivityViolations(base, next)).toEqual([]);
  });

  it('flags a removed property', () => {
    const next = withPatch((schema) => {
      delete (schema.properties as Record<string, unknown> & { id?: unknown }).id;
      return schema;
    });
    expect(additivityViolations(base, next)).toEqual(['$.id: property removed']);
  });

  it('flags a retyped property', () => {
    const next = withPatch((schema) => {
      (schema.properties as Record<string, unknown>).id = { type: 'number' };
      return schema;
    });
    expect(additivityViolations(base, next).join()).toContain('$.id: type changed');
  });

  it('flags a required field becoming optional', () => {
    const next = withPatch((schema) => ({ ...schema, required: ['id'] }));
    expect(additivityViolations(base, next).join()).toContain('$.kind: no longer required');
  });

  it('flags a removed enum value', () => {
    const next = withPatch((schema) => {
      (schema.properties as Record<string, { enum?: string[] }>).kind.enum = ['album'];
      return schema;
    });
    expect(additivityViolations(base, next).join()).toContain('enum value "track" removed');
  });

  it('flags a changed default', () => {
    const next = withPatch((schema) => {
      (schema.properties as Record<string, { default?: unknown }>).year.default = 0;
      return schema;
    });
    expect(additivityViolations(base, next).join()).toContain('$.year: default changed');
  });

  it('flags a removed anyOf alternative (nullability revoked)', () => {
    const next = withPatch((schema) => {
      (schema.properties as Record<string, { anyOf?: unknown[] }>).year.anyOf = [
        { type: 'integer' },
      ];
      return schema;
    });
    expect(additivityViolations(base, next).join()).toContain('anyOf alternative 1 removed');
  });

  it('recurses into array items', () => {
    const next = withPatch((schema) => {
      (
        schema.properties as Record<string, { items?: { properties: { name: unknown } } }>
      ).files.items!.properties.name = { type: 'number' };
      return schema;
    });
    expect(additivityViolations(base, next).join()).toContain('$.files[].name: type changed');
  });

  it('flags a const change and a leaf replaced by a non-object', () => {
    expect(additivityViolations({ const: 'a' }, { const: 'b' }).join()).toContain('const changed');
    expect(
      additivityViolations(
        { type: 'object', properties: { x: true } },
        { type: 'object', properties: { x: false } },
      ).join(),
    ).toContain('$.x: schema changed');
  });
});
