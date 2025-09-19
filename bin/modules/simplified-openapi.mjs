import fs from 'fs';
import yaml from 'js-yaml';

export function createAndSaveSimplifiedOpenAPI(endpointsFile, openapiFile, openapiTrimmedFile) {
  const allEndpoints = JSON.parse(fs.readFileSync(endpointsFile, 'utf8'));
  const endpoints = allEndpoints.filter((endpoint) => !endpoint.disabled);

  const spec = fs.readFileSync(openapiFile, 'utf8');
  const openApiSpec = yaml.load(spec);

  for (const endpoint of endpoints) {
    if (!openApiSpec.paths[endpoint.pathPattern]) {
      throw new Error(`Path "${endpoint.pathPattern}" not found in OpenAPI spec.`);
    }
  }

  for (const [key, value] of Object.entries(openApiSpec.paths)) {
    const e = endpoints.filter((ep) => ep.pathPattern === key);
    if (e.length === 0) {
      delete openApiSpec.paths[key];
    } else {
      for (const [method, operation] of Object.entries(value)) {
        const eo = e.find((ep) => ep.method.toLowerCase() === method);
        if (eo) {
          operation.operationId = eo.toolName;
          if (!operation.description && operation.summary) {
            operation.description = operation.summary;
          }
          if (operation.parameters) {
            operation.parameters = operation.parameters.map((param) => {
              if (param.$ref && param.$ref.startsWith('#/components/parameters/')) {
                const paramName = param.$ref.replace('#/components/parameters/', '');
                const resolvedParam = openApiSpec.components?.parameters?.[paramName];
                if (resolvedParam) {
                  return { ...resolvedParam };
                }
              }
              return param;
            });
          }
        } else {
          delete value[method];
        }
      }
    }
  }

  if (openApiSpec.components && openApiSpec.components.schemas) {
    removeODataTypeRecursively(openApiSpec.components.schemas);
    flattenComplexSchemasRecursively(openApiSpec.components.schemas);
  }

  if (openApiSpec.paths) {
    removeODataTypeRecursively(openApiSpec.paths);
    simplifyAnyOfInPaths(openApiSpec.paths);
  }

  console.log('✨ Normalizing inline schema references...');
  normalizeSchemaRefs(openApiSpec);

  console.log('🧹 Pruning unused schemas...');
  const usedSchemas = findUsedSchemas(openApiSpec);
  pruneUnusedSchemas(openApiSpec, usedSchemas);

  fs.writeFileSync(openapiTrimmedFile, yaml.dump(openApiSpec));
}

