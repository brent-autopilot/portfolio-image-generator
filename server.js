import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { pipeline as streamPipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.use(express.json({ limit: '1mb' }));

const PORT = process.env.PORT || 3000;
const SITE_PASSWORD = process.env.SITE_PASSWORD || 'autopilot';

// ---------------------------------------------------------------------------
// Auth — simple password gate with HMAC session token
// ---------------------------------------------------------------------------
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.randomBytes(32).toString('hex');

function makeToken(password) {
  return crypto.createHmac('sha256', AUTH_SECRET).update(password).digest('hex');
}

const VALID_TOKEN = makeToken(SITE_PASSWORD);

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

// Serve static files (login page is always accessible)
app.use(express.static(join(__dirname, 'public')));

// Protect all other API routes
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth')) return next();
  if (!isAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
});

const LEGNEXT_BASE = 'https://api.legnext.ai/api/v1';
const NUM_CONCEPTS = 3;
const JOB_TTL_MS = 30 * 60 * 1000;
const JOB_PRUNE_INTERVAL_MS = 5 * 60 * 1000;
const MAX_POLL_ATTEMPTS = 60;
const POLL_INTERVAL_MS = 5000;

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

function loadStyleBank() {
  const raw = readFileSync(join(__dirname, 'prompts', 'style-bank.md'), 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^[a-zA-Z]/.test(l));
}

const STYLE_BANK = loadStyleBank();

function pickRandomStyles(count) {
  const pool = [...STYLE_BANK];
  const picks = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function loadInterpretationBank() {
  const raw = readFileSync(join(__dirname, 'prompts', 'interpretation-bank.md'), 'utf-8');
  return raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && /^[a-zA-Z]/.test(l));
}

const INTERPRETATION_BANK = loadInterpretationBank();

function pickRandomInterpretations(count) {
  const pool = [...INTERPRETATION_BANK];
  const picks = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function loadClogPrompt() {
  try {
    const raw = readFileSync(join(__dirname, 'prompts', 'clog-qc.md'), 'utf-8');
    if (raw.startsWith('# PLACEHOLDER')) return null;
    if (raw.trim().length < 100) return null;
    return raw;
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

function createJob(fundName, fundThesis, styleJson, useStyleBank = true) {
  const id = crypto.randomUUID();
  const job = {
    id,
    fundName,
    fundThesis,
    styleJson,
    useStyleBank,
    stage: 'queued',
    assignedStyles: [],
    assignedInterpretations: [],
    concepts: [],
    mjTaskIds: [],
    rawImages: [],
    approvedImages: [],
    rejectedImages: [],
    error: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function pruneExpiredJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.createdAt < cutoff) jobs.delete(id);
  }
}

const pruneTimer = setInterval(pruneExpiredJobs, JOB_PRUNE_INTERVAL_MS);
pruneTimer.unref();

// ---------------------------------------------------------------------------
// Stage 1 — Claude Sonnet: generate 3 distinct 15-word image prompts
// ---------------------------------------------------------------------------
async function generateThemes(job) {
  job.stage = 'generating_theme';

  const styleContext = job.styleJson
    ? `\n\nUse this visual style JSON for atmospheric tone only:\n${JSON.stringify(job.styleJson, null, 2)}`
    : '';

  const thesis = job.fundThesis || job.fundName;

  let directivesParagraph = '';
  let extraReturnFields = '';

  if (job.useStyleBank) {
    const styles = pickRandomStyles(NUM_CONCEPTS);
    const interpretations = pickRandomInterpretations(NUM_CONCEPTS);
    job.assignedStyles = styles;
    job.assignedInterpretations = interpretations;
    console.log(`[job ${job.id}] Assigned styles:`, styles);
    console.log(`[job ${job.id}] Assigned interpretations:`, interpretations);

    const directives = styles
      .map((s, i) => `  Concept ${i + 1} style: "${s}"\n  Concept ${i + 1} interpretation: "${interpretations[i]}"`)
      .join('\n');

    directivesParagraph = `\n\nEach concept has been assigned a mandatory visual style AND a mandatory interpretation angle.

Style defines the artistic treatment — the medium, technique, or rendering approach for the image.
Interpretation defines the conceptual approach — what to depict, what angle to take, how to think about the fund.

You MUST use BOTH for each concept. The interpretation angle overrides your default instinct about what to depict — follow it even if it leads somewhere unexpected:

${directives}

The style must be baked into the prompt itself, not appended as a tag. The interpretation must shape WHAT you depict, not just how you describe it.`;

    extraReturnFields = '\n- "style": the assigned style directive (echo it back exactly)\n- "interpretation": the assigned interpretation angle (echo it back exactly)';
  } else {
    console.log(`[job ${job.id}] Style bank disabled`);
  }

  const resp = await getAnthropic().messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: THEME_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `**FUND NAME:** ${job.fundName}\n**FUND THESIS:** ${thesis}${styleContext}

Generate exactly ${NUM_CONCEPTS} completely different image concepts for this fund. Each concept must use a different visual metaphor, subject, and scene — no overlap.${directivesParagraph}

CRITICAL CONSTRAINT: Each prompt must be 15 words or fewer. Write tight, vivid, cinematic descriptions. No filler words. Every word earns its place.

Return your response as a JSON array of exactly ${NUM_CONCEPTS} objects, each with:
- "concept": a 2-3 word label for the concept
- "prompt": the image generation prompt (15 words max)${extraReturnFields}

Return ONLY the JSON array, no other text.`,
      },
    ],
  });

  const raw = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  let concepts;
  try {
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    concepts = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
  } catch {
    throw new Error(`Failed to parse Claude response as JSON: ${raw.slice(0, 200)}`);
  }

  if (!Array.isArray(concepts)) {
    throw new Error(`Claude returned non-array: ${raw.slice(0, 200)}`);
  }

  const valid = concepts
    .filter((c) => c && typeof c.concept === 'string' && typeof c.prompt === 'string')
    .slice(0, NUM_CONCEPTS);

  if (valid.length === 0) {
    throw new Error(`Claude returned no valid concepts. Raw: ${raw.slice(0, 300)}`);
  }

  job.concepts = valid;
  console.log(`[job ${job.id}] Generated ${job.concepts.length} concepts:`);
  job.concepts.forEach((c, i) => console.log(`  ${i + 1}. [${c.concept}] ${c.prompt}`));

  return job.concepts;
}

