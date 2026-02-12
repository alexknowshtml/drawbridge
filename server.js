/**
 * Drawbridge - Real-time Excalidraw diagram server
 *
 * HTTP + WebSocket bridge that lets any AI (Claude, GPT, etc.) or script
 * push diagram elements to an Excalidraw canvas in real time.
 *
 * Single port (default 3062, configurable via DRAWBRIDGE_PORT):
 *   POST /api/session/:id/elements - Replace all elements
 *   POST /api/session/:id/append  - Add elements (progressive drawing)
 *   POST /api/session/:id/clear   - Clear canvas
 *   POST /api/session/:id/viewport - Set camera position/zoom
 *   POST /api/session/:id/undo    - Undo last operation
 *   GET  /api/session/:id         - Get current elements
 *   GET  /api/sessions            - List active sessions
 *   GET  /health                  - Health check
 *   ws://host:PORT/ws/:sessionId  - Real-time bidirectional updates
 *
 * Persistence:
 *   Sessions are persisted to disk using append-only logs + periodic snapshots.
 *   Data stored in ./data/ (configurable via DRAWBRIDGE_DATA_DIR).
 *   Undo replays the log minus the last entry.
 *
 * If dist/ exists, serves the built Vite frontend as static files.
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';
import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, renameSync, readdirSync, statSync, copyFileSync } from 'fs';
import { join } from 'path';
import { initSpacesClient, isSpacesEnabled, getSpacesInternals, uploadFile } from './lib/spaces-client.js';

const PORT = parseInt(process.env.DRAWBRIDGE_PORT || '3062');
const DATA_DIR = process.env.DRAWBRIDGE_DATA_DIR || join(import.meta.dirname, 'data');
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // Write snapshot every 5 minutes
const SNAPSHOT_HISTORY_LIMIT = 50; // Keep this many versioned snapshots per session (~4 hours at 5-min intervals)

// Ensure data directory exists
mkdirSync(DATA_DIR, { recursive: true });

// --- Persistence: Append-only log + snapshot ---

function snapshotPath(sessionId) {
  return join(DATA_DIR, `${sessionId}.snapshot.json`);
}

function logPath(sessionId) {
  return join(DATA_DIR, `${sessionId}.log`);
}

function writeSnapshot(sessionId, session) {
  const sp = snapshotPath(sessionId);
  const snapshotData = {
    elements: session.elements,
    appState: session.appState,
    viewport: session.viewport,
    _version: session._version,
  };

  // Version the current snapshot before overwriting
  if (existsSync(sp)) {
    const timestamp = Date.now();
    const versionedPath = join(DATA_DIR, `${sessionId}.snapshot-${timestamp}.json`);
    try {
      copyFileSync(sp, versionedPath);
    } catch (err) {
      console.error(`[Persist] Failed to version snapshot for ${sessionId}:`, err.message);
    }
    pruneOldSnapshots(sessionId);
    // Fire-and-forget backup to DO Spaces
    backupSnapshotToSpaces(sessionId, snapshotData, timestamp);
  }

  const tmp = sp + '.tmp';
  writeFileSync(tmp, JSON.stringify(snapshotData));
  renameSync(tmp, sp);
  // Truncate log after snapshot
  writeFileSync(logPath(sessionId), '');
  session._lastSnapshotAt = Date.now();
}

function appendLog(sessionId, session, op) {
  appendFileSync(logPath(sessionId), JSON.stringify(op) + '\n');
}

function applyOp(session, op) {
  switch (op.type) {
    case 'set':
      session.elements = op.elements;
      if (op.appState) session.appState = op.appState;
      break;
    case 'append':
      session.elements = [...session.elements, ...op.elements];
      break;
    case 'clear':
      session.elements = [];
      session.appState = null;
      session.viewport = null;
      break;
    case 'viewport':
      session.viewport = op.viewport;
      break;
    case 'update':
      session.elements = op.elements;
      break;
  }
}

function loadSession(sessionId) {
  const session = { elements: [], appState: null, viewport: null, files: {}, clients: new Set(), _lastSnapshotAt: Date.now(), _version: 0 };

  // Load snapshot if exists
  const sp = snapshotPath(sessionId);
  if (existsSync(sp)) {
    try {
      const snap = JSON.parse(readFileSync(sp, 'utf-8'));
      session.elements = snap.elements || [];
      session.appState = snap.appState || null;
      session.viewport = snap.viewport || null;
      session._version = snap._version || 0;
    } catch (err) {
      console.error(`[Persist] Failed to load snapshot for ${sessionId}:`, err.message);
    }
  }

  // Replay log entries
  const lp = logPath(sessionId);
  if (existsSync(lp)) {
    try {
      const lines = readFileSync(lp, 'utf-8').split('\n').filter(l => l.trim());
      for (const line of lines) {
        applyOp(session, JSON.parse(line));
        session._version++;
      }
      // Log entries exist — snapshot may be stale, mark for early flush
    } catch (err) {
      console.error(`[Persist] Failed to replay log for ${sessionId}:`, err.message);
    }
  }

  // Load file metadata (image CDN URLs)
  session.files = loadFilesMeta(sessionId);

  return session;
}

function deleteSessionFiles(sessionId) {
  try { unlinkSync(snapshotPath(sessionId)); } catch {}
  try { unlinkSync(logPath(sessionId)); } catch {}
  try { unlinkSync(filesMetaPath(sessionId)); } catch {}
}

// --- Snapshot versioning helpers ---

function listSnapshots(sessionId) {
  const prefix = `${sessionId}.snapshot-`;
  try {
    const files = readdirSync(DATA_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => {
        const timestamp = parseInt(f.slice(prefix.length, -5), 10);
        const fullPath = join(DATA_DIR, f);
        const stat = statSync(fullPath);
        let elementCount = 0;
        try {
          const data = JSON.parse(readFileSync(fullPath, 'utf-8'));
          elementCount = (data.elements || []).length;
        } catch {}
        return { timestamp, elementCount, size: stat.size, filename: f };
      })
      .sort((a, b) => b.timestamp - a.timestamp); // newest first
    return files;
  } catch {
    return [];
  }
}

function pruneOldSnapshots(sessionId) {
  const versions = listSnapshots(sessionId);
  if (versions.length <= SNAPSHOT_HISTORY_LIMIT) return;
  const toDelete = versions.slice(SNAPSHOT_HISTORY_LIMIT);
  for (const v of toDelete) {
    try {
      unlinkSync(join(DATA_DIR, v.filename));
    } catch {}
  }
  if (toDelete.length > 0) {
    console.log(`[Persist] Pruned ${toDelete.length} old snapshots for ${sessionId}`);
  }
}

function restoreSnapshot(sessionId, timestamp) {
  const versionedPath = join(DATA_DIR, `${sessionId}.snapshot-${timestamp}.json`);
  if (!existsSync(versionedPath)) return null;

  try {
    const data = JSON.parse(readFileSync(versionedPath, 'utf-8'));
    const session = getSession(sessionId);

    // Save current state as a new version before restoring
    writeSnapshot(sessionId, session);

    // Apply restored state
    session.elements = data.elements || [];
    session.appState = data.appState || null;
    session.viewport = data.viewport || null;

    // Write the restored state as the current snapshot
    const tmp = snapshotPath(sessionId) + '.tmp';
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, snapshotPath(sessionId));
    writeFileSync(logPath(sessionId), '');
    session._lastSnapshotAt = Date.now();

    // Broadcast to all connected clients
    session._version++;
    broadcast(session, {
      type: 'elements',
      elements: session.elements,
      appState: session.appState,
      version: session._version,
      source: 'restore',
    });

    console.log(`[Persist] Restored session ${sessionId} to snapshot ${timestamp} (${session.elements.length} elements)`);
    return { elements: session.elements, elementCount: session.elements.length };
  } catch (err) {
    console.error(`[Persist] Failed to restore snapshot ${timestamp} for ${sessionId}:`, err.message);
    return null;
  }
}

async function backupSnapshotToSpaces(sessionId, snapshotData, timestamp) {
  if (!isSpacesEnabled()) return;
  try {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const { s3Client: client, spacesConfig: config } = getSpacesInternals();
    if (!client || !config) return;

    const key = `snapshots/${sessionId}/${sessionId}.snapshot-${timestamp}.json`;
    const body = JSON.stringify(snapshotData);

    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json',
      ACL: 'private',
    }));
    console.log(`[Spaces] Backed up snapshot ${sessionId} @ ${timestamp}`);
  } catch (err) {
    console.error(`[Spaces] Snapshot backup failed for ${sessionId}:`, err.message);
  }
}

// --- File metadata persistence (image CDN URLs) ---

function filesMetaPath(sessionId) {
  return join(DATA_DIR, `${sessionId}.files.json`);
}

function loadFilesMeta(sessionId) {
  const fp = filesMetaPath(sessionId);
  if (!existsSync(fp)) return {};
  try {
    return JSON.parse(readFileSync(fp, 'utf-8'));
  } catch (err) {
    console.error(`[Persist] Failed to load files for ${sessionId}:`, err.message);
    return {};
  }
}

function saveFilesMeta(sessionId, filesMeta) {
  const tmp = filesMetaPath(sessionId) + '.tmp';
  writeFileSync(tmp, JSON.stringify(filesMeta));
  renameSync(tmp, filesMetaPath(sessionId));
}

// Pop the last operation from the log, rebuild state
function undoLastOp(sessionId, session) {
  const lp = logPath(sessionId);
  let lines = [];
  if (existsSync(lp)) {
    lines = readFileSync(lp, 'utf-8').split('\n').filter(l => l.trim());
  }

  if (lines.length === 0) {
    // Nothing in log — would need to restore from previous snapshot, which we don't keep
    return false;
  }

  // Remove last line
  lines.pop();
  writeFileSync(lp, lines.length > 0 ? lines.join('\n') + '\n' : '');

  // Rebuild from snapshot + remaining log
  const rebuilt = loadSession(sessionId);
  session.elements = rebuilt.elements;
  session.appState = rebuilt.appState;
  session.viewport = rebuilt.viewport;
  return true;
}

// Session storage: sessionId -> { elements, clients, viewport }
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    const session = loadSession(id);
    sessions.set(id, session);
    if (session.elements.length > 0) {
      console.log(`[Persist] Restored session ${id}: ${session.elements.length} elements`);
    }
  }
  return sessions.get(id);
}

/**
 * Extract cameraUpdate pseudo-elements from an elements array.
 * Returns { drawElements, viewports } where viewports are camera commands
 * and drawElements are real Excalidraw elements.
 */