function normalizeSchemaRefs(openApiSpec) {
  if (!openApiSpec || typeof openApiSpec !== 'object') {
    return;
  }

  openApiSpec.components = openApiSpec.components || {};
  openApiSpec.components.schemas = openApiSpec.components.schemas || {};

  const pointerToComponent = new Map();
  const existingNames = new Set(Object.keys(openApiSpec.components.schemas));
  const visitedSchemas = new WeakSet();
  let hoistedCount = 0;

  const httpMethods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);

  const processSchema = (schema, contextName) => {
    if (!schema || typeof schema !== 'object' || visitedSchemas.has(schema)) {
      return;
    }

    visitedSchemas.add(schema);

    if (typeof schema.$ref === 'string') {
      const normalizedRef = hoistRef(schema, contextName);
      if (normalizedRef) {
        schema.$ref = normalizedRef;
      }
    }

    if (Array.isArray(schema.allOf)) {
      schema.allOf.forEach((subSchema) => processSchema(subSchema, contextName));
    }
    if (Array.isArray(schema.anyOf)) {
      schema.anyOf.forEach((subSchema) => processSchema(subSchema, contextName));
    }
    if (Array.isArray(schema.oneOf)) {
      schema.oneOf.forEach((subSchema) => processSchema(subSchema, contextName));
    }
    if (Array.isArray(schema.prefixItems)) {
      schema.prefixItems.forEach((subSchema) => processSchema(subSchema, contextName));
    }

    if (schema.not) {
      processSchema(schema.not, contextName);
    }
    if (schema.contains) {
      processSchema(schema.contains, contextName);
    }
    if (schema.propertyNames) {
      processSchema(schema.propertyNames, contextName);
    }
    if (schema.if) {
      processSchema(schema.if, contextName);
    }
    if (schema.then) {
      processSchema(schema.then, contextName);
    }
    if (schema.else) {
      processSchema(schema.else, contextName);
    }

    if (schema.items) {
      if (Array.isArray(schema.items)) {
        schema.items.forEach((item) => processSchema(item, contextName));
      } else {
        processSchema(schema.items, contextName);
      }
    }

    if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      processSchema(schema.additionalProperties, contextName);
    }

    if (schema.additionalItems && typeof schema.additionalItems === 'object') {
      processSchema(schema.additionalItems, contextName);
    }

    if (schema.unevaluatedItems && typeof schema.unevaluatedItems === 'object') {
      processSchema(schema.unevaluatedItems, contextName);
    }

    if (schema.unevaluatedProperties && typeof schema.unevaluatedProperties === 'object') {
      processSchema(schema.unevaluatedProperties, contextName);
    }

    if (schema.patternProperties && typeof schema.patternProperties === 'object') {
      Object.values(schema.patternProperties).forEach((propSchema) =>
        processSchema(propSchema, contextName)
      );
    }

    if (schema.dependencies && typeof schema.dependencies === 'object') {
      Object.values(schema.dependencies).forEach((dep) => {
        if (dep && typeof dep === 'object') {
          processSchema(dep, contextName);
        }
      });
    }

    if (schema.dependentSchemas && typeof schema.dependentSchemas === 'object') {
      Object.values(schema.dependentSchemas).forEach((dep) => processSchema(dep, contextName));
    }

    if (schema.properties && typeof schema.properties === 'object') {
      Object.values(schema.properties).forEach((propSchema) => processSchema(propSchema, contextName));
    }
  };

  const processParameter = (parameter, contextName) => {
    if (!parameter || typeof parameter !== 'object') {
      return;
    }

    const parameterName = typeof parameter.name === 'string' ? parameter.name : '';
    let derivedContext = contextName || '';
    if (parameterName) {
      derivedContext = derivedContext ? `${derivedContext} ${parameterName}` : parameterName;
    }
    if (!derivedContext) {
      derivedContext = 'Parameter';
    }

    if (parameter.schema && typeof parameter.schema === 'object') {
      processSchema(parameter.schema, derivedContext);
    }

    if (parameter.content && typeof parameter.content === 'object') {
      Object.entries(parameter.content).forEach(([mediaType, content]) => {
        if (content?.schema) {
          const mediaContext = mediaType ? `${derivedContext} ${mediaType}` : derivedContext;
          processSchema(content.schema, mediaContext);
        }
      });
    }
  };

  const hoistRef = (schemaNode, contextName) => {
    const ref = schemaNode.$ref;
    if (!shouldHoistRef(ref)) {
      return null;
    }

    if (pointerToComponent.has(ref)) {
      const componentName = pointerToComponent.get(ref);
      return `#/components/schemas/${componentName}`;
    }

    const resolved = resolveJsonPointerWithParent(openApiSpec, ref);
    if (!resolved) {
      return null;
    }

    const { parent, key, value } = resolved;
    if (!value || typeof value !== 'object') {
      return null;
    }

    if (value.$ref && typeof value.$ref === 'string') {
      if (!shouldHoistRef(value.$ref) && value.$ref.startsWith('#/components/schemas/')) {
        const existingName = value.$ref.replace('#/components/schemas/', '');
        pointerToComponent.set(ref, existingName);
        return value.$ref;
      }
    }

    const clonedSchema = cloneSchema(value);

    let derivedContext = contextName;
    if (!derivedContext && ref.startsWith('#/components/schemas/')) {
      const remainder = ref.slice('#/components/schemas/'.length);
      derivedContext = remainder.split('/')[0];
    }

    const componentName = generateComponentName(derivedContext, ref, existingNames);
    pointerToComponent.set(ref, componentName);
    openApiSpec.components.schemas[componentName] = clonedSchema;
    hoistedCount += 1;

    const replacementRef = `#/components/schemas/${componentName}`;
    parent[key] = { $ref: replacementRef };

    processSchema(clonedSchema, componentName);

    return replacementRef;
  };

  Object.entries(openApiSpec.components.schemas).forEach(([schemaName, schema]) => {
    processSchema(schema, schemaName);
  });

  Object.entries(openApiSpec.components?.parameters || {}).forEach(([parameterName, parameter]) => {
    processParameter(parameter, `ComponentParameter ${parameterName}`);
  });

  Object.entries(openApiSpec.paths || {}).forEach(([pathKey, pathItem]) => {
    if (!pathItem || typeof pathItem !== 'object') {
      return;
    }

    if (Array.isArray(pathItem.parameters)) {
      pathItem.parameters.forEach((parameter) => {
        processParameter(parameter, `Path ${pathKey}`);
      });
    }

    Object.entries(pathItem).forEach(([method, operation]) => {
      const normalizedMethod = typeof method === 'string' ? method.toLowerCase() : method;
      if (!httpMethods.has(normalizedMethod) || !operation || typeof operation !== 'object') {
        return;
      }

      const contextName = operation.operationId || `${normalizedMethod.toUpperCase()} ${pathKey}`;

      if (Array.isArray(operation.parameters)) {
        operation.parameters.forEach((parameter) => {
          processParameter(parameter, `${contextName} parameter`);
        });
      }

      if (operation.requestBody?.content) {
        Object.values(operation.requestBody.content).forEach((content) => {
          if (content?.schema) {
            processSchema(content.schema, contextName);
          }
        });
      }

      if (operation.responses) {
        Object.values(operation.responses).forEach((response) => {
          if (!response || typeof response !== 'object') {
            return;
          }

          if (response.content) {
            Object.values(response.content).forEach((content) => {
              if (content?.schema) {
                processSchema(content.schema, contextName);
              }
            });
          }
        });
      }
    });
  });

  Object.values(openApiSpec.components?.responses || {}).forEach((response) => {
    if (!response || typeof response !== 'object' || !response.content) {
      return;
    }

    Object.values(response.content).forEach((content) => {
      if (content?.schema) {
        processSchema(content.schema, 'ComponentResponse');
      }
    });
  });

  Object.values(openApiSpec.components?.requestBodies || {}).forEach((requestBody) => {
    if (!requestBody || typeof requestBody !== 'object' || !requestBody.content) {
      return;
    }

    Object.values(requestBody.content).forEach((content) => {
      if (content?.schema) {
        processSchema(content.schema, 'ComponentRequestBody');
      }
    });
  });

  if (hoistedCount > 0) {
    console.log(`   Hoisted ${hoistedCount} inline schema${hoistedCount === 1 ? '' : 's'} into components`);
  } else {
    console.log('   No inline schema references required hoisting');
  }
}

