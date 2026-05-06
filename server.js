const path    = require('path');
const express = require('express');
const multer  = require('multer');
const fs      = require('fs');
const https   = require('https');

const app  = express();
const PORT = process.env.PORT || 3011;
const PASS = 'test123';

/* ── uploads dirs ────────────────────────────────── */
const UPLOADS                  = path.join(__dirname, 'uploads');
const CAPTIONS_FILE            = path.join(UPLOADS, 'captions.json');
const STUDIO_UPLOADS           = path.join(__dirname, 'uploads-studio');
const STUDIO_CAPTIONS_FILE     = path.join(STUDIO_UPLOADS, 'captions.json');
const INTERFACES_UPLOADS       = path.join(__dirname, 'uploads-interfaces');
const INTERFACES_CAPTIONS_FILE = path.join(INTERFACES_UPLOADS, 'captions.json');
fs.mkdirSync(UPLOADS, { recursive: true });
fs.mkdirSync(STUDIO_UPLOADS, { recursive: true });
fs.mkdirSync(INTERFACES_UPLOADS, { recursive: true });

/* ── allowed types ───────────────────────────────── */
const ALLOWED = /\.(jpe?g|png|gif|webp|avif|svg)$/i;

/* ── multer: memory storage so req.body is ready ─── */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ok = ALLOWED.test(path.extname(file.originalname)) &&
               /^image\//.test(file.mimetype);
    cb(null, ok);
  }
});

/* ── auth helpers ────────────────────────────────── */
function basicAuth(req, res, next) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    const colon   = decoded.indexOf(':');
    const pwd     = colon >= 0 ? decoded.slice(colon + 1) : decoded;
    if (pwd === PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Gallery Admin"');
  return res.status(401).send('Unauthorized');
}

function apiAuth(req, res, next) {
  const pwd = req.headers['x-upload-password'] || (req.body && req.body.password);
  if (pwd !== PASS) return res.status(401).json({ error: 'Wrong password' });
  next();
}

/* ── middleware ──────────────────────────────────── */
app.use(express.json());

// Block direct requests to admin.html (must go through /admin)
app.use((req, res, next) => {
  if (req.path.toLowerCase() === '/admin.html') return res.redirect(301, '/admin');
  next();
});

// CORS for cross-origin preview
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Static files served from Graphicwebsite root
app.use(express.static(__dirname, { index: 'index.html' }));
app.use('/uploads', express.static(UPLOADS));