function extractViewportUpdates(elements) {
  const drawElements = [];
  const viewports = [];
  for (const el of elements) {
    if (el.type === 'cameraUpdate' || el.type === 'viewportUpdate') {
      viewports.push({ x: el.x || 0, y: el.y || 0, width: el.width || 800, height: el.height || 600 });
    } else {
      drawElements.push(el);
    }
  }
  return { drawElements, viewports };
}

function broadcast(session, msg) {
  const str = typeof msg === 'string' ? msg : JSON.stringify(msg);
  for (const client of session.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(str);
    }
  }
}

// --- WebSocket setup (noServer mode, attached to HTTP server below) ---

const wss = new WebSocketServer({ noServer: true });

// --- HTTP API Server (port 3062) ---

const app = express();
app.use(express.json({ limit: '50mb' }));

// CORS for local dev
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Health check
app.get('/health', (_req, res) => {
  const sessionCount = sessions.size;
  let clientCount = 0;
  for (const s of sessions.values()) clientCount += s.clients.size;
  res.json({ status: 'ok', sessions: sessionCount, clients: clientCount });
});

// List active sessions
app.get('/api/sessions', (_req, res) => {
  const list = [];
  for (const [id, session] of sessions) {
    list.push({
      id,
      elementCount: session.elements.length,
      clientCount: session.clients.size,
    });
  }
  res.json(list);
});