function shouldHoistRef(ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    return false;
  }

  if (ref.startsWith('#/$defs/')) {
    return false;
  }

  if (ref.startsWith('#/components/schemas/')) {
    const remainder = ref.slice('#/components/schemas/'.length);
    return remainder.includes('/');
  }

  if (ref.startsWith('#/components/')) {
    return false;
  }

  return true;
}

function resolveJsonPointerWithParent(root, pointer) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) {
    return null;
  }

  const segments = pointer
    .slice(2)
    .split('/')
    .map(decodePointerSegment);

  let current = root;
  let parent = null;
  let key = null;

  for (const segment of segments) {
    if (current === undefined || current === null) {
      return null;
    }

    parent = current;
    key = segment;
    current = current[segment];
  }

  if (!parent || typeof parent !== 'object') {
    return null;
  }

  return { parent, key, value: current };
}

function generateComponentName(contextName, pointer, existingNames) {
  const contextSegment = toPascalCase(contextName || '');
  const pointerSegments = extractPointerNameSegments(pointer, contextSegment);

  const segments = [...pointerSegments];
  let base = contextSegment;

  if (!base) {
    base = segments.shift() || 'Hoisted';
  }

  const suffix = segments.join('');
  let candidate = suffix ? `${base}${suffix}` : base;

  if (!candidate) {
    candidate = 'HoistedComponent';
  }

  let uniqueCandidate = candidate;
  let counter = 1;
  while (existingNames.has(uniqueCandidate)) {
    counter += 1;
    uniqueCandidate = `${candidate}${counter}`;
  }

  existingNames.add(uniqueCandidate);
  return uniqueCandidate;
}

