import 'dotenv/config';
import express from 'express';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { pipeline as streamPipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const LEGNEXT_BASE = 'https://api.legnext.ai/api/v1';
const NUM_CONCEPTS = 3;

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
const visualThesisPrompt = readFileSync(
  join(__dirname, 'prompts', 'visual-thesis.md'),
  'utf-8'
);

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

// Extract just the system prompt block from the visual-thesis markdown
function extractSystemPrompt(md) {
  const match = md.match(/```\n([\s\S]*?)```/);
  return match ? match[1].trim() : md;
}

const THEME_SYSTEM_PROMPT = extractSystemPrompt(visualThesisPrompt);

// ---------------------------------------------------------------------------
// In-memory job store
// ---------------------------------------------------------------------------
const jobs = new Map();

function createJob(fundName, fundThesis, styleJson) {
  const id = crypto.randomUUID();
  const job = {
    id,
    fundName,
    fundThesis,
    styleJson,
    stage: 'queued',
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

// ---------------------------------------------------------------------------
// Stage 1 — Claude Sonnet: generate 3 distinct 15-word image prompts
// ---------------------------------------------------------------------------
async function generateThemes(job) {
  job.stage = 'generating_theme';

  const anthropic = new Anthropic();

  const styleContext = job.styleJson
    ? `\n\nUse this visual style JSON for atmospheric tone only:\n${JSON.stringify(job.styleJson, null, 2)}`
    : '';

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: THEME_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `**FUND NAME:** ${job.fundName}\n**FUND THESIS:** ${job.fundThesis || job.fundName}${styleContext}

Generate exactly ${NUM_CONCEPTS} completely different image concepts for this fund. Each concept must use a different visual metaphor, subject, and scene — no overlap.

CRITICAL CONSTRAINT: Each prompt must be 15 words or fewer. Write tight, vivid, cinematic descriptions. No filler words. Every word earns its place.

Return your response as a JSON array of exactly ${NUM_CONCEPTS} objects, each with:
- "concept": a 2-3 word label for the concept
- "prompt": the image generation prompt (15 words max)

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
  const pTag = process.env.P_TAG || '';
  const fullPrompt = pTag ? `${prompt} ${pTag}` : prompt;

  const res = await fetch(`${LEGNEXT_BASE}/diffusion`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.LEGNEXT_API_KEY,
    },
    body: JSON.stringify({ text: fullPrompt }),
  });

  const data = await res.json();
  if (!res.ok || (data.error && data.error.code !== 0)) {
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
  const MAX_ATTEMPTS = 60;
  const POLL_INTERVAL_MS = 5000;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
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
  const anthropic = new Anthropic();

  const checks = job.rawImages.map(async (img) => {
    try {
      const resp = await anthropic.messages.create({
        model: QC_MODEL,
        max_tokens: 10,
        system: clogPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: img.url },
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

      const entry = { ...img, verdict };

      if (verdict === 'PASS') {
        job.approvedImages.push(entry);
      } else {
        job.rejectedImages.push(entry);
      }
    } catch (err) {
      console.error(`[job ${job.id}] QC error for ${img.concept}:`, err.message);
      job.rejectedImages.push({
        ...img,
        verdict: 'ERROR',
        reason: err.message,
      });
    }
  });

  await Promise.all(checks);
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
  const { fundName, fundThesis, styleJson } = req.body;
  if (!fundName) return res.status(400).json({ error: 'fundName is required' });

  const job = createJob(fundName, fundThesis || '', styleJson || null);
  runPipeline(job);

  res.json({ jobId: job.id, stage: job.stage });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    stage: job.stage,
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

if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

function loadHistory() {
  try {
    return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  writeFileSync(HISTORY_FILE, JSON.stringify(entries, null, 2));
}

async function archiveImage(img, fundName, jobId) {
  const ts = Date.now();
  const slug = (img.concept || 'image').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const filename = `${ts}-${slug}.png`;
  const filepath = join(ARCHIVE_DIR, filename);

  try {
    const res = await fetch(img.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await streamPipeline(res.body, createWriteStream(filepath));
  } catch (err) {
    console.error(`[archive] Failed to download ${img.url}:`, err.message);
    return null;
  }

  const entry = {
    id: crypto.randomUUID(),
    jobId,
    fundName,
    concept: img.concept || null,
    prompt: img.prompt || null,
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
  await Promise.allSettled(
    allImages.map((img) => archiveImage(img, job.fundName, job.id))
  );
}

app.get('/api/history', (_req, res) => {
  const history = loadHistory();
  res.json(history);
});

app.get('/api/archive/:filename', (req, res) => {
  const filepath = join(ARCHIVE_DIR, req.params.filename);
  if (!existsSync(filepath)) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.filename}"`);
  res.sendFile(filepath);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Fund Image Gen running at http://localhost:${PORT}`);
});