// Get session elements
app.get('/api/session/:id', (req, res) => {
  const session = getSession(req.params.id);
  res.json({
    id: req.params.id,
    elements: session.elements,
    appState: session.appState,
    viewport: session.viewport,
  });
});

// Replace all elements in a session (strips cameraUpdate pseudo-elements)
app.post('/api/session/:id/elements', (req, res) => {
  const session = getSession(req.params.id);
  const { elements, appState } = req.body;
  const { drawElements, viewports } = extractViewportUpdates(elements || []);

  session.elements = drawElements;
  if (appState) session.appState = appState;
  session._version++;
  appendLog(req.params.id, session, { type: 'set', elements: drawElements, appState: appState || null });

  // Send elements to all clients
  broadcast(session, {
    type: 'elements',
    elements: session.elements,
    appState: session.appState,
    version: session._version,
  });

  // Send viewport updates (use last one as the final camera position)
  if (viewports.length > 0) {
    const viewport = viewports[viewports.length - 1];
    session.viewport = viewport;
    appendLog(req.params.id, session, { type: 'viewport', viewport });
    broadcast(session, { type: 'viewport', viewport });
  }

  res.json({ success: true, elementCount: session.elements.length, clients: session.clients.size });
});

// Append elements to a session (strips cameraUpdate pseudo-elements)
app.post('/api/session/:id/append', (req, res) => {
  const session = getSession(req.params.id);
  const { elements } = req.body;

  if (elements && elements.length) {
    const { drawElements, viewports } = extractViewportUpdates(elements);

    if (drawElements.length > 0) {
      session.elements = [...session.elements, ...drawElements];
      appendLog(req.params.id, session, { type: 'append', elements: drawElements });
      broadcast(session, { type: 'append', elements: drawElements });
    }

    if (viewports.length > 0) {
      const viewport = viewports[viewports.length - 1];
      session.viewport = viewport;
      appendLog(req.params.id, session, { type: 'viewport', viewport });
      broadcast(session, { type: 'viewport', viewport });
    }
  }

  res.json({ success: true, elementCount: session.elements.length });
});