function extractPointerNameSegments(pointer, contextSegment) {
  if (typeof pointer !== 'string' || !pointer.startsWith('#/')) {
    return [];
  }

  const rawSegments = pointer
    .slice(2)
    .split('/')
    .map(decodePointerSegment)
    .filter((segment) => segment !== '');

  if (rawSegments.length === 0) {
    return [];
  }

  let relevantSegments = rawSegments;

  if (relevantSegments[0] === 'components' && relevantSegments[1] === 'schemas') {
    relevantSegments = relevantSegments.slice(2);
  } else if (relevantSegments[0] === '$defs') {
    relevantSegments = relevantSegments.slice(1);
  } else if (relevantSegments[0] === 'paths') {
    const schemaIndex = relevantSegments.lastIndexOf('schema');
    if (schemaIndex !== -1) {
      relevantSegments = relevantSegments.slice(schemaIndex + 1);
    } else {
      relevantSegments = relevantSegments.slice(-2);
    }
  }

  if (relevantSegments[0] === 'properties') {
    relevantSegments = relevantSegments.slice(1);
  }

  const structuralSegments = new Set([
    'components',
    'schemas',
    '$defs',
    'schema',
    'content',
    'responses',
    'requestBody',
    'properties',
    'definitions',
    'pathItems',
    'allOf',
    'anyOf',
    'oneOf',
    'then',
    'else',
    'if',
  ]);

  const sanitizedSegments = relevantSegments.filter((segment) => !structuralSegments.has(segment));

  const pascalSegments = sanitizedSegments.map((segment) => toPascalCase(segment)).filter(Boolean);

  if (pascalSegments.length && contextSegment && pascalSegments[0] === contextSegment) {
    pascalSegments.shift();
  }

  if (!pascalSegments.length) {
    pascalSegments.push('Component');
  }

  return pascalSegments;
}

function decodePointerSegment(segment) {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

function toPascalCase(value) {
  if (!value) {
    return '';
  }

  const cleaned = `${value}`
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[^a-zA-Z\d]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1));

  return cleaned.join('');
}

function cloneSchema(schema) {
  if (typeof globalThis.structuredClone === 'function') {
    return globalThis.structuredClone(schema);
  }

  return JSON.parse(JSON.stringify(schema));
}

function removeODataTypeRecursively(obj) {
  if (!obj || typeof obj !== 'object') return;

  if (Array.isArray(obj)) {
    obj.forEach((item) => removeODataTypeRecursively(item));
    return;
  }

  Object.keys(obj).forEach((key) => {
    if (key === '@odata.type') {
      delete obj[key];
    } else {
      removeODataTypeRecursively(obj[key]);
    }
  });
}

function simplifyAnyOfInPaths(paths) {
  Object.entries(paths).forEach(([pathKey, pathItem]) => {
    if (!pathItem || typeof pathItem !== 'object') return;

    Object.entries(pathItem).forEach(([method, operation]) => {
      if (!operation || typeof operation !== 'object') return;

      if (operation.parameters && Array.isArray(operation.parameters)) {
        operation.parameters.forEach((param) => {
          if (param.schema && param.schema.anyOf) {
            simplifyAnyOfSchema(param.schema, `Path ${pathKey} ${method} parameter`);
          }
        });
      }

      if (operation.requestBody && operation.requestBody.content) {
        Object.entries(operation.requestBody.content).forEach(([mediaType, mediaTypeObj]) => {
          if (mediaTypeObj.schema && mediaTypeObj.schema.anyOf) {
            simplifyAnyOfSchema(
              mediaTypeObj.schema,
              `Path ${pathKey} ${method} requestBody ${mediaType}`
            );
          }
        });
      }

      if (operation.responses) {
        Object.entries(operation.responses).forEach(([statusCode, response]) => {
          if (response.content) {
            Object.entries(response.content).forEach(([mediaType, mediaTypeObj]) => {
              if (mediaTypeObj.schema && mediaTypeObj.schema.anyOf) {
                simplifyAnyOfSchema(
                  mediaTypeObj.schema,
                  `Path ${pathKey} ${method} response ${statusCode} ${mediaType}`
                );
              }
            });
          }
        });
      }
    });
  });
}

