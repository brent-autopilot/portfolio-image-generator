/**
 * LegNext renders an unversioned prompt as v7.
 * v8.2 is the newest model they accept. Image --sref, --sw, and --profile
 * are supported on v8.2; --sv is not in their image-parameter schema.
 * https://docs.legnext.ai/getting-started/models
 * https://docs.legnext.ai/schemas/mj-image-params.v1.json
 */
export const MJ_VERSION = '8.2';

export function withMidjourneyVersion(prompt, version = MJ_VERSION) {
  const text = (prompt || '').trim();
  if (/--(?:v|version)\b/i.test(text)) return text;
  return `${text} --v ${version}`;
}
