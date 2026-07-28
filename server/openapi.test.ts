import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import yaml from 'js-yaml';

const specPath = new URL('../docs/openapi/bap-v1.yaml', import.meta.url);

describe('BAP OpenAPI specification', () => {
  test('parses and exposes Phase 4 correction impact endpoint', () => {
    const spec = yaml.load(readFileSync(specPath, 'utf8')) as any; // eslint-disable-line @typescript-eslint/no-explicit-any

    expect(spec).toBeTruthy();
    expect(spec.paths['/businesses/{businessId}/corrections/{correctionId}/impacts']).toBeTruthy();
    expect(spec.paths['/businesses/{businessId}/corrections/{correctionId}/impacts'].get.summary).toContain('affected');
  });
});