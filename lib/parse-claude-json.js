export function stripMarkdownFences(raw) {
  return (raw || '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/g, '')
    .trim();
}

/**
 * Extract first balanced JSON fragment starting with openChar.
 * Handles nested braces/brackets and strings with escapes.
 */
export function extractBalancedJson(raw, openChar, closeChar) {
  const start = raw.indexOf(openChar);
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }

  return null;
}

export function parseJsonObjectFromClaude(raw) {
  const cleaned = stripMarkdownFences(raw);
  const jsonText = extractBalancedJson(cleaned, '{', '}');
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function parseJsonArrayFromClaude(raw) {
  const cleaned = stripMarkdownFences(raw);
  const jsonText = extractBalancedJson(cleaned, '[', ']');
  if (!jsonText) return null;
  try {
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