function simplifyAnyOfSchema(schema, context) {
  if (!schema.anyOf || !Array.isArray(schema.anyOf)) return;

  const anyOfItems = schema.anyOf;

  if (anyOfItems.length === 2) {
    const hasRef = anyOfItems.some((item) => item.$ref);
    const hasNullableObject = anyOfItems.some(
      (item) => item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
    );

    if (hasRef && hasNullableObject) {
      console.log(`Simplifying anyOf in ${context} (ref + nullable object pattern)`);
      const refItem = anyOfItems.find((item) => item.$ref);
      delete schema.anyOf;
      schema.$ref = refItem.$ref;
      schema.nullable = true;
    }
  } else if (anyOfItems.length > 2) {
    console.log(`Simplifying anyOf in ${context} (multiple options)`);
    schema.type = anyOfItems[0].type || 'object';
    schema.nullable = true;
    schema.description = `${schema.description || ''} [Simplified from ${
      anyOfItems.length
    } options]`.trim();
    delete schema.anyOf;
  }
}

function flattenComplexSchemasRecursively(schemas) {
  Object.entries(schemas).forEach(([schemaName, schema]) => {
    if (!schema || typeof schema !== 'object') return;

    flattenComplexSchema(schema, schemaName);

    if (schema.allOf) {
      const flattenedSchema = mergeAllOfSchemas(schema.allOf, schemas);
      Object.assign(schema, flattenedSchema);
      delete schema.allOf;
    }

    if (schema.properties && shouldReduceProperties(schema)) {
      reduceProperties(schema, schemaName);
    }

    if (schema.properties) {
      simplifyNestedPropertiesRecursively(schema.properties);
    }
  });
}

function flattenComplexSchema(schema, schemaName) {
  if (schema.anyOf && Array.isArray(schema.anyOf)) {
    if (schema.anyOf.length === 2) {
      const hasRef = schema.anyOf.some((item) => item.$ref);
      const hasNullableObject = schema.anyOf.some(
        (item) => item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
      );

      if (hasRef && hasNullableObject) {
        console.log(`Simplifying anyOf in ${schemaName} (ref + nullable object pattern)`);
        const refItem = schema.anyOf.find((item) => item.$ref);
        delete schema.anyOf;
        schema.$ref = refItem.$ref;
        schema.nullable = true;
      }
    } else if (schema.anyOf.length > 2) {
      console.log(`Simplifying anyOf in ${schemaName} (${schema.anyOf.length} options)`);
      const firstOption = schema.anyOf[0];
      schema.type = firstOption.type || 'object';
      schema.nullable = true;
      schema.description = `${schema.description || ''} [Simplified from ${
        schema.anyOf.length
      } options]`.trim();
      delete schema.anyOf;
    }
  }

  if (schema.oneOf && Array.isArray(schema.oneOf) && schema.oneOf.length > 2) {
    console.log(`Simplifying oneOf in ${schemaName} (${schema.oneOf.length} options)`);
    const firstOption = schema.oneOf[0];
    schema.type = firstOption.type || 'object';
    schema.nullable = true;
    schema.description = `${schema.description || ''} [Simplified from ${
      schema.oneOf.length
    } options]`.trim();
    delete schema.oneOf;
  }
}

function shouldReduceProperties(schema) {
  if (!schema.properties) return false;
  const propertyCount = Object.keys(schema.properties).length;
  return propertyCount > 25;
}

function reduceProperties(schema, schemaName) {
  const properties = schema.properties;
  const propertyCount = Object.keys(properties).length;

  if (propertyCount > 25) {
    console.log(`Reducing properties in ${schemaName} (${propertyCount} -> 25)`);

    const priorityProperties = [
      'id',
      'name',
      'displayName',
      'description',
      'createdDateTime',
      'lastModifiedDateTime',
      'status',
      'state',
      'type',
      'value',
      'email',
      'userPrincipalName',
      'title',
      'content',
      'body',
      'subject',
      'message',
      'attachments',
      'error',
      'code',
      'details',
      'url',
      'href',
      'path',
      'method',
      'enabled',
    ];

    const keptProperties = {};
    const propertyKeys = Object.keys(properties);

    priorityProperties.forEach((key) => {
      if (properties[key]) {
        keptProperties[key] = properties[key];
      }
    });

    const remainingSlots = 25 - Object.keys(keptProperties).length;
    const otherKeys = propertyKeys.filter((key) => !keptProperties[key]);

    otherKeys.slice(0, remainingSlots).forEach((key) => {
      keptProperties[key] = properties[key];
    });

    schema.properties = keptProperties;
    schema.additionalProperties = true;
    schema.description = `${
      schema.description || ''
    } [Note: Simplified from ${propertyCount} properties to 25 most common ones]`.trim();
  }
}

