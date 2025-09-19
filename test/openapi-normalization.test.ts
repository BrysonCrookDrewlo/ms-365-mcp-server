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

      const trimmedSchemas = trimmedSpec.components?.schemas || {};
      expect(Object.keys(trimmedSchemas)).toEqual(
        expect.arrayContaining(['TestResponse', 'TestResponseSharedThing', 'GetTestTestResponseNested'])
      );

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

      const schemaRefs = [...allRefs].filter(
        (ref) => typeof ref === 'string' && ref.startsWith('#/components/schemas/')
      );
      schemaRefs.forEach((ref) => {
        const schemaName = ref.replace('#/components/schemas/', '');
        expect(trimmedSchemas[schemaName]).toBeDefined();
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('normalizes parameter schemas referencing nested component properties', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openapi-parameter-normalization-'));

    try {
      const endpointsFile = path.join(tempDir, 'endpoints.json');
      const openapiFile = path.join(tempDir, 'openapi.yaml');
      const trimmedFile = path.join(tempDir, 'openapi-trimmed.yaml');

      const endpoints = [
        {
          pathPattern: '/test',
          method: 'get',
          toolName: 'getTestParameters',
        },
      ];

      fs.writeFileSync(endpointsFile, JSON.stringify(endpoints, null, 2));

      const spec = {
        openapi: '3.0.0',
        info: { title: 'Test API', version: '1.0.0' },
        paths: {
          '/test': {
            parameters: [
              {
                name: 'pathParam',
                in: 'query',
                required: false,
                schema: {
                  $ref: '#/components/schemas/Foo/properties/bar',
                },
              },
            ],
            get: {
              summary: 'Test operation',
              parameters: [
                {
                  name: 'queryParam',
                  in: 'query',
                  schema: {
                    $ref: '#/components/schemas/Foo/properties/baz',
                  },
                },
                {
                  name: 'jsonParam',
                  in: 'header',
                  content: {
                    'application/json': {
                      schema: {
                        $ref: '#/components/schemas/Foo/properties/bar',
                      },
                    },
                  },
                },
                { $ref: '#/components/parameters/FooBarParam' },
                { $ref: '#/components/parameters/FooBazContentParam' },
              ],
              responses: {
                '200': {
                  description: 'OK',
                },
              },
            },
          },
        },
        components: {
          schemas: {
            Foo: {
              type: 'object',
              properties: {
                bar: { type: 'string', description: 'Bar value' },
                baz: { type: 'integer', format: 'int32' },
              },
            },
          },
          parameters: {
            FooBarParam: {
              name: 'headerParam',
              in: 'header',
              schema: {
                $ref: '#/components/schemas/Foo/properties/bar',
              },
            },
            FooBazContentParam: {
              name: 'jsonHeaderParam',
              in: 'header',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Foo/properties/baz',
                  },
                },
              },
            },
          },
        },
      };

      fs.writeFileSync(openapiFile, yaml.dump(spec));

      createAndSaveSimplifiedOpenAPI(endpointsFile, openapiFile, trimmedFile);

      const trimmedContent = fs.readFileSync(trimmedFile, 'utf8');
      const trimmedSpec = yaml.load(trimmedContent);

      const expectNormalizedRef = (ref) => {
        expect(ref).toBeDefined();
        expect(typeof ref).toBe('string');
        expect(ref.startsWith('#/components/schemas/')).toBe(true);
        const schemaName = ref.replace('#/components/schemas/', '');
        expect(schemaName).not.toContain('/');
        const schema = trimmedSpec.components?.schemas?.[schemaName];
        expect(schema).toBeDefined();
        return { schemaName, schema };
      };

      const fooBarParam = trimmedSpec.components?.parameters?.FooBarParam;
      expect(fooBarParam).toBeDefined();
      const barRef = fooBarParam?.schema?.$ref;
      const { schema: barSchema } = expectNormalizedRef(barRef);
      expect(barSchema).toMatchObject({ type: 'string', description: 'Bar value' });

      const fooBazContentParam = trimmedSpec.components?.parameters?.FooBazContentParam;
      expect(fooBazContentParam).toBeDefined();
      const bazContentRef =
        fooBazContentParam?.content?.['application/json']?.schema?.$ref;
      const { schema: bazContentSchema } = expectNormalizedRef(bazContentRef);
      expect(bazContentSchema).toMatchObject({ type: 'integer', format: 'int32' });

      const getOperation = trimmedSpec.paths?.['/test']?.get;
      expect(getOperation).toBeDefined();

      const queryParam = getOperation?.parameters?.find((param) => param?.name === 'queryParam');
      expect(queryParam).toBeDefined();
      const queryParamRef = queryParam?.schema?.$ref;
      const { schema: querySchema } = expectNormalizedRef(queryParamRef);
      expect(querySchema).toMatchObject({ type: 'integer', format: 'int32' });

      const jsonParam = getOperation?.parameters?.find((param) => param?.name === 'jsonParam');
      expect(jsonParam).toBeDefined();
      const jsonParamRef = jsonParam?.content?.['application/json']?.schema?.$ref;
      expectNormalizedRef(jsonParamRef);
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
