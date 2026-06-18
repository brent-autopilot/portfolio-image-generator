import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync, unlinkSync, renameSync, rmSync, readdirSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { pipeline as streamPipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import sharp from 'sharp';
import multer from 'multer';
import { ZipArchive } from 'archiver';
import { validateConcepts, buildKeywordList } from './lib/anchor-validation.js';
import { parseJsonObjectFromClaude, parseJsonArrayFromClaude } from './lib/parse-claude-json.js';
import { sanitizeLockedAnchor } from './lib/fund-anchor-hints.js';
import { normalizeClogVerdict, normalizeLiteralVerdict } from './lib/qc-verdict.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'autopilot';
const SETTINGS_PASSWORD = process.env.SETTINGS_PASSWORD || 'growth101';

// ---------------------------------------------------------------------------
// Auth — simple password gate with HMAC session token
// ---------------------------------------------------------------------------
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

function makeToken(password) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

const VALID_TOKEN = makeToken(SITE_PASSWORD);
const SETTINGS_TOKEN = makeToken(SETTINGS_PASSWORD + '_settings');

function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  header.split(';').forEach((c) => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=').trim();
  });
  return cookies;
}

function isAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.auth_token || '';
  if (token.length !== VALID_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(VALID_TOKEN));
  } catch {
    return false;
  }
}

function isSettingsAuthed(req) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies.settings_token || '';
  if (token.length !== SETTINGS_TOKEN.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(SETTINGS_TOKEN));
  } catch {
    return false;
  }
}

app.post('/api/auth', (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || password !== SITE_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', `auth_token=${VALID_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true });
});

app.get('/api/auth/check', (req, res) => {
  res.json({ authed: isAuthed(req) });
});

app.post('/api/settings/auth', (req, res) => {
  const { password } = req.body;
  if (typeof password !== 'string' || password !== SETTINGS_PASSWORD) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  res.setHeader('Set-Cookie', `settings_token=${SETTINGS_TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
  res.json({ ok: true });
});

app.get('/api/settings/auth/check', (req, res) => {
  res.json({ authed: isSettingsAuthed(req) });
});

// Serve static files (login page is always accessible)
app.use(express.static(join(__dirname, 'public')));

// LegNext webhook — must be unauthenticated (called by LegNext servers)
app.post('/api/mj-callback', (req, res) => {
  const data = req.body || {};
  const mjJobId = data.job_id;
  if (!mjJobId) return res.status(400).json({ error: 'missing job_id' });

  const pending = mjPendingCallbacks.get(mjJobId);
  if (pending) {
    if (data.status === 'completed') {
      pending.resolve(parseGridOutput(data, mjJobId));
    } else if (data.status === 'failed') {
      pending.reject(new Error(data.error?.message || 'Midjourney task failed'));
    }
  }
  res.json({ ok: true });
});

// Protect all other API routes
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  if (req.path.startsWith('/settings/auth')) return next();
  if (req.path.startsWith('/sref-image/')) return next();
  if (req.path === '/mj-callback') return next();
  if (req.path.startsWith('/settings/')) {
    if (!isSettingsAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
    return next();
  }
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const ARCHIVE_DIR = join(__dirname, 'archive');
const QUADRANT_DIR = join(__dirname, 'quadrants');
const HISTORY_FILE = join(ARCHIVE_DIR, 'history.json');
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads');

if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
if (!existsSync(QUADRANT_DIR)) mkdirSync(QUADRANT_DIR, { recursive: true });

const LEGNEXT_BASE = 'https://api.legnext.ai/api/v1';
const NUM_CONCEPTS = 3;
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 3000;

function getPublicBaseUrl() {
  const rpd = process.env.RAILWAY_PUBLIC_DOMAIN;
  return rpd ? `https://${rpd}` : null;
}

// LegNext webhook completions keyed by Midjourney job_id
const mjPendingCallbacks = new Map();

// SSE subscribers keyed by pipeline job id
const jobSubscribers = new Map();

function serializeJobPayload(job) {
  return {
    jobId: job.id,
    stage: job.stage,
    fundName: job.fundName,
    fundThesis: job.fundThesis,
    bypassMode: job.bypassMode,
    assignedStyles: job.assignedStyles,
    assignedInterpretations: job.assignedInterpretations,
    assignedProfiles: job.assignedProfiles,
    actualSrefs: job.actualSrefs,
    profileTags: job.profileTags,
    genRatings: job.genRatings || {},
    lockedAnchor: job.lockedAnchor,
    concepts: job.concepts,
    mjTaskIds: job.mjTaskIds,
    rawImages: job.rawImages,
    rawImageCount: job.rawImages.length,
    approvedCount: job.approvedImages.length,
    rejectedCount: job.rejectedImages.length,
    approvedImages: job.approvedImages,
    rejectedImages: job.rejectedImages,
    warnings: job.warnings || [],
    error: job.error,
  };
}

function emitJobUpdate(job) {
  const subs = jobSubscribers.get(job.id);
  if (!subs?.size) return;
  const payload = `data: ${JSON.stringify(serializeJobPayload(job))}\n\n`;
  for (const res of subs) {
    try {
      res.write(payload);
    } catch {
      subs.delete(res);
    }
  }
}

function setJobStage(job, stage) {
  job.stage = stage;
  emitJobUpdate(job);
}

// ---------------------------------------------------------------------------
// Lazy Anthropic client — initialized on first use so env vars are resolved
// at request time, not module load time (critical for Vercel cold starts)
// ---------------------------------------------------------------------------
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error('ANTHROPIC_API_KEY environment variable is not set');
    }
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

// ---------------------------------------------------------------------------
// Prompts + Style Bank
// ---------------------------------------------------------------------------
const visualThesisPrompt = readFileSync(
  join(__dirname, 'prompts', 'visual-thesis.md'),
  'utf-8'
);

function loadBank(filepath) {
  const raw = readFileSync(filepath, 'utf-8');
  const afterSeparator = raw.split('\n---\n').pop() || raw;
  return afterSeparator
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^[a-zA-Z0-9]/.test(l));
}

function loadStyleBank() {
  return loadBank(join(__dirname, 'prompts', 'style-bank.md'));
}

const STYLE_BANK = loadStyleBank();

function pickRandomStyles(count) {
  return weightedRandomPick(STYLE_BANK, (s) => s, 'styles', count);
}

function loadInterpretationBank() {
  return loadBank(join(__dirname, 'prompts', 'interpretation-bank.md'));
}

const INTERPRETATION_BANK = loadInterpretationBank();

function pickRandomInterpretations(count) {
  return weightedRandomPick(INTERPRETATION_BANK, (s) => s, 'interpretations', count);
}

// ---------------------------------------------------------------------------
// Profile Bank — Midjourney --profile tags, one randomly assigned per gen
// Stored in ARCHIVE_DIR (Railway Volume) so it persists across deploys.
// Seeded from prompts/profile-bank.md on first boot.
// ---------------------------------------------------------------------------
const PROFILE_BANK_FILE = join(ARCHIVE_DIR, 'profile-bank.json');

function seedProfileBankFromMarkdown() {
  try {
    const raw = readFileSync(join(__dirname, 'prompts', 'profile-bank.md'), 'utf-8');
    const afterSeparator = raw.split('\n---\n').pop() || raw;
    return afterSeparator
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.includes('|'))
      .map((l) => {
        const [label, tag] = l.split('|').map((s) => s.trim());
        return { label, tag };
      })
      .filter((e) => e.tag && e.tag.startsWith('--profile'));
  } catch {
    return [];
  }
}

function loadProfileBank() {
  try {
    return JSON.parse(readFileSync(PROFILE_BANK_FILE, 'utf-8'));
  } catch {
    const seeded = seedProfileBankFromMarkdown();
    saveProfileBank(seeded);
    return seeded;
  }
}

function saveProfileBank(entries) {
  writeFileSync(PROFILE_BANK_FILE, JSON.stringify(entries, null, 2));
}

