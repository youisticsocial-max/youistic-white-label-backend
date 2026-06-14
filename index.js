// index.js - White Label Service (ES Module)
import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import fetch from 'node-fetch';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ─── Startup env check ────────────────────────────────────────────────────────
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;
const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
if (!NETLIFY_TOKEN) console.error('[WARN] NETLIFY_TOKEN is undefined — check your .env file');
else                console.log ('[OK]  NETLIFY_TOKEN loaded');
if (!GITHUB_TOKEN)  console.error('[WARN] GITHUB_TOKEN is undefined — check your .env file');
else                console.log ('[OK]  GITHUB_TOKEN loaded');

// ─── Paths ────────────────────────────────────────────────────────────────────
// Templates live at: C:\Users\Owner\.gemini\antigravity\workspace\Templetes
const TEMPLATES_ROOT = path.resolve(__dirname, '..', 'Templetes');
const TEMP_ROOT      = path.resolve(__dirname, 'temp');
console.log('[PATH] TEMPLATES_ROOT →', TEMPLATES_ROOT);
if (!fs.existsSync(TEMP_ROOT)) fs.mkdirSync(TEMP_ROOT, { recursive: true });

// ─── archiver (v5, CJS) ───────────────────────────────────────────────────────
const require   = createRequire(import.meta.url);
const archiver  = require('archiver');

// ─── Express setup ────────────────────────────────────────────────────────────
const app = express();
app.use(cors({
  origin: '*', // This allows requests from any origin including our live site
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept']
}));
app.use(express.json({ limit: '5mb' }));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function copyFolder(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src,  entry.name);
    const d = path.join(dest, entry.name);
    entry.isDirectory() ? copyFolder(s, d) : fs.copyFileSync(s, d);
  }
}

function replacePlaceholders(filePath, fields) {
  let content = fs.readFileSync(filePath, 'utf8');
  for (const [key, value] of Object.entries(fields)) {
    content = content.replace(new RegExp(`{{${key}}}`, 'g'), value);
  }
  fs.writeFileSync(filePath, content, 'utf8');
}

function replaceRecursively(dir, fields) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) {
      replaceRecursively(p, fields);
    } else if (item.isFile() && (p.endsWith('.html') || p.endsWith('.css'))) {
      replacePlaceholders(p, fields);
    }
  }
}

function zipFolder(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output  = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  });
}

// ─── Netlify deploy ───────────────────────────────────────────────────────────
async function deployToNetlify(zipPath, siteName) {
  // Step 1 – create site
  console.log('[NETLIFY] Creating site:', siteName);
  let createBody, siteId;
  try {
    const createResp = await fetch('https://api.netlify.com/api/v1/sites', {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: siteName }),
    });
    createBody = await createResp.json();
    console.log('[NETLIFY] Create site response status:', createResp.status);
    console.log('[NETLIFY] Create site body:', JSON.stringify(createBody));
    if (!createResp.ok) {
      throw new Error(`Site creation failed (${createResp.status}): ${createBody.message || JSON.stringify(createBody)}`);
    }
    siteId = createBody.id;
  } catch (err) {
    throw new Error(`[NETLIFY STEP 1] ${err.message}`);
  }

  // Step 2 – upload zip
  console.log('[NETLIFY] Uploading zip to site ID:', siteId);
  try {
    const zipBuffer  = fs.readFileSync(zipPath);
    const deployResp = await fetch(`https://api.netlify.com/api/v1/sites/${siteId}/deploys`, {
      method: 'POST',
      headers: {
        Authorization:  `Bearer ${NETLIFY_TOKEN}`,
        'Content-Type': 'application/zip',
      },
      body: zipBuffer,
    });
    const deployBody = await deployResp.json();
    console.log('[NETLIFY] Deploy response status:', deployResp.status);
    console.log('[NETLIFY] Deploy body:', JSON.stringify(deployBody));
    if (!deployResp.ok) {
      throw new Error(`Deploy failed (${deployResp.status}): ${deployBody.message || JSON.stringify(deployBody)}`);
    }
    // Return the deploy URL or the site URL as fallback
    const previewUrl = deployBody.deploy_ssl_url || deployBody.deploy_url || deployBody.url || `https://${siteName}.netlify.app`;
    console.log('[NETLIFY] Preview URL:', previewUrl);
    return previewUrl;
  } catch (err) {
    throw new Error(`[NETLIFY STEP 2] ${err.message}`);
  }
}

// ─── POST /build ──────────────────────────────────────────────────────────────
app.post('/build', async (req, res) => {
  const { category, clientName, fields } = req.body || {};
  console.log('\n[BUILD] Request received:', { category, clientName, fields });

  if (!category || !clientName || !fields) {
    return res.status(400).json({ error: 'Missing required fields: category, clientName, fields' });
  }

  const srcTemplate = path.join(TEMPLATES_ROOT, category);
  console.log('[BUILD] Looking for template at:', srcTemplate, '→ exists?', fs.existsSync(srcTemplate));
  if (!fs.existsSync(srcTemplate)) {
    const available = fs.readdirSync(TEMPLATES_ROOT).join(', ');
    return res.status(404).json({ error: `Template '${category}' not found. Available: ${available}` });
  }

  const workId  = uuidv4();
  const workDir = path.join(TEMP_ROOT, workId);
  const zipPath = path.join(TEMP_ROOT, `${workId}.zip`);

  try {
    copyFolder(srcTemplate, workDir);
    replaceRecursively(workDir, fields);
    await zipFolder(workDir, zipPath);
    console.log('[BUILD] Zip created at:', zipPath, '— size:', fs.statSync(zipPath).size, 'bytes');

    const siteSlug   = `${clientName.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${category.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${workId.slice(0,6)}`;
    const previewUrl = await deployToNetlify(zipPath, siteSlug);

    // Cleanup temp files
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.unlinkSync(zipPath);

    console.log('[BUILD] ✅ Done! URL:', previewUrl);
    res.json({ previewUrl });

  } catch (err) {
    console.error('[BUILD ERROR]', err.message);
    // Cleanup on error
    if (fs.existsSync(workDir)) fs.rmSync(workDir, { recursive: true, force: true });
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`\n🚀 White‑Label Service running on http://localhost:${PORT}\n`));
