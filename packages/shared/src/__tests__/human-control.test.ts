import { describe, expect, it } from 'vitest';
import * as shared from '../index.js';

describe('named human bridge ingress', () => {
  it('requires an explicit strict target and rejects identity or proxy injection', () => {
    const schema = (shared as Record<string, any>).humanOperationRequestSchema;
    expect(schema, 'human operation ingress must be exported').toBeDefined();
    const valid = { target: { kind: 'company', companyId: '00000000-0000-4000-8000-000000000001' }, operationId: 'workforce.brief.read', version: 1, input: {} };
    expect(schema.safeParse(valid).success).toBe(true);
    for (const bad of [ { ...valid, target: undefined }, { ...valid, version: 2 }, { ...valid, actor: { userId: 'admin' } }, { ...valid, url: 'https://other.example' }, { ...valid, target: { kind: 'self', userId: 'other' } }, { ...valid, operationId: 'raw.request' } ]) {
      expect(schema.safeParse(bad).success).toBe(false);
    }
  });
});
