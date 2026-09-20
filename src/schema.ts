/** Deliberately bounded JSON Schema subset. Unsupported keywords fail at creation. */
export interface Schema {
  type: 'object' | 'array' | 'string' | 'number' | 'integer' | 'boolean' | 'null';
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: false;
  items?: Schema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  nullable?: boolean;
}
export interface Contract {
  version: 1;
  progress: Schema;
  record: Schema;
  result: Schema;
}
const keywords = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
  'nullable',
]);
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);
function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function schemaChildren(s: Schema, depth: number): void {
  if (s.type === 'object') {
    requireCondition(
      s.properties && s.additionalProperties === false,
      'Objects require properties and additionalProperties:false',
    );
    requireCondition(
      Array.isArray(s.required) && s.required.every((k) => Object.hasOwn(s.properties!, k)),
      'Invalid required fields',
    );
    Object.values(s.properties).forEach((child) => checkSchema(child, depth + 1));
  }
  if (s.type === 'array') {
    requireCondition(s.items, 'Arrays require items');
    checkSchema(s.items, depth + 1);
  }
}
export function checkSchema(s: Schema, depth = 0): void {
  requireCondition(
    s && typeof s === 'object' && !Array.isArray(s) && depth < 12,
    'Invalid or too deeply nested schema',
  );
  requireCondition(types.has(s.type), 'Unsupported schema type');
  requireCondition(
    Object.keys(s).every((k) => keywords.has(k)),
    'Unsupported schema keyword',
  );
  for (const k of ['minimum', 'maximum', 'minLength', 'maxLength', 'maxItems'] as const) {
    requireCondition(
      s[k] === undefined || (typeof s[k] === 'number' && Number.isFinite(s[k])),
      `Invalid ${k}`,
    );
  }
  requireCondition(s.enum === undefined || Array.isArray(s.enum), 'Invalid enum');
  requireCondition(s.nullable === undefined || typeof s.nullable === 'boolean', 'Invalid nullable');
  schemaChildren(s, depth);
}
export function contract(value: unknown): Contract {
  const c = value as Contract;
  requireCondition(
    c && c.version === 1 && Object.keys(c).sort().join(',') === 'progress,record,result,version',
    'Invalid reporting contract',
  );
  [c.progress, c.record, c.result].forEach((s) => checkSchema(s));
  requireCondition(
    c.record.type === 'object' &&
      c.record.properties?.id?.type === 'string' &&
      c.record.required?.includes('id'),
    'Record schema requires a string id',
  );
  return c;
}
function matchesType(s: Schema, value: unknown): boolean {
  if (value === null) return s.type === 'null' || s.nullable === true;
  if (s.type === 'array') return Array.isArray(value);
  if (s.type === 'integer') return Number.isSafeInteger(value);
  if (s.type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (s.type === 'object') return typeof value === 'object' && !Array.isArray(value);
  return typeof value === s.type;
}
function validateObject(s: Schema, value: Record<string, unknown>, at: string): void {
  for (const k of s.required ?? [])
    requireCondition(Object.hasOwn(value, k), `${at}.${k} required`);
  for (const [k, v] of Object.entries(value)) {
    requireCondition(Object.hasOwn(s.properties!, k), `${at}.${k} not allowed`);
    validate(s.properties![k], v, `${at}.${k}`);
  }
}
function validateBounds(s: Schema, value: unknown, at: string): void {
  if (typeof value === 'number') {
    requireCondition(
      value >= (s.minimum ?? -Infinity) && value <= (s.maximum ?? Infinity),
      `${at} outside numeric bounds`,
    );
  }
  if (typeof value === 'string') {
    requireCondition(
      value.length >= (s.minLength ?? 0) && value.length <= (s.maxLength ?? 10000),
      `${at} outside length bounds`,
    );
  }
}
export function validate(s: Schema, value: unknown, at = '$'): void {
  requireCondition(matchesType(s, value), `${at} expected ${s.type}`);
  if (s.enum)
    requireCondition(
      s.enum.some((v) => JSON.stringify(v) === JSON.stringify(value)),
      `${at} invalid enum`,
    );
  if (value === null) return;
  validateBounds(s, value, at);
  if (s.type === 'object') validateObject(s, value as Record<string, unknown>, at);
  if (Array.isArray(value)) {
    requireCondition(value.length <= (s.maxItems ?? 250), `${at} too many items`);
    value.forEach((v, i) => validate(s.items!, v, `${at}[${i}]`));
  }
}
