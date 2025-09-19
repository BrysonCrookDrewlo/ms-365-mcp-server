import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { createAndSaveSimplifiedOpenAPI } from '../bin/modules/simplified-openapi.mjs';

describe('OpenAPI normalization', () => {
  it('hoists property pointer refs into reusable components', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-normalization-'));

    try {
      const endpointsFile = path.join(tempDir, 'endpoints.json');
      const openapiFile = path.join(tempDir, 'openapi.yaml');
      const trimmedFile = path.join(tempDir, 'openapi-trimmed.yaml');

      const endpoints = [
        {
          pathPattern: '/test',
          method: 'get',
          toolName: 'getTest',
        },
      ];

      fs.writeFileSync(endpointsFile, JSON.stringify(endpoints, null, 2));

      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/test': {
            get: {
              summary: 'Test operation',
              responses: {
                '200': {
                  description: 'OK',
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        properties: {
                          main: { $ref: '#/components/schemas/TestResponse' },
                          nestedData: {
                            $ref: '#/components/schemas/TestResponse/properties/nested',
                          },
                          sharedInline: { $ref: '#/properties/sharedThing' },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        components: {
          schemas: {
            TestResponse: {
              type: 'object',
              properties: {
                shared: { $ref: '#/properties/sharedThing' },
                nested: {
                  type: 'object',
                  description: 'Nested data description',
                  properties: {
                    id: { type: 'string' },
                  },
                },
              },
            },
          },
        },
        properties: {
          sharedThing: {
            type: 'array',
            description: 'Shared pointer schema',
            items: { type: 'string' },
          },
        },
      };

      fs.writeFileSync(openapiFile, yaml.dump(spec));

      createAndSaveSimplifiedOpenAPI(endpointsFile, openapiFile, trimmedFile);

      const trimmedContent = fs.readFileSync(trimmedFile, 'utf8');
      const trimmedSpec = yaml.load(trimmedContent);

      const allRefs = new Set();
      collectRefs(trimmedSpec, allRefs);

      const propertyRefs = [...allRefs].filter(
        (ref) => typeof ref === 'string' && ref.startsWith('#/properties/')
      );
      expect(propertyRefs).toHaveLength(0);

      const nestedComponentRefs = [...allRefs].filter((ref) => {
        if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) {
          return false;
        }
        const remainder = ref.replace('#/components/schemas/', '');
        return remainder.includes('/');
      });
      expect(nestedComponentRefs).toHaveLength(0);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function collectRefs(node, refs) {
  if (!node || typeof node !== 'object') {
    return;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => collectRefs(item, refs));
    return;
  }

  if (node.$ref) {
    refs.add(node.$ref);
  }

  Object.values(node).forEach((value) => collectRefs(value, refs));
}
