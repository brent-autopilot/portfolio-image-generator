export const GRADE_CATEGORIES = new Set([
  'LOGO',
  'LOGO-GRID',
  'AESTHETIC',
  'DATA-VIZ',
  'PRODUCT',
  'COMPOSITE',
  'TEXT-GRAPHIC',
]);

export const PASS_THRESHOLD = 5;

/**
 * @param {number} score
 * @returns {'Exceptional'|'Good'|'Acceptable'|'Poor'|'Unacceptable'}
 */
export function tierFromScore(score) {
  if (score >= 9) return 'Exceptional';
  if (score >= 7) return 'Good';
  if (score >= 5) return 'Acceptable';
  if (score >= 3) return 'Poor';
  return 'Unacceptable';
}

/** Score is the source of truth. Threshold matches Clog section 10. */
export function verdictFromScore(score) {
  return score >= PASS_THRESHOLD ? 'PASS' : 'FAIL';
}

function cleanStrings(value, max) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => typeof item === 'string' && item.trim())
    .map((item) => item.trim().slice(0, 240))
    .slice(0, max);
}

/**
 * Normalize a model grade object. Verdict and tier are derived from score.
 * @param {unknown} raw
 * @returns {{ ok: true, grade: object } | { ok: false, error: string }}
 */
export function validateGradeResponse(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Grade response is not an object' };
  }

  const score = Number(raw.score);
  if (!Number.isFinite(score) || score < 0 || score > 10) {
    return { ok: false, error: 'Score must be a number from 0 to 10' };
  }
  const rounded = Math.round(score * 10) / 10;

  const category = String(raw.category || '').trim().toUpperCase();
  if (!GRADE_CATEGORIES.has(category)) {
    return { ok: false, error: `Unknown category "${raw.category}"` };
  }

  const summary = typeof raw.summary === 'string' ? raw.summary.trim() : '';
  if (!summary) return { ok: false, error: 'Summary is required' };

  const strengths = cleanStrings(raw.strengths, 4);
  const weaknesses = cleanStrings(raw.weaknesses, 4);
  const redFlags = cleanStrings(raw.redFlags, 6);

  const rawCap = raw.bindingCap;
  const hasCap = rawCap !== null && rawCap !== undefined && rawCap !== '';
  if (redFlags.length && !hasCap) {
    return { ok: false, error: 'Named red flags require bindingCap from section 9' };
  }
  let bindingCap = null;
  if (hasCap) {
    const cap = Number(rawCap);
    if (!Number.isFinite(cap) || cap < 0 || cap > 10) {
      return { ok: false, error: 'bindingCap must be a number from 0 to 10' };
    }
    bindingCap = Math.round(cap * 10) / 10;
  }

  const cappedScore = bindingCap === null ? rounded : Math.min(rounded, bindingCap);
  const finalVerdict = verdictFromScore(cappedScore);

  const elementScores = Array.isArray(raw.elementScores)
    ? raw.elementScores
      .filter((item) => item && typeof item.name === 'string' && Number.isFinite(Number(item.score)))
      .map((item) => ({
        name: item.name.trim().slice(0, 40),
        score: Math.round(Math.min(10, Math.max(0, Number(item.score))) * 10) / 10,
      }))
      .slice(0, 6)
    : [];

  if (finalVerdict === 'PASS' && strengths.length < 1) {
    return { ok: false, error: 'PASS grades need at least one strength' };
  }
  if (finalVerdict === 'FAIL' && weaknesses.length < 1 && redFlags.length < 1) {
    return { ok: false, error: 'FAIL grades need a weakness or red flag' };
  }

  return {
    ok: true,
    grade: {
      verdict: finalVerdict,
      score: cappedScore,
      bindingCap,
      tier: tierFromScore(cappedScore),
      category,
      summary: summary.slice(0, 400),
      strengths,
      weaknesses,
      redFlags,
      capsApplied: cleanStrings(raw.capsApplied, 6),
      elementScores,
    },
  };
}