let PROFILE_BANK = loadProfileBank();

function pickRandomProfiles(count) {
  return weightedRandomPick(PROFILE_BANK, (p) => p.tag, 'profiles', count);
}

// ---------------------------------------------------------------------------
// Style Reference Bank — --sref images for Gen 3
// ---------------------------------------------------------------------------
const STYLE_WEIGHT = 100;

function getSrefDir() {
  const dir = join(ARCHIVE_DIR, 'sref');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function getSrefBankFile() {
  return join(ARCHIVE_DIR, 'sref-bank.json');
}

function loadSrefBank() {
  try {
    return JSON.parse(readFileSync(getSrefBankFile(), 'utf-8'));
  } catch {
    return [];
  }
}

function deduplicateSrefName(name) {
  const bank = loadSrefBank();
  const base = name.replace(/\s*\d+$/, '').trim();
  const existing = bank.filter((e) => e.name === base || e.name.match(new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\d+$`)));
  if (existing.length === 0 && !bank.some((e) => e.name === name)) return name;
  const nums = existing.map((e) => {
    const m = e.name.match(/\s+(\d+)$/);
    return m ? parseInt(m[1], 10) : 1;
  });
  return `${base} ${Math.max(0, ...nums) + 1}`;
}

function saveSrefBank(entries) {
  writeFileSync(getSrefBankFile(), JSON.stringify(entries, null, 2));
}

function pickRandomSrefs(count, baseUrl) {
  const bank = loadSrefBank();
  if (bank.length === 0) return [];
  const picks = weightedRandomPick(bank, (p) => p.name, 'srefs', count);
  return picks.map((p) => ({ name: p.name, url: `${baseUrl}/api/sref-image/${p.filename}` }));
}

async function verifySrefUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      console.error(`[sref-verify] HEAD ${url} returned ${res.status}`);
      return false;
    }
    const ct = res.headers.get('content-type') || '';
    if (!ct.startsWith('image/')) {
      console.error(`[sref-verify] ${url} returned content-type: ${ct}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`[sref-verify] Failed to reach ${url}: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Ratings — weighted selection based on thumbs up/neutral/down feedback
// ---------------------------------------------------------------------------
const RATINGS_FILE = join(ARCHIVE_DIR, 'ratings.json');
const DEFAULT_RATINGS = { styles: {}, interpretations: {}, profiles: {}, srefs: {} };
let _ratingsCache = null;

function loadRatings() {
  if (_ratingsCache) return _ratingsCache;
  try {
    const parsed = JSON.parse(readFileSync(RATINGS_FILE, 'utf-8'));
    _ratingsCache = { ...DEFAULT_RATINGS, ...parsed };
  } catch {
    _ratingsCache = { ...DEFAULT_RATINGS };
  }
  return _ratingsCache;
}

function saveRatings(data) {
  _ratingsCache = data;
  writeFileSync(RATINGS_FILE, JSON.stringify(data, null, 2));
}

function getRatingScore(category, key) {
  const ratings = loadRatings();
  const entry = ratings[category]?.[key];
  if (!entry) return 10;
  return Math.max(1, 10 + (entry.up || 0) * 2 - (entry.down || 0) * 3);
}

function incrementRating(category, key, rating) {
  const ratings = loadRatings();
  if (!ratings[category]) ratings[category] = {};
  if (!ratings[category][key]) ratings[category][key] = { up: 0, down: 0, neutral: 0 };
  ratings[category][key][rating] = (ratings[category][key][rating] || 0) + 1;
  saveRatings(ratings);
}

function decrementRating(category, key, rating) {
  const ratings = loadRatings();
  if (!ratings[category]?.[key]) return;
  ratings[category][key][rating] = Math.max(0, (ratings[category][key][rating] || 0) - 1);
  saveRatings(ratings);
}

function weightedRandomPick(pool, getKey, category, count) {
  const available = [...pool];
  const picks = [];
  for (let i = 0; i < count && available.length > 0; i++) {
    const scored = available.map((item, idx) => ({ item, idx, score: getRatingScore(category, getKey(item)) }));
    const total = scored.reduce((sum, s) => sum + s.score, 0);
    let r = Math.random() * total;
    let winner = scored[scored.length - 1];
    for (const s of scored) {
      r -= s.score;
      if (r <= 0) { winner = s; break; }
    }
    picks.push(winner.item);
    available.splice(winner.idx, 1);
  }
  while (picks.length < count && pool.length > 0) {
    picks.push(pool[Math.floor(Math.random() * pool.length)]);
  }
  return picks;
}

function loadClogPrompt() {
  try {
    const raw = readFileSync(join(__dirname, 'prompts', 'clog-qc.md'), 'utf-8');
    if (raw.startsWith('# PLACEHOLDER')) return null;
    const sectionStart = raw.indexOf('## SECTION 1');
    const body = sectionStart >= 0 ? raw.slice(sectionStart) : raw;
    if (body.trim().length < 100) return null;
    return body.trim();
  } catch {
    return null;
  }
}

function extractSystemPrompt(md) {
  const match = md.match(/```\n([\s\S]*?)```/);
  return match ? match[1].trim() : md;
}

const THEME_SYSTEM_PROMPT = extractSystemPrompt(visualThesisPrompt);

// ---------------------------------------------------------------------------
// In-memory job store with TTL-based pruning
// ---------------------------------------------------------------------------
const jobs = new Map();

const VALID_BYPASS_MODES = ['normal', 'skip-style', 'skip-interp', 'full-bypass'];

function createJob(fundName, fundThesis, styleJson, bypassMode = 'normal') {
  const id = crypto.randomUUID();
  const job = {
    id,
    fundName,
    fundThesis,
    styleJson,
    bypassMode,
    stage: 'queued',
    assignedStyles: [],
    assignedInterpretations: [],
    concepts: [],
    mjTaskIds: [],
    rawImages: [],
    approvedImages: [],
    rejectedImages: [],
    lockedAnchor: null,
    warnings: [],
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function pruneExpiredJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) {
      jobs.delete(id);
      const jobQuadDir = join(QUADRANT_DIR, id);
      if (existsSync(jobQuadDir)) {
        try { rmSync(jobQuadDir, { recursive: true, force: true }); } catch {}
      }
    }
  }
}

const pruneTimer = setInterval(pruneExpiredJobs, JOB_PRUNE_INTERVAL_MS);
pruneTimer.unref();

// ---------------------------------------------------------------------------
// Stage 1 — Claude Sonnet: generate 3 distinct image prompts (anchor-locked)
// ---------------------------------------------------------------------------
const CLAUDE_MODEL = 'claude-sonnet-4-6';
const THEME_MODEL = CLAUDE_MODEL;

async function extractLockedAnchor(job, thesis) {
  const userContent = `Fund name: "${job.fundName}"
Thesis: "${thesis}"

What is the obvious literal visual subject a normal person pictures? Not abstract concepts, not financial metaphors.

Examples:
- "Rain Check Capital" → umbrella, rain (weather protection — NOT a rain-check ticket or coupon)
- "Umbrella Trading" → umbrella
- "Silver Fund" → silver metal

Return ONLY JSON with no markdown fences:
{
  "noun": "2-4 word anchor phrase",
  "keywords": ["word1", "word2"]
}

keywords must be concrete nouns that must appear in image prompts (include plural/singular variants if helpful).`;

  let lastRaw = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const resp = await getAnthropic().messages.create({
      model: THEME_MODEL,
      max_tokens: 256,
      system: `You identify the single most obvious LITERAL visual subject from a fund name. Return only JSON.`,
      messages: [{ role: 'user', content: userContent }],
    });

    lastRaw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseJsonObjectFromClaude(lastRaw);
    if (!parsed?.noun || typeof parsed.noun !== 'string') {
      console.warn(`[job ${job.id}] Anchor parse failed (attempt ${attempt + 1})`);
      continue;
    }

    const keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k) => typeof k === 'string' && k.trim())
      : [];

    const sanitized = sanitizeLockedAnchor(job.fundName, {
      noun: parsed.noun.trim(),
      keywords,
    });
    if (sanitized.corrected) {
      console.warn(`[job ${job.id}] ${sanitized.reason}`);
    }

    const locked = { noun: sanitized.noun, keywords: sanitized.keywords };
    job.lockedAnchor = locked;
    console.log(`[job ${job.id}] Locked anchor: "${locked.noun}" keywords=[${buildKeywordList(locked.noun, locked.keywords).join(', ')}]`);
    return locked;
  }

  throw new Error(`Failed to extract locked anchor after retry. Raw: ${lastRaw.slice(0, 200)}`);
}

function buildDirectivesParagraph(mode, styles, interpretations) {
  const useStyles = styles.length > 0;
  const useInterps = interpretations.length > 0;
  let directivesParagraph = '';
  let extraReturnFields = '';

  if (useStyles && useInterps) {
    const directives = styles
      .map((s, i) => `  Concept ${i + 1} style: "${s}"\n  Concept ${i + 1} composition: "${interpretations[i]}"`)
      .join('\n');

    directivesParagraph = `\n\nEach concept has a mandatory visual STYLE and mandatory COMPOSITION directive.

Style = medium, technique, lighting, texture — HOW it renders. Never what the subject is.
Composition = camera angle, environment, scale, framing of the LOCKED ANCHOR — never a new subject.

${directives}

CRITICAL RULES:
- Style controls rendering only. If a style mentions objects, apply as texture/material to the anchor subject.
- Composition changes framing of the anchor subject only. If composition could be satisfied without showing the anchor noun, reject it and stay literal.
- The locked anchor is the ONLY subject. No abstract metaphors, explosions, particle webs, or networks.`;

    extraReturnFields = '\n- "style": the assigned style directive (echo it back exactly)\n- "interpretation": the assigned composition directive (echo it back exactly)';
  } else if (useStyles) {
    const directives = styles.map((s, i) => `  Concept ${i + 1} style: "${s}"`).join('\n');
    directivesParagraph = `\n\nEach concept has a mandatory visual style (rendering treatment only):\n\n${directives}\n\nStyle controls HOW the anchor looks, never WHAT the subject is.`;
    extraReturnFields = '\n- "style": the assigned style directive (echo it back exactly)';
  } else if (useInterps) {
    const directives = interpretations.map((interp, i) => `  Concept ${i + 1} composition: "${interp}"`).join('\n');
    directivesParagraph = `\n\nEach concept has a mandatory composition directive (framing of the anchor only):\n\n${directives}`;
    extraReturnFields = '\n- "interpretation": the assigned composition directive (echo it back exactly)';
  }

  return { directivesParagraph, extraReturnFields };
}

function buildThemeUserMessage({
  job, thesis, lockedAnchor, directivesParagraph, extraReturnFields, styleContext, isFullBypass, retryNote,
}) {
  const keywordList = buildKeywordList(lockedAnchor.noun, lockedAnchor.keywords).join(', ');

  if (isFullBypass) {
    return `Fund name: "${job.fundName}"
Thesis: "${thesis}"

LOCKED ANCHOR: "${lockedAnchor.noun}" — keywords that MUST appear in every prompt: ${keywordList}
${retryNote || ''}

Generate exactly ${NUM_CONCEPTS} simple literal Midjourney prompts. SAME anchor subject, different compositions/angles. No abstract metaphors.

Return ONLY a JSON array of exactly ${NUM_CONCEPTS} objects:
- "anchor": must be "${lockedAnchor.noun}" exactly
- "concept": 2-3 word shot label referencing the literal subject (e.g. "umbrella close-up")
- "prompt": 15-30 words, comma-separated fragments, anchor dominant`;
  }

  return `THE FUND:
  FUND NAME: "${job.fundName}"
  FUND THESIS: "${thesis}"

LOCKED ANCHOR (non-negotiable — same subject in ALL ${NUM_CONCEPTS} prompts):
  noun: "${lockedAnchor.noun}"
  required keywords in every prompt: ${keywordList}
${retryNote || ''}

Generate exactly ${NUM_CONCEPTS} concepts depicting the SAME locked anchor subject. Each uses a different composition, angle, environment, or moment. The anchor noun must be unmistakable and dominant. No abstract metaphors. No new subjects.

HIERARCHY:
1. LOCKED ANCHOR — what is in the image (non-negotiable)
2. COMPOSITION (interpretation) — how it is framed
3. STYLE — how it is rendered${directivesParagraph}

PROMPT LENGTH: 20-45 words. Evocative comma-separated fragments. Every prompt must contain at least one required keyword.${styleContext}

Return ONLY a JSON array of exactly ${NUM_CONCEPTS} objects:
- "anchor": must be "${lockedAnchor.noun}" exactly
- "concept": 2-3 word shot label (e.g. "umbrella close-up", "rain street") — literal subject only, never abstract
- "prompt": Midjourney prompt — anchor dominant${extraReturnFields}`;
}

async function callClaudeForConcepts(systemPrompt, userMessage) {
  const resp = await getAnthropic().messages.create({
    model: THEME_MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const raw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const concepts = parseJsonArrayFromClaude(raw);
  if (!Array.isArray(concepts)) {
    throw new Error(`Failed to parse Claude concepts JSON: ${raw.slice(0, 200)}`);
  }

  return concepts
    .filter((c) => c && typeof c.concept === 'string' && typeof c.prompt === 'string')
    .slice(0, NUM_CONCEPTS);
}

async function generateThemes(job) {
  setJobStage(job, 'generating_theme');

  const styleContext = job.styleJson
    ? `\n\nUse this visual style JSON for atmospheric tone only:\n${JSON.stringify(job.styleJson, null, 2)}`
    : '';

  const thesis = job.fundThesis && job.fundThesis.trim()
    ? job.fundThesis.trim()
    : `A fund called "${job.fundName}" — use the name itself to infer the investment thesis and visual subject`;

  const mode = job.bypassMode || 'normal';
  const useStyles = mode === 'normal' || mode === 'skip-interp';
  const useInterps = mode === 'normal' || mode === 'skip-style';
  const isFullBypass = mode === 'full-bypass';

  const styles = useStyles
    ? (job.manualStyle ? Array(NUM_CONCEPTS).fill(job.manualStyle) : pickRandomStyles(NUM_CONCEPTS))
    : [];
  const interpretations = useInterps
    ? (job.manualInterpretation ? Array(NUM_CONCEPTS).fill(job.manualInterpretation) : pickRandomInterpretations(NUM_CONCEPTS))
    : [];

  job.assignedStyles = styles;
  job.assignedInterpretations = interpretations;
  if (styles.length) console.log(`[job ${job.id}] Assigned styles:`, styles);
  if (interpretations.length) console.log(`[job ${job.id}] Assigned interpretations:`, interpretations);
  if (isFullBypass) console.log(`[job ${job.id}] Full bypass — style + interpretation banks disabled`);

  const lockedAnchor = await extractLockedAnchor(job, thesis);
  emitJobUpdate(job);

  const { directivesParagraph, extraReturnFields } = buildDirectivesParagraph(mode, styles, interpretations);
  let systemPrompt = isFullBypass
    ? `You are a visual prompt distiller for Midjourney. Given a locked literal anchor subject, write concrete prompts. Never abstract.`
    : THEME_SYSTEM_PROMPT;

  let retryNote = '';
  let valid = [];
  let lastValidationErrors = [];

  for (let attempt = 0; attempt < 2; attempt++) {
    const userMessage = buildThemeUserMessage({
      job, thesis, lockedAnchor, directivesParagraph, extraReturnFields, styleContext, isFullBypass, retryNote,
    });

    const concepts = await callClaudeForConcepts(systemPrompt, userMessage);
    if (concepts.length === 0) {
      throw new Error('Claude returned no valid concepts');
    }

    const validation = validateConcepts(lockedAnchor, concepts, {
      expectedCount: NUM_CONCEPTS,
      requireAnchorField: true,
    });
    if (validation.valid) {
      valid = concepts;
      if (attempt > 0) {
        console.warn(`[job ${job.id}] Anchor validation passed on retry ${attempt + 1}`);
      }
      break;
    }

    lastValidationErrors = validation.errors;
    console.warn(`[job ${job.id}] Anchor validation failed (attempt ${attempt + 1}):`, validation.errors.join('; '));
    retryNote = `\n\nVALIDATION FAILED — fix these errors:\n${validation.errors.map((e) => `- ${e}`).join('\n')}\nEvery prompt MUST contain: ${validation.keywords.join(', ')}. Every anchor MUST be "${lockedAnchor.noun}".`;
  }

  if (valid.length === 0) {
    const msg = `Anchor validation failed after retry: ${lastValidationErrors.join('; ')}`;
    console.error(`[job ${job.id}] ${msg}`);
    throw new Error(msg);
  }

  job.concepts = valid;
  console.log(`[job ${job.id}] [${mode}] Generated ${job.concepts.length} anchor-locked concepts:`);
  job.concepts.forEach((c, i) => console.log(`  ${i + 1}. [${c.concept}] ${c.prompt}`));

  return job.concepts;
}

// ---------------------------------------------------------------------------
// Stage 2 — LegNext.ai / Midjourney
// ---------------------------------------------------------------------------
const SREF_MAX_RETRIES = 2;

async function submitMidjourneyJob(prompt, { profile = null, sref = null, sw = null } = {}) {
  const apiKey = process.env.LEGNEXT_API_KEY;
  if (!apiKey) throw new Error('LEGNEXT_API_KEY not configured');

  const profileSuffix = profile ? ` ${profile}` : '';
  const srefSuffix = sref ? ` --sref ${sref} --sw ${sw ?? STYLE_WEIGHT}` : '';
  const fullPrompt = `${prompt}${profileSuffix}${srefSuffix}`;
  console.log(`[midjourney] Submitting prompt (${fullPrompt.length} chars): ${fullPrompt.slice(0, 300)}...`);

  const body = { text: fullPrompt };
  const callbackBase = getPublicBaseUrl();
  if (callbackBase) {
    body.callback = `${callbackBase}/api/mj-callback`;
  }

  const res = await fetch(`${LEGNEXT_BASE}/diffusion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `LegNext diffusion returned HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.error && data.error.code !== 0) {
    throw new Error(data.error?.message || data.message || 'LegNext diffusion request failed');
  }
  return data.job_id;
}

function isSrefModerationError(msg) {
  return /content moderation|reference image/i.test(msg || '');
}

async function submitAndPollWithSrefRetry(prompt, opts, label) {
  const hasSref = !!opts.sref;
  const maxAttempts = hasSref ? SREF_MAX_RETRIES : 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const jobId = await submitMidjourneyJob(prompt, opts);
      const grid = await waitForGridJob(jobId);
      if (!grid.imageUrl && !(grid.imageUrls?.length)) throw new Error('No image URL returned');
      return { grid, usedSref: hasSref };
    } catch (err) {
      if (hasSref && isSrefModerationError(err.message) && attempt < maxAttempts) {
        console.warn(`[${label}] Sref moderation reject (attempt ${attempt}/${maxAttempts}), resubmitting...`);
        continue;
      }
      if (hasSref && isSrefModerationError(err.message)) {
        console.warn(`[${label}] Sref failed ${maxAttempts}x, falling back to no-sref`);
        const noSrefOpts = { ...opts, sref: null, sw: null };
        const jobId = await submitMidjourneyJob(prompt, noSrefOpts);
        const grid = await waitForGridJob(jobId);
        return { grid, usedSref: false };
      }
      throw err;
    }
  }
}

async function fetchMidjourneyResult(jobId) {
  const res = await fetch(`${LEGNEXT_BASE}/job/${jobId}`, {
    method: 'GET',
    headers: { 'x-api-key': process.env.LEGNEXT_API_KEY },
  });
  if (!res.ok) {
    throw new Error(`LegNext job fetch returned ${res.status}`);
  }
  return res.json();
}

async function submitUpscale(jobId, imageNo = 0) {
  const apiKey = process.env.LEGNEXT_API_KEY;
  const res = await fetch(`${LEGNEXT_BASE}/upscale`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ jobId, imageNo, type: 0 }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = `LegNext upscale returned HTTP ${res.status}`;
    try { const j = JSON.parse(text); msg = j.error?.message || j.message || msg; } catch {}
    throw new Error(msg);
  }

  const data = await res.json();
  if (data.error && data.error.code !== 0) {
    throw new Error(data.error?.message || 'Upscale request failed');
  }
  return data.job_id;
}

function parseGridOutput(result, mjJobId) {
  const jobId = mjJobId || result.job_id;
  const imageUrl = result.output?.image_url || (result.output?.image_urls?.[0]) || null;
  const imageUrls = result.output?.image_urls || [];
  return { jobId, imageUrl, imageUrls };
}

async function pollGridJob(jobId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await fetchMidjourneyResult(jobId);

    if (result.status === 'completed') {
      return parseGridOutput(result, jobId);
    }

    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Midjourney task failed');
    }
  }

  throw new Error('Midjourney task timed out after polling');
}

async function waitForGridJob(mjJobId) {
  const callbackBase = getPublicBaseUrl();

  if (callbackBase) {
    return new Promise((resolve, reject) => {
      const timeoutMs = MAX_POLL_ATTEMPTS * POLL_INTERVAL_MS;
      const timeout = setTimeout(() => {
        mjPendingCallbacks.delete(mjJobId);
        pollGridJob(mjJobId).then(resolve).catch(reject);
      }, timeoutMs);

      mjPendingCallbacks.set(mjJobId, {
        resolve: (grid) => {
          clearTimeout(timeout);
          mjPendingCallbacks.delete(mjJobId);
          resolve(grid);
        },
        reject: (err) => {
          clearTimeout(timeout);
          mjPendingCallbacks.delete(mjJobId);
          reject(err);
        },
      });

      fetchMidjourneyResult(mjJobId)
        .then((result) => {
          if (result.status === 'completed') {
            clearTimeout(timeout);
            mjPendingCallbacks.delete(mjJobId);
            resolve(parseGridOutput(result, mjJobId));
          } else if (result.status === 'failed') {
            clearTimeout(timeout);
            mjPendingCallbacks.delete(mjJobId);
            reject(new Error(result.error?.message || 'Midjourney task failed'));
          }
        })
        .catch(() => {
          // Webhook or timeout fallback handles completion.
        });
    });
  }

  try {
    const result = await fetchMidjourneyResult(mjJobId);
    if (result.status === 'completed') return parseGridOutput(result, mjJobId);
    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Midjourney task failed');
    }
  } catch (err) {
    if (/Midjourney task failed/i.test(err.message || '')) throw err;
  }

  return pollGridJob(mjJobId);
}

async function pollUpscaleJob(jobId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await fetchMidjourneyResult(jobId);

    if (result.status === 'completed') {
      const url = result.output?.image_url || (result.output?.image_urls?.[0]) || null;
      if (!url) throw new Error('Upscale completed but no image URL returned');
      return url;
    }

    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Upscale task failed');
    }
  }

  throw new Error('Upscale task timed out after polling');
}

async function cropGridToQuadrants(gridUrl, jobId, gridIndex) {
  const res = await fetch(gridUrl);
  if (!res.ok) throw new Error(`Failed to download grid: HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());

  const meta = await sharp(buffer).metadata();
  const w = meta.width;
  const h = meta.height;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);

  const quadrants = [
    { left: 0, top: 0 },
    { left: halfW, top: 0 },
    { left: 0, top: halfH },
    { left: halfW, top: halfH },
  ];

  const jobDir = join(QUADRANT_DIR, jobId);
  if (!existsSync(jobDir)) mkdirSync(jobDir, { recursive: true });

  const files = await Promise.all(
    quadrants.map(async (quad, q) => {
      const filename = `grid${gridIndex}-q${q}.jpg`;
      const filepath = join(jobDir, filename);
      await sharp(buffer)
        .extract({ left: quad.left, top: quad.top, width: halfW, height: halfH })
        .jpeg({ quality: 92 })
        .toFile(filepath);
      return filename;
    })
  );

  return files;
}

function mapQuadrantImages(imageUrls, grid, task, profiles, job, gridIndex) {
  const { jobId: gridJobId, imageUrl } = grid;
  const concept = task.concept;
  const gi = task.genIndex;
  return imageUrls.slice(0, 4).map((url, q) => ({
    url,
    gridUrl: imageUrl,
    gridJobId,
    imageNo: q,
    quadrantFile: null,
    upscaled: false,
    concept: concept.concept,
    prompt: concept.prompt,
    style: concept.style || null,
    interpretation: concept.interpretation || null,
    genIndex: gi,
    profile: profiles[gi]?.tag || null,
    profileLabel: profiles[gi]?.label || null,
    srefName: task.usedSref ? (job.actualSrefs[gi] || null) : null,
    srefLost: !!task.srefLost,
  }));
}

async function buildImagesFromGenResult(grid, task, gridIndex, profiles, job) {
  const { imageUrl, imageUrls } = grid;

  if (imageUrls?.length >= 4) {
    console.log(`[job ${job.id}] Using LegNext image_urls for Gen ${task.genIndex + 1}`);
    return mapQuadrantImages(imageUrls, grid, task, profiles, job, gridIndex);
  }

  if (!imageUrl) {
    console.error(`[job ${job.id}] No image URL for grid "${task.concept.concept}"`);
    return [];
  }

  console.warn(`[job ${job.id}] image_urls missing for Gen ${task.genIndex + 1}, falling back to grid crop`);
  const quadrantFiles = await cropGridToQuadrants(imageUrl, job.id, gridIndex);
  return quadrantFiles.map((qf, q) => ({
    url: `/api/quadrant/${job.id}/${qf}`,
    gridUrl: imageUrl,
    gridJobId: grid.jobId,
    imageNo: q,
    quadrantFile: qf,
    upscaled: false,
    concept: task.concept.concept,
    prompt: task.concept.prompt,
    style: task.concept.style || null,
    interpretation: task.concept.interpretation || null,
    genIndex: task.genIndex,
    profile: profiles[task.genIndex]?.tag || null,
    profileLabel: profiles[task.genIndex]?.label || null,
    srefName: task.usedSref ? (job.actualSrefs[task.genIndex] || null) : null,
    srefLost: !!task.srefLost,
  }));
}

async function generateAllImages(job, { onGenComplete } = {}) {
  setJobStage(job, 'generating_images');

  const profiles = pickRandomProfiles(NUM_CONCEPTS);
  const rpd = process.env.RAILWAY_PUBLIC_DOMAIN;
  const host = rpd || process.env.HOST || `localhost:${PORT}`;
  const baseUrl = rpd ? `https://${host}` : `http://${host}`;

  // Pick 2 distinct srefs for Gen 2 and Gen 3; verify reachability in parallel
  const SREF_COUNT = 2;
  const srefCandidates = pickRandomSrefs(SREF_COUNT, baseUrl);
  let srefs = []; // verified srefs, indexed 0 → Gen 2, 1 → Gen 3
  if (srefCandidates.length > 0) {
    if (!rpd) {
      console.warn(`[job ${job.id}] RAILWAY_PUBLIC_DOMAIN not set — skipping --sref (Midjourney can't reach localhost)`);
    } else {
      const checks = await Promise.all(srefCandidates.map((c) => verifySrefUrl(c.url)));
      srefs = srefCandidates.map((c, s) => {
        if (checks[s]) {
          console.log(`[job ${job.id}] Sref ${s + 1} verified OK: "${c.name}" → ${c.url}`);
          return c;
        }
        console.warn(`[job ${job.id}] Sref ${s + 1} URL not reachable, Gen ${s + 2} will run without --sref`);
        return null;
      });
    }
  }

  job.assignedProfiles = profiles.map((p) => p.label);
  job.assignedSrefs = srefs.filter(Boolean).map((s) => s.name);
  job.actualSrefs = [null, ...srefs.map((s) => s ? s.name : null)];
  job.profileTags = profiles.map((p) => p.tag);
  console.log(`[job ${job.id}] Profiles: ${profiles.map((p) => p.label).join(', ')}`);

  // Each gen runs submit→poll as a unit. Sref jobs get up to SREF_MAX_RETRIES
  // resubmissions on moderation rejects before falling back to no-sref.
  // Gen 1 has no sref so it runs in parallel with Gen 2 & 3.
  let gridIndexCounter = 0;
  let completedGens = 0;

  const processGenResult = async (r) => {
    if (!r) return [];

    const wantedSref = r.genIndex >= 1 && !!srefs[r.genIndex - 1];
    const srefLost = wantedSref && !r.usedSref;
    if (srefLost) job.actualSrefs[r.genIndex] = null;

    const task = {
      concept: r.concept,
      genIndex: r.genIndex,
      usedSref: r.usedSref,
      srefLost,
    };

    const gridIdx = gridIndexCounter++;
    const images = await buildImagesFromGenResult(r.grid, task, gridIdx, profiles, job);
    completedGens++;

    if (onGenComplete && images.length > 0) {
      await onGenComplete(images);
    }

    return images;
  };

  const genPromises = job.concepts.map((c, i) => {
    const opts = { profile: profiles[i].tag };
    if (i >= 1) {
      const srefEntry = srefs[i - 1];
      if (srefEntry) {
        opts.sref = srefEntry.url;
        opts.sw = STYLE_WEIGHT;
      }
    }
    const label = `job ${job.id} Gen ${i + 1}`;
    return submitAndPollWithSrefRetry(c.prompt, opts, label)
      .then((result) => ({ ...result, concept: c, genIndex: i }))
      .catch((err) => {
        console.error(`[${label}] Failed entirely: ${err.message}`);
        return null;
      })
      .then(processGenResult);
  });

  const genImageBatches = await Promise.all(genPromises);
  const allImages = genImageBatches.flat();

  job.mjTaskIds = job.concepts.map((c) => c.prompt?.slice(0, 40) || 'unknown');
  console.log(`[job ${job.id}] ${completedGens}/${job.concepts.length} grids complete, ${allImages.length} images`);

  if (allImages.length === 0) {
    throw new Error('All Midjourney image generations failed');
  }

  if (completedGens < job.concepts.length) {
    const msg = `Only ${completedGens}/${job.concepts.length} image generations succeeded`;
    job.warnings.push(msg);
    console.warn(`[job ${job.id}] ${msg}`);
  }

  if (!onGenComplete) {
    allImages.forEach((img, idx) => { img.rawIndex = idx; });
    job.rawImages = allImages;
  }

  console.log(`[job ${job.id}] Prepared ${allImages.length} individual images`);
  return allImages;
}

// ---------------------------------------------------------------------------
// Stage 3 — Clog QC check (binary PASS/FAIL gate)
// ---------------------------------------------------------------------------
const QC_MODEL = CLAUDE_MODEL;

const QC_CONCURRENCY = 6;

async function qcLiteralAnchor(img, lockedAnchor, jobId) {
  if (!lockedAnchor?.noun) return true;

  let buf;
  let mediaType = 'image/jpeg';

  if (img.quadrantFile) {
    const qPath = join(QUADRANT_DIR, jobId, img.quadrantFile);
    buf = readFileSync(qPath);
  } else {
    const imgRes = await fetch(img.url);
    if (!imgRes.ok) throw new Error(`Failed to download image for literal QC: HTTP ${imgRes.status}`);
    buf = Buffer.from(await imgRes.arrayBuffer());
    const contentType = imgRes.headers.get('content-type') || 'image/png';
    mediaType = contentType.split(';')[0].trim();
  }

  const keywords = buildKeywordList(lockedAnchor.noun, lockedAnchor.keywords || []);
  const base64 = buf.toString('base64');

  const resp = await getAnthropic().messages.create({
    model: QC_MODEL,
    max_tokens: 5,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        },
        {
          type: 'text',
          text: `Is the dominant, unmistakable subject in this image clearly "${lockedAnchor.noun}" (acceptable related forms: ${keywords.join(', ')})? Ignore style treatment. Answer only YES or NO.`,
        },
      ],
    }],
  });

  const raw = resp.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return normalizeLiteralVerdict(raw);
}