/* ── Admin page (password-protected) ─────────────── */
app.get('/admin', basicAuth, (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ── helpers ─────────────────────────────────────── */
function cellIdFromName(name) {
  const m = name.match(/^cell-(\d+)-/);
  return m ? parseInt(m[1], 10) : null;
}

function readCaptions() {
  try { return JSON.parse(fs.readFileSync(CAPTIONS_FILE, 'utf8')); } catch { return {}; }
}

function readStudioCaptions() {
  try { return JSON.parse(fs.readFileSync(STUDIO_CAPTIONS_FILE, 'utf8')); } catch { return {}; }
}

function readInterfacesCaptions() {
  try { return JSON.parse(fs.readFileSync(INTERFACES_CAPTIONS_FILE, 'utf8')); } catch { return {}; }
}

function listImages(dir) {
  return fs.readdirSync(dir)
    .filter(f => ALLOWED.test(f))
    .map(f => {
      const stat = fs.statSync(path.join(dir, f));
      return { name: f, url: '/' + path.relative(__dirname, path.join(dir, f)).replace(/\\/g, '/'), size: stat.size, created: stat.mtimeMs, cell_id: cellIdFromName(f) };
    })
    .sort((a, b) => b.created - a.created);
}

/* ── GET /api/images ─────────────────────────────── */
app.get('/api/images', (_req, res) => res.json(listImages(UPLOADS)));

/* ── GET /api/captions ───────────────────────────── */
app.get('/api/captions', (_req, res) => res.json(readCaptions()));

/* ── POST /api/captions (auth) ───────────────────── */
app.post('/api/captions', apiAuth, (req, res) => {
  try {
    fs.writeFileSync(CAPTIONS_FILE, JSON.stringify(req.body || {}));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ── Studio API ──────────────────────────────────── */
app.get('/api/studio/images', (_req, res) => res.json(listImages(STUDIO_UPLOADS)));
app.get('/api/studio/captions', (_req, res) => res.json(readStudioCaptions()));
app.post('/api/studio/captions', apiAuth, (req, res) => {
  try {
    fs.writeFileSync(STUDIO_CAPTIONS_FILE, JSON.stringify(req.body || {}));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/uploads-studio', express.static(STUDIO_UPLOADS));

app.post('/api/studio/upload', apiAuth, upload.array('images', 40), (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No valid images received' });
  const cellId = req.body.cell_id;
  const saved  = [];
  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.test(ext)) continue;
    let filename;
    if (cellId !== undefined && cellId !== '') {
      const prefix = `cell-${cellId}-`;
      for (const old of fs.readdirSync(STUDIO_UPLOADS)) {
        if (old.startsWith(prefix)) fs.unlinkSync(path.join(STUDIO_UPLOADS, old));
      }
      filename = `cell-${cellId}-${Date.now()}${ext}`;
    } else {
      filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    }
    fs.writeFileSync(path.join(STUDIO_UPLOADS, filename), file.buffer);
    saved.push({ name: filename, url: '/uploads-studio/' + filename, cell_id: cellIdFromName(filename) });
  }
  if (!saved.length) return res.status(400).json({ error: 'No valid images' });
  res.json({ success: true, files: saved });
});

app.delete('/api/studio/images/:name', apiAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(STUDIO_UPLOADS, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ success: true });
});

/* ── Shared reorganize helper (two-phase rename — safe for swaps) ── */
function doReorganize(dir, caps, capsFile, mappings) {
  // Snapshot captions before any mutation
  const savedCaps = {};
  for (const { oldId } of mappings) savedCaps[String(oldId)] = caps[String(oldId)];

  // Phase 1: rename each source file to a temp name so swaps don't clobber each other
  const temps = []; // [{ tempPath, newId }]
  for (const { oldId, newId } of mappings) {
    if (oldId === newId) continue;
    const files = fs.readdirSync(dir)
      .filter(f => ALLOWED.test(f) && f.startsWith(`cell-${oldId}-`));
    for (const f of files) {
      const ext      = path.extname(f);
      const tempName = `cell-SWAP-${Date.now()}-${Math.random().toString(36).slice(2,6)}${ext}`;
      fs.renameSync(path.join(dir, f), path.join(dir, tempName));
      temps.push({ tempName, newId });
    }
  }

  // Phase 2: rename from temp to final cell-IDs
  for (const { tempName, newId } of temps) {
    const ext      = path.extname(tempName);
    const newName  = `cell-${newId}-${Date.now()}${ext}`;
    fs.renameSync(path.join(dir, tempName), path.join(dir, newName));
  }

  // Update captions using snapshotted values (avoids stale-read bug during swaps)
  for (const { oldId, newId } of mappings) {
    if (oldId === newId) continue;
    const saved = savedCaps[String(oldId)];
    if (saved !== undefined) caps[String(newId)] = saved;
    else delete caps[String(newId)];
  }

  try { fs.writeFileSync(capsFile, JSON.stringify(caps)); } catch (e) {}
}

/* ── POST /api/studio/reorganize ─────────────────── */
app.post('/api/studio/reorganize', apiAuth, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Invalid' });
  doReorganize(STUDIO_UPLOADS, readStudioCaptions(), STUDIO_CAPTIONS_FILE, mappings);
  res.json({ success: true });
});

/* ── Interfaces API ──────────────────────────────── */
app.get('/api/interfaces/images',   (_req, res) => res.json(listImages(INTERFACES_UPLOADS)));
app.get('/api/interfaces/captions', (_req, res) => res.json(readInterfacesCaptions()));
app.post('/api/interfaces/captions', apiAuth, (req, res) => {
  try {
    fs.writeFileSync(INTERFACES_CAPTIONS_FILE, JSON.stringify(req.body || {}));
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use('/uploads-interfaces', express.static(INTERFACES_UPLOADS));

app.post('/api/interfaces/upload', apiAuth, upload.array('images', 40), (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No valid images received' });
  const cellId = req.body.cell_id;
  const saved  = [];
  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.test(ext)) continue;
    let filename;
    if (cellId !== undefined && cellId !== '') {
      const prefix = `cell-${cellId}-`;
      for (const old of fs.readdirSync(INTERFACES_UPLOADS)) {
        if (old.startsWith(prefix)) fs.unlinkSync(path.join(INTERFACES_UPLOADS, old));
      }
      filename = `cell-${cellId}-${Date.now()}${ext}`;
    } else {
      filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    }
    fs.writeFileSync(path.join(INTERFACES_UPLOADS, filename), file.buffer);
    saved.push({ name: filename, url: '/uploads-interfaces/' + filename, cell_id: cellIdFromName(filename) });
  }
  if (!saved.length) return res.status(400).json({ error: 'No valid images' });
  res.json({ success: true, files: saved });
});

app.delete('/api/interfaces/images/:name', apiAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(INTERFACES_UPLOADS, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ success: true });
});

app.post('/api/interfaces/reorganize', apiAuth, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Invalid' });
  doReorganize(INTERFACES_UPLOADS, readInterfacesCaptions(), INTERFACES_CAPTIONS_FILE, mappings);
  res.json({ success: true });
});

/* ── /studio route ───────────────────────────────── */
app.get('/studio', (_req, res) => res.sendFile(path.join(__dirname, 'studio.html')));

/* ── /interfaces route ───────────────────────────── */
app.get('/interfaces', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(__dirname, 'interfaces.html'));
});

