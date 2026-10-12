import { z } from 'zod';

/**
 * Convert a Zod schema into a JSON Schema both providers accept:
 *  - Gemini `responseJsonSchema`
 *  - Groq `response_format.json_schema` with `strict: true`, which requires every object to have
 *    `additionalProperties: false` and list *all* of its keys in `required`.
 */
export function toStrictJsonSchema(zodSchema) {
  const json = z.toJSONSchema(zodSchema, { target: 'draft-7', io: 'output' });
  delete json.$schema;
  return tighten(json);
}

function tighten(node) {
  if (Array.isArray(node)) return node.map(tighten);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) out[k] = tighten(v);
  if (out.type === 'object' && out.properties) {
    out.additionalProperties = false;
    out.required = Object.keys(out.properties);
  }
  return out;
}