async function qcOneImage(img, jobId, clogPrompt, lockedAnchor = null) {
  let verdict = 'ERROR';
  let reason = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let buf;
      let mediaType = 'image/jpeg';

      if (img.quadrantFile) {
        const qPath = join(QUADRANT_DIR, jobId, img.quadrantFile);
        buf = readFileSync(qPath);
      } else {
        const imgRes = await fetch(img.url);
        if (!imgRes.ok) throw new Error(`Failed to download image for QC: HTTP ${imgRes.status}`);
        buf = Buffer.from(await imgRes.arrayBuffer());
        const contentType = imgRes.headers.get('content-type') || 'image/png';
        mediaType = contentType.split(';')[0].trim();
      }

      const base64 = buf.toString('base64');

      const resp = await getAnthropic().messages.create({
        model: QC_MODEL,
        max_tokens: 10,
        system: clogPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: base64 },
              },
            ],
          },
        ],
      });

      const raw = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('')
        .trim();

      verdict = normalizeClogVerdict(raw);

      if (verdict === 'PASS' && lockedAnchor) {
        const literalOk = await qcLiteralAnchor(img, lockedAnchor, jobId);
        if (!literalOk) {
          verdict = 'FAIL';
          reason = `Literal anchor check failed: expected "${lockedAnchor.noun}"`;
          console.warn(`[job ${jobId}] ${reason} for concept "${img.concept}"`);
        }
      }
      break;
    } catch (err) {
      reason = err.message || 'QC check failed';
      console.error(`[job ${img.concept}] QC attempt ${attempt + 1} failed:`, reason);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }

  return { ...img, verdict, ...(verdict === 'ERROR' || reason ? { reason } : {}) };
}