// Set viewport/camera directly
app.post('/api/session/:id/viewport', (req, res) => {
  const session = getSession(req.params.id);
  const { x, y, width, height } = req.body;

  const viewport = {
    x: x || 0,
    y: y || 0,
    width: width || 800,
    height: height || 600,
  };

  session.viewport = viewport;
  broadcast(session, { type: 'viewport', viewport });

  res.json({ success: true, viewport });
});

// Clear session
app.post('/api/session/:id/clear', (req, res) => {
  const session = getSession(req.params.id);

  // Version current state before clearing so it can be recovered
  if (session.elements.length > 0) {
    writeSnapshot(req.params.id, session);
  }

  session.elements = [];
  session.appState = null;
  session.viewport = null;
  session.files = {};
  deleteSessionFiles(req.params.id);

  broadcast(session, { type: 'clear' });

  res.json({ success: true });
});

// Undo last operation
app.post('/api/session/:id/undo', (req, res) => {
  const session = getSession(req.params.id);
  const success = undoLastOp(req.params.id, session);

  if (success) {
    broadcast(session, {
      type: 'elements',
      elements: session.elements,
      appState: session.appState,
    });
    res.json({ success: true, elementCount: session.elements.length });
  } else {
    res.json({ success: false, message: 'Nothing to undo' });
  }
});