// ---------------------------------------------------------------------------
// Stage 2 — LegNext.ai / Midjourney
// ---------------------------------------------------------------------------
async function submitMidjourneyJob(prompt) {
  const apiKey = process.env.LEGNEXT_API_KEY;
  if (!apiKey) throw new Error('LEGNEXT_API_KEY not configured');

  const pTag = process.env.P_TAG || '';
  const fullPrompt = pTag ? `${prompt} ${pTag}` : prompt;

  const res = await fetch(`${LEGNEXT_BASE}/diffusion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({ text: fullPrompt }),
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

async function pollSingleJob(jobId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await fetchMidjourneyResult(jobId);

    if (result.status === 'completed') {
      const allImages = result.output?.image_urls || [];
      const gridImage = result.output?.image_url;
      return allImages.length > 0 ? allImages[0] : gridImage || null;
    }

    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Midjourney task failed');
    }
  }

  throw new Error('Midjourney task timed out after polling');
}

async function generateAllImages(job) {
  job.stage = 'generating_images';

  const submissionResults = await Promise.allSettled(
    job.concepts.map((c) => submitMidjourneyJob(c.prompt))
  );

  const tasks = [];
  for (let i = 0; i < submissionResults.length; i++) {
    const result = submissionResults[i];
    if (result.status === 'fulfilled') {
      tasks.push({ taskId: result.value, concept: job.concepts[i] });
    } else {
      console.error(`[job ${job.id}] Failed to submit concept "${job.concepts[i].concept}":`, result.reason?.message);
    }
  }

  job.mjTaskIds = tasks.map((t) => t.taskId);
  console.log(`[job ${job.id}] Submitted ${tasks.length}/${job.concepts.length} MJ tasks`);

  if (tasks.length === 0) {
    throw new Error('All Midjourney submissions failed');
  }

  const pollResults = await Promise.allSettled(
    tasks.map((t) =>
      pollSingleJob(t.taskId).then((url) => ({
        url,
        concept: t.concept.concept,
        prompt: t.concept.prompt,
        style: t.concept.style || null,
        interpretation: t.concept.interpretation || null,
      }))
    )
  );

  job.rawImages = pollResults
    .filter((r) => r.status === 'fulfilled' && r.value.url)
    .map((r) => r.value);

  pollResults
    .filter((r) => r.status === 'rejected')
    .forEach((r) => console.error(`[job ${job.id}] MJ poll failed:`, r.reason?.message));

  if (job.rawImages.length === 0) {
    throw new Error('All Midjourney image generations failed');
  }

  console.log(`[job ${job.id}] Got ${job.rawImages.length} images back`);
  return job.rawImages;
}

// ---------------------------------------------------------------------------
// Stage 3 — Clog QC check (binary PASS/FAIL gate)
// ---------------------------------------------------------------------------
const QC_MODEL = 'claude-sonnet-4-20250514';

async function runClogCheck(job) {
  const clogPrompt = loadClogPrompt();
  if (!clogPrompt) {
    job.stage = 'complete';
    job.approvedImages = job.rawImages.map((img) => ({
      ...img,
      verdict: 'skipped',
    }));
    return;
  }

  job.stage = 'qc_check';

  const results = await Promise.allSettled(
    job.rawImages.map(async (img) => {
      const imgRes = await fetch(img.url);
      if (!imgRes.ok) throw new Error(`Failed to download image for QC: HTTP ${imgRes.status}`);
      const buf = Buffer.from(await imgRes.arrayBuffer());
      const base64 = buf.toString('base64');

      const contentType = imgRes.headers.get('content-type') || 'image/png';
      const mediaType = contentType.split(';')[0].trim();

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

      const verdict = raw === 'PASS' ? 'PASS' : 'FAIL';
      return { ...img, verdict };
    })
  );

  const approved = [];
  const rejected = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      if (result.value.verdict === 'PASS') {
        approved.push(result.value);
      } else {
        rejected.push(result.value);
      }
    } else {
      const failedImg = job.rawImages[i];
      console.error(`[job ${job.id}] QC error for ${failedImg?.concept}:`, result.reason?.message);
      rejected.push({
        ...failedImg,
        verdict: 'ERROR',
        reason: result.reason?.message || 'QC check failed',
      });
    }
  }

  job.approvedImages = approved;
  job.rejectedImages = rejected;
  job.stage = 'complete';
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------
async function runPipeline(job) {
  try {
    await generateThemes(job);
    await generateAllImages(job);
    await runClogCheck(job);
    archiveJobImages(job).catch((err) =>
      console.error(`[job ${job.id}] Archive error:`, err.message)
    );
  } catch (err) {
    job.stage = 'error';
    job.error = err.message;
    console.error(`[job ${job.id}] Pipeline error:`, err);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/api/generate', (req, res) => {
  const { fundName, fundThesis, styleJson, useStyleBank } = req.body;

  const name = typeof fundName === 'string' ? fundName.trim() : '';
  if (!name) return res.status(400).json({ error: 'fundName is required' });
  if (name.length > 200) return res.status(400).json({ error: 'fundName too long' });

  const thesis = typeof fundThesis === 'string' ? fundThesis.trim() : '';
  if (thesis.length > 2000) return res.status(400).json({ error: 'fundThesis too long' });

  const styleBankEnabled = useStyleBank === true || useStyleBank === undefined;
  const job = createJob(name, thesis, styleJson || null, styleBankEnabled);
  runPipeline(job);

  res.json({ jobId: job.id, stage: job.stage });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    stage: job.stage,
    fundName: job.fundName,
    fundThesis: job.fundThesis,
    useStyleBank: job.useStyleBank,
    assignedStyles: job.assignedStyles,
    assignedInterpretations: job.assignedInterpretations,
    concepts: job.concepts,
    mjTaskIds: job.mjTaskIds,
    rawImageCount: job.rawImages.length,
    approvedCount: job.approvedImages.length,
    rejectedCount: job.rejectedImages.length,
    error: job.error,
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
    useStyleBank: job.useStyleBank,
    assignedStyles: job.assignedStyles,
    assignedInterpretations: job.assignedInterpretations,
    concepts: job.concepts,
    approvedImages: job.approvedImages,
    rejectedImages: job.rejectedImages,
    rawImages: job.rawImages,
    error: job.error,
  });
});

// ---------------------------------------------------------------------------
// Image archive — download and persist every generated image
// ---------------------------------------------------------------------------
const ARCHIVE_DIR = join(__dirname, 'archive');
const HISTORY_FILE = join(ARCHIVE_DIR, 'history.json');
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads');

if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

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

async function archiveImage(img, fundName, jobId) {
  const ts = Date.now();
  const uniqueId = crypto.randomUUID().slice(0, 8);
  const slug = (img.concept || 'image').replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 60);
  const filename = `${ts}-${uniqueId}-${slug}.png`;
  const filepath = join(ARCHIVE_DIR, filename);

  try {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body) throw new Error('Empty response body');
    await streamPipeline(res.body, createWriteStream(filepath));
  } catch (err) {
    console.error(`[archive] Failed to download ${img.url}:`, err.message);
    return null;
  }

  try {
    const dlBase = `${fundName.replace(/[^a-z0-9]+/gi, '-')}-${slug}`;
    let dlFilename = `${dlBase}.png`;
    let version = 1;
    while (existsSync(join(DOWNLOADS_DIR, dlFilename)) && version < 1000) {
      version++;
      dlFilename = `${dlBase}-${version}.png`;
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