function mergeAllOfSchemas(allOfArray, allSchemas) {
  const merged = {
    type: 'object',
    properties: {},
  };

  allOfArray.forEach((item) => {
    if (item.$ref) {
      const refSchemaName = item.$ref.replace('#/components/schemas/', '');
      const refSchema = allSchemas[refSchemaName];
      if (refSchema) {
        console.log(
          `Processing ref ${refSchemaName} for ${item.title}, exists: true, has properties: ${!!refSchema.properties}`
        );
        if (refSchema.properties) {
          console.log(`Ensuring ${item.title} has all required properties from ${refSchemaName}`);
          Object.assign(merged.properties, refSchema.properties);
        }
        if (refSchema.required) {
          merged.required = [...(merged.required || []), ...refSchema.required];
        }
        if (refSchema.description && !merged.description) {
          merged.description = refSchema.description;
        }
      }
    } else if (item.properties) {
      Object.assign(merged.properties, item.properties);
      if (item.required) {
        merged.required = [...(merged.required || []), ...item.required];
      }
    }
  });

  if (merged.required) {
    merged.required = [...new Set(merged.required)];
  }

  return merged;
}

function simplifyNestedPropertiesRecursively(properties, currentDepth = 0, maxDepth = 3) {
  if (!properties || typeof properties !== 'object' || currentDepth >= maxDepth) {
    return;
  }

  Object.keys(properties).forEach((key) => {
    const prop = properties[key];

    if (prop && typeof prop === 'object') {
      if (currentDepth === maxDepth - 1 && prop.properties) {
        console.log(`Flattening nested property at depth ${currentDepth}: ${key}`);
        prop.type = 'object';
        prop.description = `${prop.description || ''} [Simplified: nested object]`.trim();
        delete prop.properties;
        delete prop.additionalProperties;
      } else if (prop.properties) {
        simplifyNestedPropertiesRecursively(prop.properties, currentDepth + 1, maxDepth);
      }

      if (prop.anyOf && Array.isArray(prop.anyOf)) {
        if (prop.anyOf.length === 2) {
          const hasRef = prop.anyOf.some((item) => item.$ref);
          const hasNullableObject = prop.anyOf.some(
            (item) =>
              item.type === 'object' && item.nullable === true && Object.keys(item).length <= 2
          );

          if (hasRef && hasNullableObject) {
            console.log(`Simplifying anyOf in property ${key} (ref + nullable object pattern)`);
            const refItem = prop.anyOf.find((item) => item.$ref);
            delete prop.anyOf;
            prop.$ref = refItem.$ref;
            prop.nullable = true;
          }
        } else if (prop.anyOf.length > 2) {
          prop.type = prop.anyOf[0].type || 'object';
          prop.nullable = true;
          prop.description =
            `${prop.description || ''} [Simplified from ${prop.anyOf.length} options]`.trim();
          delete prop.anyOf;
        }
      }

      if (prop.oneOf && Array.isArray(prop.oneOf) && prop.oneOf.length > 2) {
        prop.type = prop.oneOf[0].type || 'object';
        prop.nullable = true;
        prop.description =
          `${prop.description || ''} [Simplified from ${prop.oneOf.length} options]`.trim();
        delete prop.oneOf;
      }
    }
  });
}