// Upload a file (image) to DO Spaces
app.post('/api/session/:id/files', async (req, res) => {
  if (!isSpacesEnabled()) {
    return res.status(503).json({ error: 'Image storage not configured' });
  }

  const { fileId, dataURL, mimeType } = req.body;
  if (!fileId || !dataURL || !mimeType) {
    return res.status(400).json({ error: 'Missing fileId, dataURL, or mimeType' });
  }

  try {
    const session = getSession(req.params.id);

    // Skip if already uploaded
    if (session.files[fileId]) {
      return res.json({ success: true, fileId, cdnUrl: session.files[fileId].cdnUrl });
    }

    const cdnUrl = await uploadFile(req.params.id, fileId, dataURL, mimeType);

    session.files[fileId] = { id: fileId, cdnUrl, mimeType, created: Date.now() };
    saveFilesMeta(req.params.id, session.files);

    // Broadcast to other clients so they can fetch the image
    broadcast(session, { type: 'file-added', file: session.files[fileId] });

    console.log(`[Files] Uploaded ${fileId} for session ${req.params.id}`);
    res.json({ success: true, fileId, cdnUrl });
  } catch (err) {
    console.error('[Files] Upload error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Get file metadata for a session
app.get('/api/session/:id/files', (req, res) => {
  const session = getSession(req.params.id);
  res.json({ files: session.files || {} });
});

// Proxy file downloads to avoid CORS issues with DO Spaces
app.get('/api/session/:id/files/:fileId', async (req, res) => {
  const session = getSession(req.params.id);
  const fileMeta = session.files[req.params.fileId];
  if (!fileMeta) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    const upstream = await fetch(fileMeta.cdnUrl);
    if (!upstream.ok) throw new Error(`Upstream ${upstream.status}`);
    res.set('Content-Type', fileMeta.mimeType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.send(buffer);
  } catch (err) {
    console.error(`[Files] Proxy error for ${req.params.fileId}:`, err.message);
    res.status(502).json({ error: 'Failed to fetch file' });
  }
});

// --- Snapshot version API endpoints ---

// List available snapshot versions for a session
app.get('/api/session/:id/versions', (req, res) => {
  const sessionId = req.params.id;
  const versions = listSnapshots(sessionId);

  // Also include the current snapshot if it exists
  const sp = snapshotPath(sessionId);
  let current = null;
  if (existsSync(sp)) {
    try {
      const stat = statSync(sp);
      const data = JSON.parse(readFileSync(sp, 'utf-8'));
      current = {
        timestamp: Math.floor(stat.mtimeMs),
        elementCount: (data.elements || []).length,
        size: stat.size,
        isCurrent: true,
      };
    } catch {}
  }

  res.json({ current, versions });
});

// Restore a session from a specific versioned snapshot
app.post('/api/session/:id/restore', (req, res) => {
  const { timestamp } = req.body;
  if (!timestamp) {
    return res.status(400).json({ error: 'Missing timestamp' });
  }

  const result = restoreSnapshot(req.params.id, timestamp);
  if (result) {
    res.json({ success: true, ...result });
  } else {
    res.status(404).json({ error: 'Snapshot not found or restore failed' });
  }
});

// Serve built frontend (for containerized/production deployment)
const staticDir = join(import.meta.dirname, 'dist');
if (existsSync(staticDir)) {
  app.use(express.static(staticDir));
  // SPA fallback — serve index.html for non-API, non-WebSocket routes
  app.get('{*path}', (req, res, next) => {
    if (req.path.startsWith('/ws/') || req.path.startsWith('/api/')) return next();
    res.sendFile(join(staticDir, 'index.html'));
  });
  console.log(`[HTTP] Serving static files from ${staticDir}`);
}

const httpServer = createServer(app);

// Handle WebSocket upgrades on the same port as HTTP
httpServer.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url || '');
  const match = pathname?.match(/^\/ws\/(.+)$/);
  if (match) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  } else {
    socket.destroy();
  }
});

