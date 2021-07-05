const { promises: fs } = require('fs');
const fetch = require('node-fetch');
const cheerio = require('cheerio');
const products = require('./reference-urls.json');
const fixes = require('./reference-fixes.json');

const references = [];

function addErrors(product, reference, parent) {
  const errors = [];

  for (const [_, name, description] of reference.body.matchAll(/\*\*(\w+)\*\*\n(.*)\n/g)) {
    errors.push({ name, description });
  }

  references.push({
    product,
    parent,
    id: reference.slug,
    type: 'enum',
    name: reference.title.replace(/(\s|Errors$)/g, '') + 'Error',
    values: errors,
    ...fixes[reference.slug],
  });
}

const typeAliases = {
  'float': 'number',
  'Boolean': 'boolean',
  'int': 'number',
  'integer': 'number',
};

function findType(types, ofType) {
  const exactMatch = types.find(type => type.type === ofType);

  if (exactMatch) {
    return exactMatch;
  }

  const arrayType = types.find(type => type.type === 'array');
  if (arrayType && arrayType.arrayTypes) {
    return findType(arrayType.arrayTypes, ofType);
  }
}

function getTypes(rawType, description) {
  const types = [];

  if (rawType.includes('array of') || rawType.includes('list of')) {
    const typeName = rawType.split(' ').pop().replace(/s$/, '');
    types.push({
      type: 'array',
      arrayTypes: [{
        type: typeAliases[typeName] || typeName,
      }],
    });
  } else if (rawType.includes(' or ')) {
    types.push(...rawType.split(' or ').map((typeName) => ({
      type: typeAliases[typeName] || typeName,
    })));
  } else if (rawType === 'array_string') {
    types.push({
      type: 'array',
      arrayTypes: [{
        type: 'string',
      }],
    });
  } else if (rawType === 'array_object') {
    types.push({
      type: 'array',
      arrayTypes: [{
        type: 'object',
      }],
    });
  } else {
    types.push({
      type: typeAliases[rawType] || rawType,
    });
  }

  const stringType = findType(types, 'string');
  const objectType = findType(types, 'object');

  const startsWithMatch = description.match(/starting with \*\*(\w+)\*\*/);
  if (stringType && startsWithMatch) {
    const [_, prefix] = startsWithMatch;
    stringType.startsWith = prefix;
  }

  if (stringType && (description.includes('of the following') || description.includes('ossible values'))) {
    const possibleValues = [];
    const lines = description.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\\\*|\*|\-)\s*\*\*((\w|\s)+)\*\*/);
      if (match) {
        const [_, _a, value] = match;
        possibleValues.push(value.trim());
      }
    }
    if (possibleValues.length) {
      stringType.possibleValues = possibleValues;
    }
  }

  if (objectType && description.includes('the following fields')) {
    const fields = [];
    const lines = description.split('\n');
    for (const line of lines) {
      const match = line.match(/^(\\\*|\*|\-)\s*\`((\w|\s)+)\`/);
      if (match) {
        const [_, _a, value] = match;
        fields.push({
          name: value.trim(),
          type: [{ type: 'unknown' }],
        });
      }
    }
    if (fields.length) {
      objectType.fields = fields;
    }
  }

  const objectRefMatch = description.match(/see \[((\w|\s)+)\]\(ref\:((\w|-)+)\)/i);
  if (objectType && objectRefMatch) {
    const [_, _a, _b, ref] = objectRefMatch;
    objectType.id = ref;
  }

  // if (objectType && description.toLowerCase().includes('array of objects')) {
  //   const objectTypeClone = { ...objectType };

  //   delete objectType.id;
  //   delete objectType.fields;

  //   objectType.type = 'array';
  //   objectType.arrayTypes = [objectTypeClone];
  // }

  return types;
}

const typeTableColumns = [
  'name',
  'type',
  'description',
];

function getTypeTable({ data, rows }) {
  const table = new Array(rows);

  for (const [location, value] of Object.entries(data)) {
    const [row, col] = location.split('-', 2);

    if (row === 'h') {
      continue; // Ignore header row
    }

    if (!table[+row]) {
      table[+row] = {};
    }

    table[+row][typeTableColumns[col]] = value;
  }

  for (const row of table) {
    row.name = row.name.replace(/\`/g, '');
    row.type = getTypes(row.type, row.description);
    row.required = true;
  }

  return table;
}

const parametersBlockRegex = /\[block:parameters\]((.|\n|\s)*?)\[\/block\]/g;

function addType(product, reference) {
  for (const [_, json] of reference.body.matchAll(parametersBlockRegex)) {
    const table = getTypeTable(JSON.parse(json));

    references.push({
      product,
      id: reference.slug,
      type: 'type',
      name: reference.title.replace(/(\s|Object$)/g, ''),
      description: reference.excerpt || '',
      fields: table,
      ...fixes[reference.slug],
    });
    break;
  }
}

function getParamsIn(reference, type) {
  return reference.api.params
    .filter(param => param.in === type)
    .map((param) => ({
      name: param.name,
      type: getTypes(param.type, param.desc),
      required: param.required,
      description: param.desc,
    }));
}

const excludeHeaders = [
  'access_key',
  'salt',
  'signature',
  'timestamp',
  'idempotency',
  'content-type',
  'content_type',
];

function addRequest(product, reference, parent) {
  const queryIndex = reference.api.url.indexOf('?');
  const path = queryIndex !== -1
    ? reference.api.url.substring(0, queryIndex)
    : reference.api.url;

  references.push({
    product,
    parent,
    id: reference.slug,
    type: 'request',
    name: reference.title
      .split(/\s/g)
      .map(segment => segment[0].toUpperCase() + segment.substring(1))
      .join(' ')
      .replace(/(\s|\-)/g, '') +
        'Request',
    description: reference.excerpt,
    method: reference.api.method.toUpperCase(),
    path: path.replace(/\:(\w+)/g, '{$1}'), // Some paths use the `:param` syntax and some use `{param}`
    params: getParamsIn(reference, 'path')
      .map(param => ({ ...param, required: true })), // Params are marked as not required... but that's not possible.
    body: getParamsIn(reference, 'body'),
    headers: getParamsIn(reference, 'header')
      .filter(header => !excludeHeaders.includes(header.name.toLowerCase())),
    query: getParamsIn(reference, 'query'),
    ...fixes[reference.slug],
  });
}

function handleReference(product, reference, parent) {
  reference.title = reference.title.replace(/ - (Collect|Disburse|Wallet|Issuing)/g, '');

  switch (reference.type) {
    case 'basic': {
      if (reference.title.includes('Sequence')) {
        // Ignore
      } else if (reference.title.endsWith('Object')) {
        addType(product.id, reference);
        if (reference.children) {
          for (const child of reference.children) {
            handleReference(product, child, reference);
          }
        }
      } else if (reference.title.endsWith('Errors')) {
        if (parent) {
          addErrors(product.id, reference, parent.slug);
        }
      } else if (reference.title.startsWith('Webhook')) {
        // TODO
      } else {
        console.warn(`Unknown reference type of "basic" with title "${reference.title}".`);
      }
      break;
    }
    case 'endpoint': {
      if (parent) {
        addRequest(product.id, reference, parent.slug);
      }
      break;
    }
    default: {
      console.warn(`Unknown reference type of "${reference.type}" with title "${reference.title}".`);
      break;
    }
  }
}

Promise.all(
  products.map((product) => Promise.all(product.urls.map(async (url) => {
    const response = await fetch(url);
    const html = await response.text();
    const $ = cheerio.load(html);

    const docs = $('#readme-data-docs').data('json');

    for (const reference of docs) {
      handleReference(product, reference);
    }
  })))
).then(async () => {
  await fs.writeFile(__dirname + '/references.json', JSON.stringify(references, null, '  '));
});