async function runQcForImages(job, images, clogPrompt) {
  const results = [];
  for (let i = 0; i < images.length; i += QC_CONCURRENCY) {
    const batch = images.slice(i, i + QC_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((img) => qcOneImage(img, job.id, clogPrompt, job.lockedAnchor))
    );
    results.push(...batchResults);
  }

  for (const r of results) {
    if (r.verdict === 'PASS') job.approvedImages.push(r);
    else job.rejectedImages.push(r);
  }
  emitJobUpdate(job);
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------
async function runPipeline(job) {
  try {
    await generateThemes(job);
    emitJobUpdate(job);

    const clogPrompt = loadClogPrompt();
    const qcPromises = [];
    let firstGen = true;

    await generateAllImages(job, {
      onGenComplete: async (images) => {
        const startIdx = job.rawImages.length;
        images.forEach((img, i) => { img.rawIndex = startIdx + i; });
        job.rawImages.push(...images);

        if (firstGen) {
          setJobStage(job, 'images_ready');
          firstGen = false;
        } else {
          emitJobUpdate(job);
        }

        if (clogPrompt) {
          setJobStage(job, 'qc_check');
          qcPromises.push(
            runQcForImages(job, images, clogPrompt).catch((err) => {
              console.error(`[job ${job.id}] QC error for gen batch:`, err.message);
              for (const img of images) {
                job.rejectedImages.push({
                  ...img,
                  verdict: 'ERROR',
                  reason: err.message || 'QC batch failed',
                });
              }
              emitJobUpdate(job);
            })
          );
        } else {
          for (const img of images) {
            job.approvedImages.push({ ...img, verdict: 'skipped' });
          }
          emitJobUpdate(job);
        }
      },
    });

    if (clogPrompt) {
      await Promise.all(qcPromises);
    }

    setJobStage(job, 'complete');
    archiveJobImages(job).catch((err) =>
      console.error(`[job ${job.id}] Archive error:`, err.message)
    );
  } catch (err) {
    job.error = err?.message || String(err);
    setJobStage(job, 'error');
    console.error(`[job ${job.id}] Pipeline error:`, err);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/api/generate', (req, res) => {
  const { fundName, fundThesis, styleJson, useStyleBank, bypassMode: rawBypass, manualStyle, manualInterpretation } = req.body;

  const name = typeof fundName === 'string' ? fundName.trim() : '';
  if (!name) return res.status(400).json({ error: 'fundName is required' });
  if (name.length > 200) return res.status(400).json({ error: 'fundName too long' });

  const thesis = typeof fundThesis === 'string' ? fundThesis.trim() : '';
  if (thesis.length > 2000) return res.status(400).json({ error: 'fundThesis too long' });

  let mode = 'normal';
  if (typeof rawBypass === 'string' && VALID_BYPASS_MODES.includes(rawBypass)) {
    mode = rawBypass;
  } else if (useStyleBank === false) {
    mode = 'full-bypass';
  }

  const job = createJob(name, thesis, styleJson || null, mode);
  if (typeof manualStyle === 'string' && manualStyle.trim()) job.manualStyle = manualStyle.trim();
  if (typeof manualInterpretation === 'string' && manualInterpretation.trim()) job.manualInterpretation = manualInterpretation.trim();
  runPipeline(job);

  res.json({ jobId: job.id, stage: job.stage });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(serializeJobPayload(job));
});

app.get('/api/events/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  if (!jobSubscribers.has(job.id)) jobSubscribers.set(job.id, new Set());
  jobSubscribers.get(job.id).add(res);

  res.write(`data: ${JSON.stringify(serializeJobPayload(job))}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    jobSubscribers.get(job.id)?.delete(res);
    if (jobSubscribers.get(job.id)?.size === 0) jobSubscribers.delete(job.id);
  });
});

app.get('/api/results/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    stage: job.stage,
    fundName: job.fundName,
    fundThesis: job.fundThesis,
    bypassMode: job.bypassMode,
    assignedStyles: job.assignedStyles,
    assignedInterpretations: job.assignedInterpretations,
    assignedProfiles: job.assignedProfiles,
    actualSrefs: job.actualSrefs,
    profileTags: job.profileTags,
    genRatings: job.genRatings || {},
    concepts: job.concepts,
    approvedImages: job.approvedImages,
    rejectedImages: job.rejectedImages,
    rawImages: job.rawImages,
    error: job.error,
  });
});

app.post('/api/upscale', async (req, res) => {
  const { jobId, imageIndex } = req.body;
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const idx = parseInt(imageIndex, 10);
  if (isNaN(idx) || idx < 0 || idx >= job.rawImages.length) {
    return res.status(400).json({ error: 'Invalid imageIndex' });
  }

  const img = job.rawImages[idx];
  if (img.upscaled) {
    return res.json({ url: img.url, alreadyUpscaled: true });
  }

  if (!img.gridJobId || img.imageNo === undefined) {
    return res.status(400).json({ error: 'Image has no grid data for upscaling' });
  }

  try {
    console.log(`[job ${jobId}] Upscaling rawIndex=${idx} (grid=${img.gridJobId}, quadrant=${img.imageNo}, concept="${img.concept}")`);
    const upscaleJobId = await submitUpscale(img.gridJobId, img.imageNo);
    const upscaledUrl = await pollUpscaleJob(upscaleJobId);

    img.url = upscaledUrl;
    img.upscaled = true;

    const approved = job.approvedImages.find((a) => a.gridJobId === img.gridJobId && a.imageNo === img.imageNo);
    if (approved) { approved.url = upscaledUrl; approved.upscaled = true; }
    const rejected = job.rejectedImages.find((r) => r.gridJobId === img.gridJobId && r.imageNo === img.imageNo);
    if (rejected) { rejected.url = upscaledUrl; rejected.upscaled = true; }

    console.log(`[job ${jobId}] Upscaled image ${idx} successfully`);
    res.json({ url: upscaledUrl });
  } catch (err) {
    console.error(`[job ${jobId}] Upscale failed for image ${idx}:`, err.message);
    res.status(500).json({ error: err.message || 'Upscale failed' });
  }
});

// ---------------------------------------------------------------------------
// Ratings — rate a single component (style / interpretation / sref)
// ---------------------------------------------------------------------------
app.post('/api/rate', (req, res) => {
  const { jobId, genIndex, component, rating } = req.body;
  if (!['up', 'neutral', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'Rating must be up, neutral, or down' });
  }
  if (!['styles', 'interpretations', 'srefs'].includes(component)) {
    return res.status(400).json({ error: 'Component must be styles, interpretations, or srefs' });
  }
  const gi = parseInt(genIndex, 10);
  if (isNaN(gi) || gi < 0 || gi >= NUM_CONCEPTS) {
    return res.status(400).json({ error: 'Invalid genIndex' });
  }

  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or session expired' });

  const concept = job.concepts?.[gi];
  let key = null;
  if (component === 'styles') key = concept?.style || null;
  else if (component === 'interpretations') key = concept?.interpretation || null;
  else if (component === 'srefs') key = job.actualSrefs?.[gi] || null;

  if (!key) return res.status(400).json({ error: 'Component not available for this generation' });

  if (!job.genRatings) job.genRatings = {};
  if (!job.genRatings[gi]) job.genRatings[gi] = {};
  const prevRating = job.genRatings[gi][component];

  const ratings = loadRatings();
  if (!ratings[component]) ratings[component] = {};
  if (!ratings[component][key]) ratings[component][key] = { up: 0, down: 0, neutral: 0 };
  if (prevRating) {
    ratings[component][key][prevRating] = Math.max(0, (ratings[component][key][prevRating] || 0) - 1);
  }
  ratings[component][key][rating] = (ratings[component][key][rating] || 0) + 1;
  saveRatings(ratings);

  job.genRatings[gi][component] = rating;
  console.log(`[job ${jobId}] Gen ${gi + 1} ${component}: ${rating} (prev: ${prevRating || 'none'}) key="${key.slice(0, 40)}"`);

  res.json({ ok: true, genIndex: gi, component, rating, prevRating: prevRating || null });
});

app.get('/api/banks', (_req, res) => {
  res.json({
    styles: loadStyleBank(),
    interpretations: loadInterpretationBank(),
  });
});

// ---------------------------------------------------------------------------
// Settings API — Profile bank + Style Reference CRUD (settings password)
// ---------------------------------------------------------------------------
const srefUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// --- Profile Bank CRUD ---
app.get('/api/settings/profiles', (_req, res) => {
  res.json(PROFILE_BANK);
});

app.post('/api/settings/profiles', (req, res) => {
  const { label, tag } = req.body;
  if (!label || typeof label !== 'string') return res.status(400).json({ error: 'Label is required' });
  if (!tag || typeof tag !== 'string' || !tag.startsWith('--profile')) {
    return res.status(400).json({ error: 'Tag must start with --profile' });
  }
  PROFILE_BANK.push({ label: label.trim(), tag: tag.trim() });
  saveProfileBank(PROFILE_BANK);
  res.json({ ok: true, entry: { label: label.trim(), tag: tag.trim() } });
});

app.delete('/api/settings/profiles/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  if (isNaN(idx) || idx < 0 || idx >= PROFILE_BANK.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }
  const removed = PROFILE_BANK.splice(idx, 1)[0];
  saveProfileBank(PROFILE_BANK);
  res.json({ ok: true, removed: removed.label });
});

// --- Style Reference CRUD ---
app.get('/api/settings/sref', (_req, res) => {
  const bank = loadSrefBank();
  const protocol = _req.headers['x-forwarded-proto'] || _req.protocol;
  const baseUrl = `${protocol}://${_req.get('host')}`;
  const entries = bank.map((e, i) => ({
    index: i,
    name: e.name,
    filename: e.filename,
    url: `${baseUrl}/api/sref-image/${e.filename}`,
    addedAt: e.addedAt || null,
  }));
  res.json(entries);
});

app.post('/api/settings/sref', srefUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file provided' });

  const rawName = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!rawName) return res.status(400).json({ error: 'Name is required' });
  if (rawName.length > 100) return res.status(400).json({ error: 'Name too long' });
  const name = deduplicateSrefName(rawName);

  try {
    const slug = name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
    const uniqueId = crypto.randomUUID().slice(0, 8);
    const filename = `${slug}-${uniqueId}.jpg`;
    const srefDir = getSrefDir();
    const filepath = join(srefDir, filename);

    await sharp(req.file.buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(filepath);

    const bank = loadSrefBank();
    bank.push({ name, filename, addedAt: new Date().toISOString() });
    saveSrefBank(bank);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}`;
    res.json({
      ok: true,
      entry: { name, filename, url: `${baseUrl}/api/sref-image/${filename}` },
    });
  } catch (err) {
    console.error('[sref] Upload failed:', err.message);
    res.status(500).json({ error: 'Failed to process image' });
  }
});

app.delete('/api/settings/sref/:index', (req, res) => {
  const idx = parseInt(req.params.index, 10);
  const bank = loadSrefBank();
  if (isNaN(idx) || idx < 0 || idx >= bank.length) {
    return res.status(400).json({ error: 'Invalid index' });
  }

  const removed = bank.splice(idx, 1)[0];
  saveSrefBank(bank);

  const filepath = join(getSrefDir(), removed.filename);
  if (existsSync(filepath)) {
    try { unlinkSync(filepath); } catch {}
  }

  res.json({ ok: true, removed: removed.name });
});

app.post('/api/settings/sref-from-url', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.startsWith('http')) {
    return res.status(400).json({ error: 'Valid image URL is required' });
  }

  try {
    const imgRes = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
    const contentType = imgRes.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) throw new Error('URL did not return an image');
    const buffer = Buffer.from(await imgRes.arrayBuffer());

    const rawUrlName = url.split('/').pop().split('?')[0]
      .replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ').slice(0, 50).trim() || 'image';
    const urlName = deduplicateSrefName(rawUrlName);
    const slug = urlName.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 50);
    const uniqueId = crypto.randomUUID().slice(0, 8);
    const filename = `${slug}-${uniqueId}.jpg`;
    const srefDir = getSrefDir();
    const filepath = join(srefDir, filename);

    await sharp(buffer)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toFile(filepath);

    const bank = loadSrefBank();
    bank.push({ name: urlName, filename, addedAt: new Date().toISOString() });
    saveSrefBank(bank);

    const protocol = req.headers['x-forwarded-proto'] || req.protocol;
    const baseUrl = `${protocol}://${req.get('host')}`;
    res.json({
      ok: true,
      entry: { name: urlName, filename, url: `${baseUrl}/api/sref-image/${filename}` },
    });
  } catch (err) {
    console.error('[sref-from-url] Failed:', err.message);
    res.status(500).json({ error: err.message || 'Failed to fetch image from URL' });
  }
});