function findUsedSchemas(openApiSpec) {
  const usedSchemas = new Set();
  const schemasToProcess = [];
  const schemas = openApiSpec.components?.schemas || {};
  const responses = openApiSpec.components?.responses || {};
  const requestBodies = openApiSpec.components?.requestBodies || {};
  const parameters = openApiSpec.components?.parameters || {};
  const paths = openApiSpec.paths || {};

  const enqueueSchemaRef = (ref) => {
    if (typeof ref !== 'string' || !ref.startsWith('#/components/schemas/')) {
      return;
    }
    const schemaName = ref.replace('#/components/schemas/', '');
    if (schemaName) {
      schemasToProcess.push(schemaName);
    }
  };

  const processSchemaRefs = (schema) => {
    if (!schema || typeof schema !== 'object') return;
    findRefsInObject(schema, enqueueSchemaRef);
  };

  const visitedResponses = new Set();
  const processResponse = (response) => {
    if (!response || typeof response !== 'object') return;

    if (response.$ref) {
      const responseName = response.$ref.replace('#/components/responses/', '');
      if (!visitedResponses.has(responseName) && responses[responseName]) {
        visitedResponses.add(responseName);
        processResponse(responses[responseName]);
      }
      return;
    }

    if (response.content) {
      Object.values(response.content).forEach((content) => {
        if (content?.schema) {
          processSchemaRefs(content.schema);
        }
      });
    }
  };

  const visitedRequestBodies = new Set();
  const processRequestBody = (requestBody) => {
    if (!requestBody || typeof requestBody !== 'object') return;

    if (requestBody.$ref) {
      const requestBodyName = requestBody.$ref.replace('#/components/requestBodies/', '');
      if (!visitedRequestBodies.has(requestBodyName) && requestBodies[requestBodyName]) {
        visitedRequestBodies.add(requestBodyName);
        processRequestBody(requestBodies[requestBodyName]);
      }
      return;
    }

    if (requestBody.content) {
      Object.values(requestBody.content).forEach((content) => {
        if (content?.schema) {
          processSchemaRefs(content.schema);
        }
      });
    }
  };

  const visitedParameters = new Set();
  const processParameter = (parameter) => {
    if (!parameter || typeof parameter !== 'object') return;

    if (parameter.$ref) {
      const parameterName = parameter.$ref.replace('#/components/parameters/', '');
      if (!visitedParameters.has(parameterName) && parameters[parameterName]) {
        visitedParameters.add(parameterName);
        processParameter(parameters[parameterName]);
      }
      return;
    }

    if (parameter.schema) {
      processSchemaRefs(parameter.schema);
    }

    if (parameter.content) {
      Object.values(parameter.content).forEach((content) => {
        if (content?.schema) {
          processSchemaRefs(content.schema);
        }
      });
    }
  };

  Object.values(paths).forEach((pathItem) => {
    if (!pathItem || typeof pathItem !== 'object') return;

    Object.entries(pathItem).forEach(([key, operation]) => {
      if (key === 'parameters' && Array.isArray(operation)) {
        operation.forEach((param) => processParameter(param));
        return;
      }

      if (typeof operation !== 'object') return;

      if (operation.requestBody) {
        processRequestBody(operation.requestBody);
      }

      if (operation.responses) {
        Object.values(operation.responses).forEach((response) => {
          processResponse(response);
        });
      }

      if (operation.parameters) {
        operation.parameters.forEach((param) => {
          processParameter(param);
        });
      }
    });
  });

  const visited = new Set();

  function processSchema(schemaName) {
    if (visited.has(schemaName)) return;
    visited.add(schemaName);

    const schema = schemas[schemaName];
    if (!schema) {
      console.log(`⚠️  Warning: Schema ${schemaName} not found`);
      return;
    }

    usedSchemas.add(schemaName);

    findRefsInObject(schema, (ref) => {
      const refSchemaName = ref.replace('#/components/schemas/', '');
      if (schemas[refSchemaName]) {
        processSchema(refSchemaName);
      } else {
        console.log(`⚠️  Schema ${schemaName} references missing schema: ${refSchemaName}`);
      }
    });
  }

  schemasToProcess.forEach((schemaName) => processSchema(schemaName));

  [
    'microsoft.graph.ODataErrors.ODataError',
    'microsoft.graph.ODataErrors.MainError',
    'microsoft.graph.ODataErrors.ErrorDetails',
    'microsoft.graph.ODataErrors.InnerError',
  ].forEach((errorSchema) => {
    if (schemas[errorSchema]) {
      processSchema(errorSchema);
    }
  });

  console.log(
    `   Found ${usedSchemas.size} used schemas out of ${Object.keys(schemas).length} total schemas`
  );

  return usedSchemas;
}

function findRefsInObject(obj, callback, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
  visited.add(obj);

  if (Array.isArray(obj)) {
    obj.forEach((item) => findRefsInObject(item, callback, visited));
    return;
  }

  Object.entries(obj).forEach(([key, value]) => {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      callback(value);
    } else if (typeof value === 'object') {
      findRefsInObject(value, callback, visited);
    }
  });
}