// Re-emit connections through the existing handler
wss.removeAllListeners('connection');
wss.on('connection', (ws, request) => {
  const { pathname } = parse(request.url || '');
  const sessionId = pathname?.match(/^\/ws\/(.+)$/)?.[1];
  if (!sessionId) { ws.close(); return; }

  const session = getSession(sessionId);
  session.clients.add(ws);

  console.log(`[WS] Client connected to session: ${sessionId} (${session.clients.size} clients)`);

  if (session.elements.length > 0) {
    ws.send(JSON.stringify({ type: 'elements', elements: session.elements, appState: session.appState, version: session._version }));
  }
  if (session.viewport) {
    ws.send(JSON.stringify({ type: 'viewport', viewport: session.viewport }));
  }
  if (session.files && Object.keys(session.files).length > 0) {
    ws.send(JSON.stringify({ type: 'files-meta', files: session.files }));
  }

  let persistTimer = null;

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'update') {
        // Reject stale updates: client must be based on the current version
        const baseVersion = msg.baseVersion;
        if (baseVersion !== undefined && baseVersion < session._version) {
          // Client is behind — send them the current state instead
          console.log(`[WS] Rejected stale update for ${sessionId}: client v${baseVersion} < server v${session._version}`);
          ws.send(JSON.stringify({ type: 'elements', elements: session.elements, appState: session.appState, version: session._version, source: 'version-correction' }));
          return;
        }

        session.elements = msg.elements;
        session._version++;

        // Track who made this edit
        const editorInfo = {
          clientId: msg.clientId || 'unknown',
          clientName: msg.clientName || '',
        };
        session._lastEditor = editorInfo;

        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(() => {
          appendLog(sessionId, session, { type: 'update', elements: session.elements });
        }, 500);
        for (const client of session.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({ type: 'elements', elements: msg.elements, version: session._version, editor: editorInfo }));
          }
        }
      }
    } catch (err) {
      console.error('[WS] Message parse error:', err);
    }
  });

  ws.on('close', () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      appendLog(sessionId, session, { type: 'update', elements: session.elements });
    }
    session.clients.delete(ws);
    console.log(`[WS] Client disconnected from session: ${sessionId} (${session.clients.size} clients)`);
    if (session.clients.size === 0) {
      setTimeout(() => {
        const s = sessions.get(sessionId);
        if (s && s.clients.size === 0) {
          if (s.elements.length > 0) writeSnapshot(sessionId, s);
          sessions.delete(sessionId);
          console.log(`[WS] Session evicted from memory: ${sessionId} (data persisted on disk)`);
        }
      }, 5 * 60 * 1000);
    }
  });
});

// Initialize DO Spaces client for image storage
if (initSpacesClient(process.env)) {
  console.log(`[Spaces] Image storage enabled (bucket: ${process.env.DO_SPACES_BUCKET})`);
} else {
  console.warn('[Spaces] Image storage disabled — set DO_SPACES_ACCESS_KEY, DO_SPACES_SECRET_KEY, DO_SPACES_BUCKET');
}

// --- Periodic snapshot flush (every 5 minutes) ---
// Ensures in-memory state reaches disk even without a graceful shutdown.
// Closes the SIGKILL gap: max data loss = 5 minutes server-side.

setInterval(() => {
  let flushed = 0;
  for (const [sessionId, session] of sessions) {
    const elapsed = Date.now() - (session._lastSnapshotAt || 0);
    if (elapsed >= SNAPSHOT_INTERVAL_MS && session.elements.length > 0) {
      try {
        writeSnapshot(sessionId, session);
        flushed++;
      } catch (err) {
        console.error(`[Persist] Periodic flush failed for ${sessionId}:`, err.message);
      }
    }
  }
  if (flushed > 0) {
    console.log(`[Persist] Periodic flush: wrote ${flushed} snapshot(s)`);
  }
}, SNAPSHOT_INTERVAL_MS);

httpServer.listen(PORT, () => {
  console.log(`[HTTP] API + WebSocket server running on port ${PORT}`);
});

// --- Graceful shutdown: flush all in-memory sessions to disk ---

function gracefulShutdown(signal) {
  console.log(`\n[Shutdown] Received ${signal}, flushing sessions...`);
  let flushed = 0;
  for (const [sessionId, session] of sessions) {
    if (session.elements.length > 0) {
      try {
        writeSnapshot(sessionId, session);
        flushed++;
      } catch (err) {
        console.error(`[Shutdown] Failed to flush session ${sessionId}:`, err.message);
      }
    }
  }
  console.log(`[Shutdown] Flushed ${flushed} sessions to disk`);
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