// --- Ratings analytics ---
app.get('/api/settings/ratings', (_req, res) => {
  const ratings = loadRatings();
  const activeProfiles = new Set(PROFILE_BANK.map((p) => p.tag));
  const activeSrefs = new Set(loadSrefBank().map((s) => s.name));
  const activeStyles = new Set(STYLE_BANK);
  const activeInterps = new Set(INTERPRETATION_BANK);

  function buildRanked(category, activeSet) {
    const entries = ratings[category] || {};
    return Object.entries(entries)
      .filter(([key, v]) => activeSet.has(key) && ((v.up || 0) + (v.down || 0) + (v.neutral || 0) > 0))
      .map(([key, v]) => ({
        key,
        up: v.up || 0,
        down: v.down || 0,
        neutral: v.neutral || 0,
        score: Math.max(1, 10 + (v.up || 0) * 2 - (v.down || 0) * 3),
      }))
      .sort((a, b) => b.score - a.score || b.up - a.up);
  }

  res.json({
    styles: buildRanked('styles', activeStyles),
    interpretations: buildRanked('interpretations', activeInterps),
    profiles: buildRanked('profiles', activeProfiles),
    srefs: buildRanked('srefs', activeSrefs),
  });
});

// --- Sref image serve (public — Midjourney needs access) ---
app.get('/api/sref-image/:filename', (req, res) => {
  const requested = req.params.filename;
  const safe = basename(requested);
  if (safe !== requested || !requested) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const filepath = join(getSrefDir(), safe);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.type('image/jpeg').sendFile(filepath);
});

