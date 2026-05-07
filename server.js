import 'dotenv/config';
import express from 'express';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const LEGNEXT_BASE = 'https://api.legnext.ai/api/v1';
const MAX_IMAGES = 3;

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
    if (raw.includes('PLACEHOLDER')) return null;
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

function createJob(fundName, styleJson) {
  const id = crypto.randomUUID();
  const job = {
    id,
    fundName,
    styleJson,
    stage: 'queued',
    themePrompt: null,
    mjTaskId: null,
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
// Stage 1 — Claude Sonnet: theme generation
// ---------------------------------------------------------------------------
async function generateTheme(job) {
  job.stage = 'generating_theme';

  const anthropic = new Anthropic();

  const userMessage = job.styleJson
    ? `**INPUT A — VISUAL STYLE JSON:**\n${JSON.stringify(job.styleJson, null, 2)}\n\n**INPUT B — FUND THESIS:**\n${job.fundName}\n\nGenerate the fused image-generation prompt now.`
    : `**INPUT B — FUND THESIS:**\n${job.fundName}\n\nNo visual style JSON is provided. Use your best judgment for atmospheric tone. Generate the image-generation prompt now.`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: THEME_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const promptText = resp.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();

  job.themePrompt = promptText;
  return promptText;
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
  return res.json();
}

async function pollMidjourney(job) {
  job.stage = 'generating_images';
  const jobId = await submitMidjourneyJob(job.themePrompt);
  job.mjTaskId = jobId;

  const MAX_ATTEMPTS = 60;
  const POLL_INTERVAL_MS = 5000;

  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const result = await fetchMidjourneyResult(jobId);

    if (result.status === 'completed') {
      const allImages = result.output?.image_urls || [];
      const gridImage = result.output?.image_url;

      // Prefer individual split images; fall back to grid
      let images = allImages.length > 0 ? allImages : (gridImage ? [gridImage] : []);
      images = images.slice(0, MAX_IMAGES);

      job.rawImages = images;
      return images;
    }

    if (result.status === 'failed') {
      throw new Error(result.error?.message || 'Midjourney task failed');
    }
  }

  throw new Error('Midjourney task timed out after polling');
}

// ---------------------------------------------------------------------------
// Stage 3 — Clog QC check
// ---------------------------------------------------------------------------
async function runClogCheck(job) {
  const clogPrompt = loadClogPrompt();
  if (!clogPrompt) {
    job.stage = 'complete';
    job.approvedImages = job.rawImages.map((url) => ({
      url,
      score: null,
      verdict: 'skipped',
      reason: 'QC prompt not configured',
    }));
    return;
  }

  job.stage = 'qc_check';
  const anthropic = new Anthropic();

  for (const imageUrl of job.rawImages) {
    try {
      const resp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2048,
        system: clogPrompt,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: { type: 'url', url: imageUrl },
              },
              {
                type: 'text',
                text: `Review this image for the fund "${job.fundName}". Return your assessment as JSON with fields: score (number 0-10), verdict ("approved" | "rejected" | "manual_review"), reason (string).`,
              },
            ],
          },
        ],
      });

      const raw = resp.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');

      let assessment;
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        assessment = jsonMatch ? JSON.parse(jsonMatch[0]) : { score: null, verdict: 'manual_review', reason: raw };
      } catch {
        assessment = { score: null, verdict: 'manual_review', reason: raw };
      }

      const entry = { url: imageUrl, ...assessment };

      if (assessment.verdict === 'approved') {
        job.approvedImages.push(entry);
      } else {
        job.rejectedImages.push(entry);
      }
    } catch (err) {
      job.rejectedImages.push({
        url: imageUrl,
        score: null,
        verdict: 'error',
        reason: `QC check failed: ${err.message}`,
      });
    }
  }

  job.stage = 'complete';
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------
async function runPipeline(job) {
  try {
    await generateTheme(job);
    await pollMidjourney(job);
    await runClogCheck(job);
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
  const { fundName, styleJson } = req.body;
  if (!fundName) return res.status(400).json({ error: 'fundName is required' });

  const job = createJob(fundName, styleJson || null);
  runPipeline(job);

  res.json({ jobId: job.id, stage: job.stage });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  res.json({
    jobId: job.id,
    stage: job.stage,
    themePrompt: job.themePrompt,
    mjTaskId: job.mjTaskId,
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
    themePrompt: job.themePrompt,
    approvedImages: job.approvedImages,
    rejectedImages: job.rejectedImages,
    rawImages: job.rawImages,
    error: job.error,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Fund Image Gen running at http://localhost:${PORT}`);
});
