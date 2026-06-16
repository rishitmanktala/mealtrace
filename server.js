'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 4173);
const ROOT = __dirname;
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'meta-llama/llama-4-scout-17b-16e-instruct';
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 6 * 1024 * 1024;
const MAX_MEAL_DESCRIPTION_CHARS = 500;

loadDotEnv(path.join(ROOT, '.env'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS' && req.url.startsWith('/api/')) {
      sendApiOptions(res);
      return;
    }

    if (req.method === 'GET' && req.url === '/api/config') {
      handleConfig(req, res);
      return;
    }

    if (req.method === 'POST' && req.url === '/api/analyze-meal') {
      await handleAnalyzeMeal(req, res);
      return;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: 'Unexpected server error' });
  }
});

server.listen(PORT, () => {
  console.log(`MealTrace running at http://localhost:${PORT}`);
});

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  text.split(/\r?\n/).forEach(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) return;
    const eq = trimmed.indexOf('=');
    if (eq === -1) return;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] == null) process.env[key] = value;
  });
}

async function handleAnalyzeMeal(req, res) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    sendJson(res, 500, { error: 'Server is missing GROQ_API_KEY' });
    return;
  }

  const user = await verifySupabaseUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Please sign in to analyze a meal.' });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, error.status || 400, { error: error.message || 'Invalid JSON body' });
    return;
  }

  const imageDataUrl = String(body.imageDataUrl || '');
  const mealDescription = String(body.mealDescription || '').trim();
  const hasImage = Boolean(imageDataUrl);
  const hasDescription = Boolean(mealDescription);

  if (!hasImage && !hasDescription) {
    sendJson(res, 400, { error: 'Add a meal photo or type what you ate.' });
    return;
  }

  if (hasImage && !isValidImageDataUrl(imageDataUrl)) {
    sendJson(res, 400, { error: 'imageDataUrl must be a data:image URL' });
    return;
  }

  if (hasImage && estimateDataUrlBytes(imageDataUrl) > MAX_IMAGE_BYTES) {
    sendJson(res, 413, { error: 'Image is too large. Please upload a smaller meal photo.' });
    return;
  }

  if (mealDescription.length > MAX_MEAL_DESCRIPTION_CHARS) {
    sendJson(res, 413, { error: 'Meal details are too long. Keep it under 500 characters.' });
    return;
  }

  const prompt = `You are a registered dietitian AI. ${hasImage ? 'Analyze this food photo' : `Estimate nutrition for this typed meal description: ${JSON.stringify(mealDescription)}`} and return a JSON object only, with this exact shape:
{
  "food_name": "Human-readable name of the dish",
  "serving_description": "Estimated serving size",
  "calories": 0,
  "protein_g": 0,
  "carbohydrates_g": 0,
  "fat_g": 0,
  "fiber_g": 0,
  "sugar_g": 0,
  "saturated_fat_g": 0,
  "sodium_mg": 0,
  "potassium_mg": 0,
  "cholesterol_mg": 0,
  "vitamins": {
    "vitamin_a_mcg": 0,
    "vitamin_b6_mg": 0,
    "vitamin_b12_mcg": 0,
    "vitamin_c_mg": 0,
    "vitamin_d_mcg": 0,
    "vitamin_e_mg": 0,
    "vitamin_k_mcg": 0,
    "folate_mcg": 0,
    "niacin_mg": 0
  },
  "minerals": {
    "calcium_mg": 0,
    "iron_mg": 0,
    "magnesium_mg": 0,
    "phosphorus_mg": 0,
    "zinc_mg": 0,
    "selenium_mcg": 0
  }
}
Use numbers only for numeric values. If the food is unclear, provide reasonable estimates.`;

  const messageContent = [{ type: 'text', text: prompt }];
  if (hasImage) messageContent.push({ type: 'image_url', image_url: { url: imageDataUrl } });

  const groqBody = {
    model: GROQ_MODEL,
    messages: [{
      role: 'user',
      content: messageContent,
    }],
    temperature: 0.2,
    max_completion_tokens: 1200,
    response_format: { type: 'json_object' },
  };

  let groqResponse;
  try {
    groqResponse = await fetch(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(groqBody),
    });
  } catch {
    sendJson(res, 502, { error: 'Could not reach the analysis service' });
    return;
  }

  const data = await groqResponse.json().catch(() => ({}));
  if (!groqResponse.ok) {
    const message = data?.error?.message || `Analysis service returned ${groqResponse.status}`;
    sendJson(res, 502, { error: message });
    return;
  }

  const content = data?.choices?.[0]?.message?.content;
  try {
    const nutrition = typeof content === 'string' ? JSON.parse(content) : content;
    sendJson(res, 200, normalizeNutrition(nutrition || {}));
  } catch {
    sendJson(res, 502, { error: 'The nutrition response could not be read' });
  }
}

function handleConfig(req, res) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  if (!supabaseUrl || !supabaseAnonKey) {
    sendJson(res, 500, { error: 'Server is missing SUPABASE_URL or SUPABASE_ANON_KEY' });
    return;
  }

  sendJson(res, 200, { supabaseUrl, supabaseAnonKey });
}

async function verifySupabaseUser(req) {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY || '';
  const token = getBearerToken(req);
  if (!supabaseUrl || !supabaseAnonKey || !token) return null;

  let response;
  try {
    response = await fetch(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': supabaseAnonKey,
      },
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;
  const user = await response.json().catch(() => null);
  return user?.id ? user : null;
}

function getBearerToken(req) {
  const header = req.headers.authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) <= MAX_BODY_BYTES) return;
      tooLarge = true;
      body = '';
    });
    req.on('end', () => {
      if (tooLarge) {
        const error = new Error('Image is too large. Please upload a smaller meal photo.');
        error.status = 413;
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(body || '{}'));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function isValidImageDataUrl(value) {
  return /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i.test(value);
}

function estimateDataUrlBytes(dataUrl) {
  const base64 = dataUrl.split(',')[1] || '';
  return Math.ceil((base64.length * 3) / 4);
}

function normalizeNutrition(n) {
  return {
    food_name: String(n.food_name || 'Estimated meal'),
    serving_description: String(n.serving_description || 'Estimated serving'),
    calories: num(n.calories),
    protein_g: num(n.protein_g),
    carbohydrates_g: num(n.carbohydrates_g),
    fat_g: num(n.fat_g),
    fiber_g: num(n.fiber_g),
    sugar_g: num(n.sugar_g),
    saturated_fat_g: num(n.saturated_fat_g),
    sodium_mg: num(n.sodium_mg),
    potassium_mg: num(n.potassium_mg),
    cholesterol_mg: num(n.cholesterol_mg),
    vitamins: n.vitamins && typeof n.vitamins === 'object' ? n.vitamins : {},
    minerals: n.minerals && typeof n.minerals === 'object' ? n.minerals : {},
  };
}

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT, relativePath);
  const ext = path.extname(filePath).toLowerCase();

  if (!MIME_TYPES[ext] || !filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    sendText(res, 404, 'Not found');
    return;
  }

  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(filePath).pipe(res);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  });
  res.end(JSON.stringify(payload));
}

function sendApiOptions(res) {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