/* ── POST /api/auth ──────────────────────────────── */
app.post('/api/auth', (req, res) => {
  res.json({ ok: req.body && req.body.password === PASS });
});

/* ── POST /api/upload ────────────────────────────── */
app.post('/api/upload', apiAuth, upload.array('images', 40), (req, res) => {
  if (!req.files || !req.files.length)
    return res.status(400).json({ error: 'No valid images received' });

  const cellId = req.body.cell_id;
  const saved  = [];

  for (const file of req.files) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED.test(ext)) continue;

    let filename;
    if (cellId !== undefined && cellId !== '') {
      const prefix = `cell-${cellId}-`;
      for (const old of fs.readdirSync(UPLOADS)) {
        if (old.startsWith(prefix)) fs.unlinkSync(path.join(UPLOADS, old));
      }
      filename = `cell-${cellId}-${Date.now()}${ext}`;
    } else {
      filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    }

    fs.writeFileSync(path.join(UPLOADS, filename), file.buffer);
    saved.push({
      name:    filename,
      url:     '/uploads/' + filename,
      cell_id: cellIdFromName(filename)
    });
  }

  if (!saved.length)
    return res.status(400).json({ error: 'No valid images' });

  res.json({ success: true, files: saved });
});

/* ── DELETE /api/images/:name ────────────────────── */
app.delete('/api/images/:name', apiAuth, (req, res) => {
  const name = path.basename(req.params.name);
  const fp   = path.join(UPLOADS, name);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'Not found' });
  fs.unlinkSync(fp);
  res.json({ success: true });
});

/* ── POST /api/reorganize ────────────────────────── */
app.post('/api/reorganize', apiAuth, (req, res) => {
  const { mappings } = req.body;
  if (!Array.isArray(mappings)) return res.status(400).json({ error: 'Invalid' });
  doReorganize(UPLOADS, readCaptions(), CAPTIONS_FILE, mappings);
  res.json({ success: true });
});

/* ── Tumblr proxy ────────────────────────────────── */
const TUMBLR_BLOG = 'minimalmoderni';

function fetchTumblrPage(start, num) {
  return new Promise((resolve, reject) => {
    const url = `https://${TUMBLR_BLOG}.tumblr.com/api/read/json?type=photo&num=${num}&start=${start}`;
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = data
            .replace(/^var tumblr_api_read\s*=\s*/, '')
            .replace(/;?\s*$/, '');
          resolve(JSON.parse(json));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

app.get('/api/tumblr', async (req, res) => {
  try {
    const start = Math.max(0, parseInt(req.query.start) || 0);
    const num   = Math.min(50, Math.max(1, parseInt(req.query.num) || 20));
    const data  = await fetchTumblrPage(start, num);
    const posts = (data.posts || []).map(post => ({
      id:        post.id,
      url:       post['photo-url-1280'] || post['photo-url-500'] || post['photo-url-400'] || '',
      post_url:  post.url || '',
      timestamp: post['unix-timestamp'] || 0
    })).filter(p => p.url);
    res.json({ posts, total: data['posts-total'] || 0, start, num });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log(`Graphicwebsite on :${PORT}  uploads=${UPLOADS}  password=${PASS}`)
);
