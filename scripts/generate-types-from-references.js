const { promises: fs } = require('fs');
const path = require('path');
const references = require('./references.json');

const generatedRoot = path.join(__dirname, '../src/generated');

function formatType(types) {
  return types
    .map((type) => {
      switch (type.type) {
        case 'string': {
          if (type.startsWith) {
            return '`' + type.startsWith + '${string}`';
          }
          if (type.possibleValues) {
            return type.possibleValues.map(value => `'${value}'`).join(' | ');
          }
          return 'string';
        }
        case 'object': {
          if (type.fields) {
            return '{ ' + type.fields
              .map((field) => `${field.name}: ${formatType(field.type)}`)
              .join('; ') + ' }';
          }
          if (type.id) {
            const reference = references.find(reference => reference.id === type.id);
            if (reference) {
              return 'Partial<' + reference.name + '>';
            }
          }
          return 'object';
        }
        case 'number':
        case 'boolean': {
          return type.type;
        }
        case 'array': {
          if (type.arrayTypes) {
            return `(${formatType(type.arrayTypes)})[]`;
          }
          return 'any[]';
        }
        default: {
          if (Array.isArray(type)) {
            return formatType(type);
          }
          // console.log('unknown type', type);
          return 'unknown';
        }
      }
    })
    .join(' | ');
}

function getDescription(description) {
  return (
    '  /**\n' +
    '   * ' + description.replace(/\\\*/g, '-').split('\n').join('\n   * ') + '\n' +
    '   */\n'
  );
}

function getExternalIds(types) {
  const ids = [];
  function next(type) {
    if (type.id) {
      ids.push(type.id);
    }
    if (type.type === 'array' && type.arrayTypes) {
      type.arrayTypes.forEach(next);
    }
  }
  types.forEach(next);
  return ids;
}

function getReferencePath(reference) {
  return path.join(generatedRoot, reference.product, reference.type + 's', reference.name + '.ts');
}

async function writeReference(reference, contents) {
  const referencePath = getReferencePath(reference);
  await fs.mkdir(path.dirname(referencePath), { recursive: true });
  await fs.writeFile(referencePath, contents);
}

function formatInterface(reference, isExport) {
  let contents = '';
  let imports = [];

  for (const field of reference.fields) {
    const externalIds = getExternalIds(field.type);
    if (externalIds.length) {
      const selfReferencePath = getReferencePath(reference);
      imports.push(...externalIds.map((id) => {
        const externalReference = references.find(reference => reference.id === id);
        if (!externalReference) {
          return;
        }
        const externalReferencePath = getReferencePath(externalReference);
        let importPath = path.relative(path.dirname(selfReferencePath), externalReferencePath).replace('.ts', '');
        if (!importPath.startsWith('.')) {
          importPath = './' + importPath;
        }
        return `import { ${externalReference.name} } from '${importPath}';`;
      }));
    }
  }

  if (imports.length) {
    contents += imports
      .filter(Boolean)
      .filter((_import, index, imports) => {
        return imports.indexOf(_import) === index;
      })
      .join('\n');
    contents += '\n\n';
  }

  if (isExport) {
    contents += 'export ';
  }
  contents += `interface ${reference.name} {\n`;

  const uniqueFields = {};
  for (const field of reference.fields) {
    if (uniqueFields[field.name]) {
      const existing = uniqueFields[field.name];
      uniqueFields[field.name] = {
        description: existing.description + '\n' + field.description,
        type: [existing.type, field.type],
        name: field.name,
        required: existing.required && field.required,
      };
    } else {
      uniqueFields[field.name] = field;
    }
  }

  for (const field of Object.values(uniqueFields)) {
  // for (const field of reference.fields) {
    if (field.description) {
      contents += getDescription(field.description);
    }
    contents += `  ${field.name}${field.required ? '' : '?'}: ${formatType(field.type)};\n`;
  }
  contents += '};\n';

  return contents;
}

async function generateType(reference) {
  const file = formatInterface(reference, true);
  await writeReference(reference, file);
}

function formatEnum(reference, isExport) {
  let contents = '';
  if (isExport) {
    contents += 'export ';
  }
  contents += `enum ${reference.name} {\n`;
  for (const field of reference.values) {
    if (field.description) {
      contents += getDescription(field.description);
    }
    contents += `  ${field.name} = '${field.name}',\n`;
  }
  contents += '};\n';
  return contents;
}

async function generateEnum(reference) {
  const file = formatEnum(reference, true);
  await writeReference(reference, file);
}

async function generateRequest(reference) {
  const file = formatInterface({
    product: reference.product,
    parent: reference.parent,
    name: reference.name,
    fields: [
      ...reference.params,
      ...reference.body,
      ...reference.query,
      ...reference.headers,
    ],
  }, true);
  await writeReference(reference, file);
}

async function generateAPI(type, requests, error) {
  let file = '';

  file += `import { RapydClient } from '../../../core/RapydClient';\n`
  file += `import { ${type.name} } from '../types/${type.name}';\n`;

  if (error) {
    file += `import { ${error.name} } from '../enums/${error.name}';\n`;
  }

  for (const request of requests) {
    file += `import { ${request.name} } from '../requests/${request.name}';\n`;
  }

  file += '\n';

  for (const request of requests) {
    let functionName = request.name.replace(/Request$/, '');
    functionName = functionName[0].toLowerCase() + functionName.substring(1);

    const pathParams = [];
    const path = request.path.replace(/\{(\w+)\}/g, (_, param) => {
      pathParams.push(param);
      return '{}';
    });

    file += `export async function ${functionName}<R = ${type.name}>(client: RapydClient, request: ${request.name}): Promise<R> {\n`;

    if (request.query.length) {
      const hasMany = request.query.length > 1;
      file += '  const queryParams = client.queryParams({';
      for (const query of request.query) {
        if (hasMany) {
          file += `\n    ${query.name}: request.${query.name},`;
        } else {
          file += ` ${query.name}: request.${query.name} `;
        }
      }
      if (hasMany) {
        file += '\n  ';
      }
      file += '});\n';
    }

    file += `  const response = await client.${request.method.toLowerCase()}('${path}'`;

    if (request.query.length) {
      file += ' + queryParams';
    }

    if (pathParams.length) {
      file += ', ';
      file += `${pathParams.map(param => `request.${param}`).join(', ')}`;
    }

    if (request.body.length) {
      file += `, {\n`;
      for (const param of request.body) {
        file += `    ${param.name}: request.${param.name},\n`;
      }
      file += `  }`;
    }

    file += `);\n`;
    file += `  return await response.data<R, ${error ? error.name : 'Error'}>();\n`;
    file += '}\n\n';
  }

  await fs.mkdir(path.join(generatedRoot, type.product, 'apis'), { recursive: true });
  await fs.writeFile(path.join(generatedRoot, type.product, 'apis', type.name + '.ts'), file);
}

Promise.all(references.map(async (reference) => {
  switch (reference.type) {
    case 'type': {
      await generateType(reference);

      const children = references.filter(child => child.parent === reference.id);
      if (children.length) {
        const methods = children.filter(child => child.type === 'request');
        const error = children.find(child => child.type === 'enum');
        await generateAPI(reference, methods, error);
      }
      break;
    }
    case 'enum': {
      await generateEnum(reference);
      break;
    }
    case 'request': {
      await generateRequest(reference);
      break;
    }
  }
}));
