// GENERATED FILE — do not edit by hand.
// Run `npm run breakers:gen` to regenerate from openapi.json.
//
// Source (Input) types that support Event Breaker configuration, derived from the
// OpenAPI spec's Input discriminator mapping (see scripts/gen-breaker-types.mjs).
// Of the 71 Source types in the spec, 21 declare `breakerRulesets`.

/** Source `type` values whose schema declares `breakerRulesets`. */
export const BREAKER_CAPABLE_TYPES: readonly string[] = [
  'appscope',
  'azure_blob',
  'bedrock_s3',
  'cloudflare_hec',
  'collection',
  'crowdstrike',
  'exec',
  'file',
  'http_raw',
  'kube_logs',
  'microsoft_graph',
  'openai_compliance_logs',
  's3',
  's3_inventory',
  'security_lake',
  'splunk',
  'splunk_hec',
  'splunk_search',
  'tcp',
  'wiz',
  'wiz_webhook',
];

/** Source `type` values whose schema declares `staleChannelFlushMs`. */
export const STALE_FLUSH_CAPABLE_TYPES: readonly string[] = [
  'appscope',
  'azure_blob',
  'bedrock_s3',
  'cloudflare_hec',
  'collection',
  'crowdstrike',
  'exec',
  'file',
  'http_raw',
  'kube_logs',
  'microsoft_graph',
  'openai_compliance_logs',
  's3',
  's3_inventory',
  'security_lake',
  'splunk',
  'splunk_hec',
  'splunk_search',
  'tcp',
  'wiz',
  'wiz_webhook',
];