app.get('/api/sref-zip', (req, res) => {
  try {
    const srefDir = getSrefDir();
    const files = readdirSync(srefDir).filter((f) => /\.(jpg|jpeg|png|webp)$/i.test(f));
    if (files.length === 0) return res.status(404).json({ error: 'No sref images found' });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="sref-images.zip"');

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('error', (err) => {
      console.error('[sref-zip] archiver error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);
    for (const f of files) {
      archive.file(join(srefDir, f), { name: f });
    }
    archive.finalize();
  } catch (err) {
    console.error('[sref-zip] unexpected error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
  }
});

app.get('/api/quadrant/:jobId/:filename', (req, res) => {
  const { jobId, filename } = req.params;
  const safeJobId = basename(jobId);
  const safeFile = basename(filename);
  if (safeJobId !== jobId || safeFile !== filename || !filename) {
    return res.status(400).json({ error: 'Invalid path' });
  }
  const filepath = join(QUADRANT_DIR, safeJobId, safeFile);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.type('image/jpeg').sendFile(filepath);
});

// ---------------------------------------------------------------------------
// Image archive — download and persist every generated image
// ---------------------------------------------------------------------------

let historyCache = null;

function loadHistory() {
  if (historyCache) return historyCache;
  try {
    historyCache = JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    historyCache = [];
  }
  return historyCache;
}

function saveHistory(entries) {
  historyCache = entries;
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

const MAX_FILE_BYTES = 4.99 * 1024 * 1024;

async function compressIfNeeded(filepath) {
  const size = statSync(filepath).size;
  if (size <= MAX_FILE_BYTES) return filepath;

  console.log(`[archive] File ${basename(filepath)} is ${(size / 1024 / 1024).toFixed(2)} MB, compressing...`);
  const outPath = filepath.replace(/\.\w+$/, '.jpg');
  const tmpPath = outPath + '.tmp';
  const srcBuffer = readFileSync(filepath);
  const meta = await sharp(srcBuffer).metadata();
  const srcWidth = meta.width || 2048;

  let quality = 90;
  let scale = 1.0;

  for (let attempt = 0; attempt < 6; attempt++) {
    let pipeline = sharp(srcBuffer);
    if (scale < 1.0) {
      pipeline = pipeline.resize(Math.round(srcWidth * scale), null, { fit: 'inside' });
    }
    await pipeline.jpeg({ quality, mozjpeg: true }).toFile(tmpPath);

    const newSize = statSync(tmpPath).size;
    if (newSize <= MAX_FILE_BYTES) {
      if (outPath !== filepath && existsSync(filepath)) unlinkSync(filepath);
      renameSync(tmpPath, outPath);
      console.log(`[archive] Compressed to ${(newSize / 1024 / 1024).toFixed(2)} MB (q${quality}, ${Math.round(scale * 100)}%)`);
      return outPath;
    }

    if (quality > 70) {
      quality -= 5;
    } else {
      scale -= 0.1;
    }
  }

  if (existsSync(tmpPath)) {
    if (outPath !== filepath && existsSync(filepath)) unlinkSync(filepath);
    renameSync(tmpPath, outPath);
  }
  console.warn(`[archive] Could not compress below ${MAX_FILE_BYTES} bytes after 6 attempts`);
  return outPath;
}

async function archiveImage(img, fundName, jobId) {
  const ts = Date.now();
  const uniqueId = crypto.randomUUID().slice(0, 8);
  const slug = (img.concept || 'image').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const ext = img.quadrantFile && !img.upscaled ? '.jpg' : '.png';
  let filename = `${ts}-${uniqueId}-${slug}${ext}`;
  let filepath = join(ARCHIVE_DIR, filename);

  try {
    if (img.quadrantFile && !img.upscaled) {
      const qPath = join(QUADRANT_DIR, jobId, img.quadrantFile);
      copyFileSync(qPath, filepath);
    } else {
      const isLocalUrl = img.url?.startsWith('/');
      const srcUrl = img.upscaled ? img.url : (isLocalUrl ? (img.gridUrl || img.url) : img.url);
      const res = await fetch(srcUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) throw new Error('Empty response body');
      await streamPipeline(res.body, createWriteStream(filepath));
    }
  } catch (err) {
    console.error(`[archive] Failed to save ${img.url}:`, err.message);
    return null;
  }

  try {
    filepath = await compressIfNeeded(filepath);
    filename = basename(filepath);
  } catch (err) {
    console.error(`[archive] Compression error:`, err.message);
  }

  const dlExt = filename.endsWith('.jpg') ? '.jpg' : '.png';
  try {
    const dlBase = `${fundName.replace(/[^a-z0-9]+/gi, '-')}-${slug}`;
    let dlFilename = `${dlBase}${dlExt}`;
    let version = 1;
    while (existsSync(join(DOWNLOADS_DIR, dlFilename)) && version < 1000) {
      version++;
      dlFilename = `${dlBase}-${version}${dlExt}`;
    }
    copyFileSync(filepath, join(DOWNLOADS_DIR, dlFilename));
    console.log(`[archive] Saved to Downloads: ${dlFilename}`);
  } catch (err) {
    console.error(`[archive] Failed to copy to Downloads:`, err.message);
  }

  const entry = {
    id: crypto.randomUUID(),
    jobId,
    fundName,
    concept: img.concept || null,
    prompt: img.prompt || null,
    style: img.style || null,
    interpretation: img.interpretation || null,
    verdict: img.verdict || null,
    originalUrl: img.url,
    filename,
    archivedAt: new Date().toISOString(),
  };

  const history = loadHistory();
  history.unshift(entry);
  saveHistory(history);

  return entry;
}

async function archiveJobImages(job) {
  const allImages = [...job.approvedImages, ...job.rejectedImages];
  for (const img of allImages) {
    await archiveImage(img, job.fundName, job.id);
  }
}

app.get('/api/history', (_req, res) => {
  const history = loadHistory().filter(
    (h) => h.filename && existsSync(join(ARCHIVE_DIR, h.filename))
  );
  res.json(history);
});

app.get('/api/archive-zip', (_req, res) => {
  try {
    const history = loadHistory().filter(
      (h) => h.filename && existsSync(join(ARCHIVE_DIR, h.filename))
    );
    if (history.length === 0) return res.status(404).json({ error: 'No archived images found' });

    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', 'attachment; filename="archive-all-images.zip"');

    const archive = new ZipArchive({ zlib: { level: 1 } });
    archive.on('error', (err) => {
      console.error('[archive-zip] archiver error:', err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    archive.pipe(res);
    for (const h of history) {
      const fp = join(ARCHIVE_DIR, h.filename);
      if (existsSync(fp)) archive.file(fp, { name: h.filename });
    }
    archive.finalize();
  } catch (err) {
    console.error('[archive-zip] unexpected error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to create zip' });
  }
});

app.get('/api/archive/:filename', (req, res) => {
  const requested = req.params.filename;
  const safe = basename(requested);
  if (safe !== requested || !requested) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  const filepath = join(ARCHIVE_DIR, safe);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  const sanitizedName = safe.replace(/["\r\n]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${sanitizedName}"`);
  res.sendFile(filepath);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, () => {
  console.log(`Fund Image Gen running at http://localhost:${PORT}`);
});

function shutdown() {
  console.log('\nShutting down...');
  clearInterval(pruneTimer);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
