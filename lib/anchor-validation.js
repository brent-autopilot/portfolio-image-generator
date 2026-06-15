const ANCHOR_STOP_WORDS = new Set([
  'fund', 'capital', 'the', 'and', 'for', 'llc', 'lp', 'inc', 'co',
]);

export function normalizeAnchorText(text) {
  return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {string} noun - locked anchor noun phrase
 * @param {string[]} [extraKeywords]
 * @returns {string[]}
 */
export function buildKeywordList(noun, extraKeywords = []) {
  const list = new Set();
  const normalized = normalizeAnchorText(noun);
  if (normalized) list.add(normalized);

  for (const kw of extraKeywords) {
    const n = normalizeAnchorText(kw);
    if (n) list.add(n);
  }

  for (const word of normalized.split(/\s+/)) {
    if (word.length >= 3 && !ANCHOR_STOP_WORDS.has(word)) list.add(word);
  }

  return [...list].sort((a, b) => b.length - a.length);
}

/**
 * @param {string} prompt
 * @param {string[]} keywords
 */
export function promptContainsAnchor(prompt, keywords) {
  const p = normalizeAnchorText(prompt);
  return keywords.some((kw) => {
    if (!kw) return false;
    if (kw.includes(' ')) return p.includes(kw);
    return new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i').test(p);
  });
}

/**
 * @param {{ noun: string, keywords?: string[] }} lockedAnchor
 * @param {Array<{ anchor?: string, prompt?: string }>} concepts
 */
export function validateConcepts(lockedAnchor, concepts) {
  const noun = lockedAnchor?.noun || '';
  const keywords = buildKeywordList(noun, lockedAnchor?.keywords || []);
  const normalizedLocked = normalizeAnchorText(noun);
  const errors = [];

  if (!normalizedLocked) {
    return { valid: false, errors: ['Locked anchor noun is empty'], keywords };
  }

  if (!Array.isArray(concepts) || concepts.length === 0) {
    return { valid: false, errors: ['No concepts to validate'], keywords };
  }

  for (let i = 0; i < concepts.length; i++) {
    const c = concepts[i];
    const conceptAnchor = normalizeAnchorText(c?.anchor || '');

    if (conceptAnchor && conceptAnchor !== normalizedLocked) {
      const anchorsMatch =
        conceptAnchor.includes(normalizedLocked) ||
        normalizedLocked.includes(conceptAnchor);
      if (!anchorsMatch) {
        errors.push(
          `Concept ${i + 1}: anchor "${c.anchor}" does not match locked anchor "${noun}"`
        );
      }
    }

    if (!c?.prompt || typeof c.prompt !== 'string') {
      errors.push(`Concept ${i + 1}: missing prompt`);
      continue;
    }

    if (!promptContainsAnchor(c.prompt, keywords)) {
      errors.push(
        `Concept ${i + 1}: prompt missing anchor keywords [${keywords.join(', ')}]`
      );
    }
  }

  return { valid: errors.length === 0, errors, keywords };
}

export const BANK_BANNED_PATTERNS = [
  /\bthesis\b/i,
  /\bbreakthrough\b/i,
  /\bemergence\b/i,
  /\binterconnected\b/i,
  /\bnetwork\b/i,
  /\bweb of\b/i,
  /\bforming or dissolving\b/i,
  /\bdissolving into\b/i,
  /\bparticle field\b/i,
  /\bneural network\b/i,
];

/**
 * @param {string} line
 * @param {'style'|'interpretation'} bankType
 */
export function lintBankLine(line, bankType) {
  const issues = [];
  for (const pattern of BANK_BANNED_PATTERNS) {
    if (pattern.test(line)) {
      issues.push(`banned pattern: ${pattern}`);
    }
  }
  if (bankType === 'interpretation' && /\bfund(?:'s)?\s+thesis\b/i.test(line)) {
    issues.push('interpretation must not reference fund thesis');
  }
  if (bankType === 'style' && /\bforming a recognizable\b/i.test(line)) {
    issues.push('style must not define the subject shape');
  }
  return issues;
}