function cleanBrokenRefs(obj, availableSchemas, visited = new Set()) {
  if (!obj || typeof obj !== 'object' || visited.has(obj)) return;
  visited.add(obj);

  if (Array.isArray(obj)) {
    for (let i = obj.length - 1; i >= 0; i--) {
      const item = obj[i];
      if (item && typeof item === 'object' && item.$ref) {
        const refSchemaName = item.$ref.replace('#/components/schemas/', '');
        if (!availableSchemas[refSchemaName]) {
          console.log(`   Removing broken reference: ${refSchemaName}`);
          obj.splice(i, 1);
        }
      } else if (typeof item === 'object') {
        cleanBrokenRefs(item, availableSchemas, visited);
      }
    }
    return;
  }

  Object.entries(obj).forEach(([key, value]) => {
    if (key === '$ref' && typeof value === 'string' && value.startsWith('#/components/schemas/')) {
      const refSchemaName = value.replace('#/components/schemas/', '');
      if (!availableSchemas[refSchemaName]) {
        console.log(`   Removing broken $ref: ${refSchemaName}`);
        delete obj[key];
        if (Object.keys(obj).length === 0) {
          obj.type = 'object';
        }
      }
    } else if (typeof value === 'object') {
      cleanBrokenRefs(value, availableSchemas, visited);
    }
  });
}

function pruneUnusedSchemas(openApiSpec, usedSchemas) {
  const schemas = openApiSpec.components?.schemas || {};
  const originalCount = Object.keys(schemas).length;

  Object.keys(schemas).forEach((schemaName) => {
    if (!usedSchemas.has(schemaName)) {
      delete schemas[schemaName];
    }
  });

  Object.values(schemas).forEach((schema) => {
    if (schema) {
      cleanBrokenRefs(schema, schemas);
    }
  });

  if (openApiSpec.components?.responses) {
    Object.values(openApiSpec.components.responses).forEach((response) => {
      if (response) {
        cleanBrokenRefs(response, schemas);
      }
    });
  }

  if (openApiSpec.paths) {
    Object.values(openApiSpec.paths).forEach((pathItem) => {
      if (pathItem) {
        cleanBrokenRefs(pathItem, schemas);
      }
    });
  }

  const newCount = Object.keys(schemas).length;
  const reduction = (((originalCount - newCount) / originalCount) * 100).toFixed(1);

  console.log(`   Removed ${originalCount - newCount} unused schemas (${reduction}% reduction)`);
  console.log(`   Final schema count: ${newCount} (from ${originalCount})`);

  if (openApiSpec.components?.responses) {
    const usedResponses = new Set();

    Object.values(openApiSpec.paths || {}).forEach((pathItem) => {
      Object.values(pathItem).forEach((operation) => {
        if (operation.responses) {
          Object.values(operation.responses).forEach((response) => {
            if (response.$ref) {
              const responseName = response.$ref.replace('#/components/responses/', '');
              usedResponses.add(responseName);
            }
          });
        }
      });
    });

    usedResponses.add('error');

    const responses = openApiSpec.components.responses;
    const originalResponseCount = Object.keys(responses).length;

    Object.keys(responses).forEach((responseName) => {
      if (!usedResponses.has(responseName)) {
        delete responses[responseName];
      }
    });

    const newResponseCount = Object.keys(responses).length;
    console.log(
      `   Removed ${originalResponseCount - newResponseCount} unused responses (from ${originalResponseCount} to ${newResponseCount})`
    );
  }

  if (openApiSpec.components?.requestBodies) {
    const usedRequestBodies = new Set();

    Object.values(openApiSpec.paths || {}).forEach((pathItem) => {
      Object.values(pathItem).forEach((operation) => {
        if (operation.requestBody?.$ref) {
          const requestBodyName = operation.requestBody.$ref.replace(
            '#/components/requestBodies/',
            ''
          );
          usedRequestBodies.add(requestBodyName);
        }
      });
    });

    const requestBodies = openApiSpec.components.requestBodies;
    const originalRequestBodyCount = Object.keys(requestBodies).length;

    Object.keys(requestBodies).forEach((requestBodyName) => {
      if (!usedRequestBodies.has(requestBodyName)) {
        delete requestBodies[requestBodyName];
      }
    });

    const newRequestBodyCount = Object.keys(requestBodies).length;
    console.log(
      `   Removed ${originalRequestBodyCount - newRequestBodyCount} unused request bodies (from ${originalRequestBodyCount} to ${newRequestBodyCount})`
    );
  }
}
