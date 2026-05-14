import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, statSync, unlinkSync, renameSync, rmSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { pipeline as streamPipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';
import sharp from 'sharp';

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
  const pool = [...STYLE_BANK];
  const picks = [];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picks.push(pool.splice(idx, 1)[0]);
  }
  return picks;
}

function loadInterpretationBank() {
  return loadBank(join(__dirname, 'prompts', 'interpretation-bank.md'));
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
// Stage 1 — Claude Sonnet: generate 3 distinct 15-word image prompts
// ---------------------------------------------------------------------------
async function generateThemes(job) {
  job.stage = 'generating_theme';

  const styleContext = job.styleJson
    ? `\n\nUse this visual style JSON for atmospheric tone only:\n${JSON.stringify(job.styleJson, null, 2)}`
    : '';

  const thesis = job.fundThesis && job.fundThesis.trim()
    ? job.fundThesis.trim()
    : `A fund called "${job.fundName}" — use the name itself to infer the investment thesis and visual subject`;

  let directivesParagraph = '';
  let extraReturnFields = '';

  if (job.useStyleBank) {
    const styles = job.manualStyle
      ? Array(NUM_CONCEPTS).fill(job.manualStyle)
      : pickRandomStyles(NUM_CONCEPTS);
    const interpretations = job.manualInterpretation
      ? Array(NUM_CONCEPTS).fill(job.manualInterpretation)
      : pickRandomInterpretations(NUM_CONCEPTS);
    job.assignedStyles = styles;
    job.assignedInterpretations = interpretations;
    console.log(`[job ${job.id}] Assigned styles:`, styles);
    console.log(`[job ${job.id}] Assigned interpretations:`, interpretations);

    const directives = styles
      .map((s, i) => `  Concept ${i + 1} style: "${s}"\n  Concept ${i + 1} interpretation: "${interpretations[i]}"`)
      .join('\n');

    directivesParagraph = `\n\nEach concept has been assigned a mandatory visual style AND a mandatory interpretation angle.

Style defines the artistic treatment — the medium, technique, or rendering approach.
Interpretation defines the creative angle — how to THINK about the fund thesis when choosing what to depict.

You MUST use BOTH for each concept:

${directives}

CRITICAL RULES:
- The style controls HOW the image looks (medium, texture, lighting, color). Bake it into the prompt naturally. If the style mentions specific objects, treat those as material/textural references, not literal subjects.
- The interpretation shapes your creative angle — but the resulting image must still be clearly about the fund thesis. If the interpretation pulls you away from the fund's subject, you've gone too far. Pull it back. Example: for a mortgage fund, "interpret through architecture" should show mortgage-related architecture (foreclosed house, bank vault), not unrelated buildings.
- The fund thesis is ALWAYS the source of the subject matter. No exceptions.`;

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
        content: `THE FUND (this is the most important input — everything else serves this):

  FUND NAME: "${job.fundName}"
  FUND THESIS: "${thesis}"

Read the fund name and thesis carefully. What does this fund actually DO? What is it about? What would a normal person picture when they hear this name? That mental image is the foundation of every prompt you write. Nothing — no style, no interpretation, no creative angle — overrides this.

ANCHOR RULE: Identify the OBVIOUS visual subject from the fund name/thesis FIRST.
- "Silver" → silver metal, silver material, silver color
- "Voyage Fund" → a ship, a journey, open water
- "Hedge the AI Bubble" → a bubble, something being hedged
- "Photonics" → light, optics, photons, lenses, fiber
This anchor subject MUST be the dominant, recognizable element in every single prompt. If someone saw only the image with no label, they should intuitively connect it to the fund.${directivesParagraph}

Generate exactly ${NUM_CONCEPTS} completely different image concepts. Each must use a different visual metaphor, subject, and scene — no overlap. But ALL must clearly be about this fund.

HIERARCHY OF IMPORTANCE:
1. THE FUND (anchor subject from fund name/thesis) — non-negotiable, always dominant
2. THE INTERPRETATION (creative angle) — shapes how you approach the anchor, never replaces it
3. THE STYLE (rendering treatment) — controls how it looks, never changes what it depicts

PROMPT LENGTH: 20-45 words. Vary naturally — some concepts need more detail, some are stronger spare. Include: style/medium, anchor subject, action or state, atmospheric detail. Add a second visual detail if it strengthens the image. NO narrative sentences — use evocative fragments separated by commas. Every word must earn its place.${styleContext}

Return your response as a JSON array of exactly ${NUM_CONCEPTS} objects, each with:
- "anchor": the obvious visual subject from the fund name (1-3 words, e.g. "silver metal" or "ship at sea") — state this BEFORE writing the prompt
- "concept": a 2-3 word label for your creative angle on the anchor
- "prompt": the Midjourney image prompt (20-45 words, evocative fragments not sentences) — the anchor subject MUST be the dominant element${extraReturnFields}

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
const MJ_PROFILE_CARTER = '--profile ptxxc2l';
const MJ_PROFILE_BRENT = '--profile zc5okgy';

async function submitMidjourneyJob(prompt, { profile = null } = {}) {
  const apiKey = process.env.LEGNEXT_API_KEY;
  if (!apiKey) throw new Error('LEGNEXT_API_KEY not configured');

  const pTag = process.env.P_TAG || '';
  const profileSuffix = profile ? ` ${profile}` : '';
  const fullPrompt = pTag ? `${prompt} ${pTag}${profileSuffix}` : `${prompt}${profileSuffix}`;

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

async function pollGridJob(jobId) {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await fetchMidjourneyResult(jobId);

    if (result.status === 'completed') {
      const imageUrl = result.output?.image_url || (result.output?.image_urls?.[0]) || null;
      return { jobId, imageUrl };
    }

    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Midjourney task failed');
    }
  }

  throw new Error('Midjourney task timed out after polling');
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

  const files = [];
  for (let q = 0; q < 4; q++) {
    const filename = `grid${gridIndex}-q${q}.jpg`;
    const filepath = join(jobDir, filename);
    await sharp(buffer)
      .extract({ left: quadrants[q].left, top: quadrants[q].top, width: halfW, height: halfH })
      .jpeg({ quality: 92 })
      .toFile(filepath);
    files.push(filename);
  }

  return files;
}

async function generateAllImages(job) {
  job.stage = 'generating_images';

  const submissionResults = await Promise.allSettled(
    job.concepts.map((c, i) => submitMidjourneyJob(c.prompt, { profile: i < 2 ? MJ_PROFILE_CARTER : MJ_PROFILE_BRENT }))
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

  const gridResults = await Promise.allSettled(
    tasks.map((t) => pollGridJob(t.taskId))
  );

  console.log(`[job ${job.id}] Grids complete, cropping quadrants...`);

  const allImages = [];

  for (let i = 0; i < gridResults.length; i++) {
    if (gridResults[i].status === 'rejected') {
      console.error(`[job ${job.id}] Grid poll failed for "${tasks[i].concept.concept}":`, gridResults[i].reason?.message);
      continue;
    }

    const { jobId: gridJobId, imageUrl } = gridResults[i].value;
    const concept = tasks[i].concept;

    if (!imageUrl) {
      console.error(`[job ${job.id}] No image URL for grid "${concept.concept}"`);
      continue;
    }

    try {
      const quadrantFiles = await cropGridToQuadrants(imageUrl, job.id, i);
      for (let q = 0; q < quadrantFiles.length; q++) {
        allImages.push({
          rawIndex: allImages.length,
          url: `/api/quadrant/${job.id}/${quadrantFiles[q]}`,
          gridUrl: imageUrl,
          gridJobId,
          imageNo: q,
          quadrantFile: quadrantFiles[q],
          upscaled: false,
          concept: concept.concept,
          prompt: concept.prompt,
          style: concept.style || null,
          interpretation: concept.interpretation || null,
        });
      }
    } catch (err) {
      console.error(`[job ${job.id}] Failed to crop grid for "${concept.concept}":`, err.message);
    }
  }

  job.rawImages = allImages;

  if (job.rawImages.length === 0) {
    throw new Error('All Midjourney image generations failed');
  }

  console.log(`[job ${job.id}] Cropped ${job.rawImages.length} individual images`);
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

  const approved = [];
  const rejected = [];

  for (const img of job.rawImages) {
    let verdict = 'ERROR';
    let reason = '';

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let buf;
        let mediaType = 'image/jpeg';

        if (img.quadrantFile) {
          const qPath = join(QUADRANT_DIR, job.id, img.quadrantFile);
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

        verdict = raw === 'PASS' ? 'PASS' : 'FAIL';
        break;
      } catch (err) {
        reason = err.message || 'QC check failed';
        console.error(`[job ${img.concept}] QC attempt ${attempt + 1} failed:`, reason);
        if (attempt < 2) await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
    }

    const entry = { ...img, verdict, ...(verdict === 'ERROR' ? { reason } : {}) };
    if (verdict === 'PASS') approved.push(entry);
    else rejected.push(entry);
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
    job.stage = 'images_ready';
    runQcInBackground(job);
  } catch (err) {
    job.stage = 'error';
    job.error = err.message;
    console.error(`[job ${job.id}] Pipeline error:`, err);
  }
}

async function runQcInBackground(job) {
  try {
    await runClogCheck(job);
    archiveJobImages(job).catch((err) =>
      console.error(`[job ${job.id}] Archive error:`, err.message)
    );
  } catch (err) {
    console.error(`[job ${job.id}] QC error:`, err.message);
    job.approvedImages = job.rawImages.map((img) => ({ ...img, verdict: 'skipped' }));
    job.rejectedImages = [];
    job.stage = 'complete';
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
app.post('/api/generate', (req, res) => {
  const { fundName, fundThesis, styleJson, useStyleBank, manualStyle, manualInterpretation } = req.body;

  const name = typeof fundName === 'string' ? fundName.trim() : '';
  if (!name) return res.status(400).json({ error: 'fundName is required' });
  if (name.length > 200) return res.status(400).json({ error: 'fundName too long' });

  const thesis = typeof fundThesis === 'string' ? fundThesis.trim() : '';
  if (thesis.length > 2000) return res.status(400).json({ error: 'fundThesis too long' });

  const styleBankEnabled = useStyleBank === true || useStyleBank === undefined;
  const job = createJob(name, thesis, styleJson || null, styleBankEnabled);
  if (typeof manualStyle === 'string' && manualStyle.trim()) job.manualStyle = manualStyle.trim();
  if (typeof manualInterpretation === 'string' && manualInterpretation.trim()) job.manualInterpretation = manualInterpretation.trim();
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
    rawImages: job.rawImages,
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

app.get('/api/banks', (_req, res) => {
  res.json({
    styles: loadStyleBank(),
    interpretations: loadInterpretationBank(),
  });
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
const ARCHIVE_DIR = join(__dirname, 'archive');
const QUADRANT_DIR = join(__dirname, 'quadrants');
const HISTORY_FILE = join(ARCHIVE_DIR, 'history.json');
const DOWNLOADS_DIR = join(os.homedir(), 'Downloads');

if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });
if (!existsSync(QUADRANT_DIR)) mkdirSync(QUADRANT_DIR, { recursive: true });

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
      const srcUrl = img.upscaled ? img.url : (img.gridUrl || img.url);
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
