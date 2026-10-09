// Generate the list of Source (Input) types that support Event Breaker rulesets.
//
// WHY: the Source Bulk Editor may only edit `breakerRulesets` on Sources whose type
// actually declares that field — PATCHing it onto an unsupported type is rejected (or
// silently dropped) by the Cribl API. Rather than hardcode a guessed list, we derive it
// from the bundled OpenAPI spec: `components.schemas.Input.discriminator.mapping` is the
// authoritative map of a Source's `type` value -> its concrete Input* schema, and a type
// is eligible exactly when that schema declares a `breakerRulesets` property.
//
// `staleChannelFlushMs` (the Event Breaker buffer timeout) is emitted as a separate list
// because it is a distinct field; today the two sets are identical, but deriving both
// keeps that an observation rather than an assumption.
//
// USAGE (from the project root):
//   npm run breakers:gen
//
// Re-run this whenever openapi.json is refreshed, then commit the regenerated file.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const specPath = join(root, 'openapi.json');
const outPath = join(root, 'src', 'lib', 'breakerCapableTypes.ts');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

const spec = JSON.parse(await readFile(specPath, 'utf-8')).components?.schemas;
if (!spec) fail(`Could not read components.schemas from ${specPath}`);

const mapping = spec.Input?.discriminator?.mapping;
if (!mapping) fail('openapi.json has no components.schemas.Input.discriminator.mapping');

const breaker = [];
const stale = [];
for (const [typeValue, ref] of Object.entries(mapping)) {
  const schema = spec[ref.split('/').pop()];
  const props = schema?.properties ?? {};
  if ('breakerRulesets' in props) breaker.push(typeValue);
  if ('staleChannelFlushMs' in props) stale.push(typeValue);
}
breaker.sort();
stale.sort();

if (breaker.length === 0) fail('No Input types declare breakerRulesets — spec shape changed?');

const list = (values) => values.map((v) => `  '${v}',`).join('\n');

const file = `// GENERATED FILE — do not edit by hand.
// Run \`npm run breakers:gen\` to regenerate from openapi.json.
//
// Source (Input) types that support Event Breaker configuration, derived from the
// OpenAPI spec's Input discriminator mapping (see scripts/gen-breaker-types.mjs).
// Of the ${Object.keys(mapping).length} Source types in the spec, ${breaker.length} declare \`breakerRulesets\`.

/** Source \`type\` values whose schema declares \`breakerRulesets\`. */
export const BREAKER_CAPABLE_TYPES: readonly string[] = [
${list(breaker)}
];

/** Source \`type\` values whose schema declares \`staleChannelFlushMs\`. */
export const STALE_FLUSH_CAPABLE_TYPES: readonly string[] = [
${list(stale)}
];
`;

await writeFile(outPath, file, 'utf-8');
console.log(
  `✔ Wrote ${outPath}\n  ${breaker.length} breaker-capable / ${stale.length} staleChannelFlushMs-capable of ${Object.keys(mapping).length} Source types.`,
);
