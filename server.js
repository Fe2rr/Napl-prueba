import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const HOST = '0.0.0.0';
const RATINGS_TARGET = 'https://ports-ratings-worker.federicoxastro.workers.dev';

// Load strict Android device list for compatibility validation
const deviceMap = new Map();
try {
  const devicesPath = path.join(__dirname, 'public', 'assets', 'data', 'devices.json');
  const rawDevices = fs.readFileSync(devicesPath, 'utf8');
  const parsedDevices = JSON.parse(rawDevices);
  if (Array.isArray(parsedDevices)) {
    for (const d of parsedDevices) {
      if (d && typeof d.id === 'string' && typeof d.name === 'string') {
        deviceMap.set(d.id, d.name);
      }
    }
  }
} catch (error) {
  console.warn('Warning: could not load devices.json for compatibility validation:', error);
}

// In-memory compatibility reports for preview (D1 handles this in production)
const compatibilityReports = new Map();

app.use(express.json());

// Proxy ratings API in preview to avoid Worker CORS origin restrictions
app.all('/api/ratings/*', async (req, res) => {
  try {
    const subPath = req.originalUrl.replace(/^\/api\/ratings/, '');
    const targetUrl = `${RATINGS_TARGET}${subPath}`;

    const fetchOptions = {
      method: req.method,
      headers: {
        'Content-Type': 'application/json',
        'Origin': 'https://fe2rr.github.io',
      },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      fetchOptions.body = JSON.stringify(req.body ?? {});
    }

    const upstream = await fetch(targetUrl, fetchOptions);
    const bodyText = await upstream.text();

    res.status(upstream.status);
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
    res.send(bodyText);
  } catch (error) {
    console.error('Ratings proxy error:', error);
    res.status(502).json({ error: 'Could not reach the ratings server.' });
  }
});

// Compatibility reports API (preview backend matching Cloudflare Catalog Worker contract)
app.get('/api/compatibility', (req, res) => {
  const portIdsParam = String(req.query.port_ids || '');
  const portIds = portIdsParam
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);

  const compatibility = {};
  for (const id of portIds) {
    compatibility[id] = { yes: 0, no: 0, reports: [] };
  }

  const allReports = Array.from(compatibilityReports.values()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  );

  for (const report of allReports) {
    const entry = compatibility[report.portId];
    if (!entry) continue;

    if (report.works) entry.yes += 1;
    else entry.no += 1;

    if (entry.reports.length < 30) {
      entry.reports.push({
        deviceId: report.deviceId,
        deviceName: report.deviceName,
        works: report.works,
        updatedAt: report.updatedAt,
      });
    }
  }

  res.json({ success: true, compatibility });
});

app.post('/api/compatibility', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
  }

  const portId = String(body.port_id || '').trim();
  const deviceId = String(body.device_id || '').trim();
  const token = String(body.token || '').trim();
  const works =
    body.works === true || body.works === 1
      ? true
      : body.works === false || body.works === 0
      ? false
      : null;

  if (!portId || !deviceId || !token || works === null) {
    return res.status(400).json({
      success: false,
      error: 'port_id, device_id, token, and works (boolean) are required.',
    });
  }

  const deviceName = deviceMap.get(deviceId);
  if (!deviceName) {
    return res.status(400).json({
      success: false,
      error: 'Invalid device_id. Please select a device from the list.',
    });
  }

  const key = `${portId}:${token}:${deviceId}`;
  const updatedAt = new Date().toISOString();

  compatibilityReports.set(key, {
    portId,
    token,
    deviceId,
    deviceName,
    works,
    updatedAt,
  });

  return res.json({
    success: true,
    report: {
      portId,
      deviceId,
      deviceName,
      works,
    },
  });
});

// Broken / dead link reports (preview backend matching Cloudflare Worker)
const linkReports = new Map();

app.post('/api/report-link', (req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object') {
    return res.status(400).json({ success: false, error: 'Invalid JSON body.' });
  }

  const portId = String(body.port_id || '').trim();
  const token = String(body.token || '').trim();
  const reason = String(body.reason || '').trim().slice(0, 120);
  const url = String(body.url || '').trim().slice(0, 500);

  if (!portId || !token || !reason) {
    return res.status(400).json({
      success: false,
      error: 'port_id, token, and reason are required.',
    });
  }

  linkReports.set(`${portId}:${token}`, {
    portId,
    reason,
    url,
    updatedAt: new Date().toISOString(),
  });

  return res.json({ success: true, portId, reason });
});

// Sheet proxy endpoint for preview mode (avoids browser iframe CORS / redirect blocks)
let sheetCache = null;
let sheetCacheTime = 0;
const SPREADSHEET_CSV_URL =
  'https://docs.google.com/spreadsheets/d/1CO7dH7mbj9sl67g4e94wczHESp0NAsOa7_chKKii9OA/export?format=csv';

app.get('/api/sheet', async (req, res) => {
  try {
    const now = Date.now();
    if (sheetCache && now - sheetCacheTime < 120000) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(sheetCache);
    }
    const upstream = await fetch(SPREADSHEET_CSV_URL);
    if (!upstream.ok) {
      throw new Error(`Google Sheets HTTP ${upstream.status}`);
    }
    const csv = await upstream.text();
    sheetCache = csv;
    sheetCacheTime = now;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    return res.send(csv);
  } catch (error) {
    console.error('Sheet proxy error:', error);
    if (sheetCache) {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      return res.send(sheetCache);
    }
    return res.status(502).json({ error: 'Could not fetch Google Sheet catalog.' });
  }
});

// Visit tracking proxy for preview mode
const POPULAR_URL =
  'https://script.google.com/macros/s/AKfycbxio6DGpBJRkYdceeFVXk3gSOFcBe5KZJtHU8F2j66DDYx_G_az01p7rnsuCq0KPHY/exec';

const popularCache = new Map();

app.get('/api/popular', async (req, res) => {
  const period = String(req.query.popular || 'week').trim();
  const cached = popularCache.get(period);
  const now = Date.now();

  if (cached && now - cached.time < 60000) {
    return res.json(cached.data);
  }

  try {
    const url = new URL(POPULAR_URL);
    url.searchParams.set('popular', period);
    const upstream = await fetch(url.toString());
    const data = await upstream.json();
    popularCache.set(period, { time: now, data });
    return res.json(data);
  } catch (error) {
    console.error('Popular proxy error:', error);
    if (cached) {
      return res.json(cached.data);
    }
    return res.status(502).json({ success: false, error: 'Could not fetch popular games.' });
  }
});

app.post('/api/visit', async (req, res) => {
  const slug = String(req.body?.slug || '').trim();
  if (!slug) {
    return res.status(400).json({ success: false, error: 'slug is required.' });
  }

  try {
    const url = new URL(POPULAR_URL);
    url.searchParams.set('game', slug);
    url.searchParams.set('_', String(Date.now()));
    await fetch(url.toString(), { method: 'GET' });
  } catch {
    // Non-critical telemetry; do not fail the client request
  }

  return res.json({ success: true, slug });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(html|css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  })
);

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});
