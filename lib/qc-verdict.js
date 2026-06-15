/** Normalize Clog QC output to PASS or FAIL. */
export function normalizeClogVerdict(raw) {
  const token = (raw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  return token === 'PASS' ? 'PASS' : 'FAIL';
}

/** Normalize literal-anchor YES/NO to boolean. */
export function normalizeLiteralVerdict(raw) {
  const token = (raw || '').trim().toUpperCase().replace(/[^A-Z]/g, '');
  if (token.startsWith('NO')) return false;
  return token.startsWith('YES');
}
