/**
 * Known fund-name → literal anchor corrections.
 * Applied after Claude extraction when the model picks a wordplay object
 * instead of the obvious visual subject.
 */
const FUND_ANCHOR_RULES = [
  {
    fundPattern: /rain\s*check/i,
    forbiddenNounPatterns: [/ticket/i, /coupon/i, /voucher/i, /receipt/i],
    noun: 'umbrella rain',
    keywords: ['umbrella', 'rain'],
  },
];

/**
 * @param {string} fundName
 * @param {{ noun: string, keywords?: string[] }} locked
 * @returns {{ noun: string, keywords: string[], corrected: boolean, reason?: string }}
 */
export function sanitizeLockedAnchor(fundName, locked) {
  const noun = (locked?.noun || '').trim();
  const keywords = Array.isArray(locked?.keywords)
    ? locked.keywords.filter((k) => typeof k === 'string' && k.trim())
    : [];

  for (const rule of FUND_ANCHOR_RULES) {
    if (!rule.fundPattern.test(fundName)) continue;
    if (!rule.forbiddenNounPatterns.some((p) => p.test(noun))) continue;

    return {
      noun: rule.noun,
      keywords: [...new Set([...rule.keywords, ...keywords])],
      corrected: true,
      reason: `Replaced wordplay anchor "${noun}" with literal subject "${rule.noun}"`,
    };
  }

  return { noun, keywords, corrected: false };
}
