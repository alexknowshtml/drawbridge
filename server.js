/**
 * Drawbridge - Real-time Excalidraw diagram server
 *
 * HTTP + WebSocket bridge that lets any AI (Claude, GPT, etc.) or script
 * push diagram elements to an Excalidraw canvas in real time.
 *
 * HTTP API (default port 3062, configurable via DRAWBRIDGE_API_PORT):
 *   POST /api/session/:id/elements - Replace all elements
 *   POST /api/session/:id/append  - Add elements (progressive drawing)
 *   POST /api/session/:id/clear   - Clear canvas
 *   POST /api/session/:id/viewport - Set camera position/zoom
 *   GET  /api/session/:id         - Get current elements
 *   GET  /api/sessions            - List active sessions
 *   GET  /health                  - Health check
 *
 * WebSocket (default port 3061, configurable via DRAWBRIDGE_WS_PORT):
 *   ws://host:PORT/ws/:sessionId  - Real-time bidirectional updates
 */

import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { parse } from 'url';

const WS_PORT = parseInt(process.env.DRAWBRIDGE_WS_PORT || '3061');
const API_PORT = parseInt(process.env.DRAWBRIDGE_API_PORT || '3062');

// Session storage: sessionId -> { elements, clients, viewport }
const sessions = new Map();

function getSession(id) {
  if (!sessions.has(id)) {
    sessions.set(id, { elements: [], appState: null, viewport: null, clients: new Set() });
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

// --- WebSocket Server (port 3061) ---

const wsServer = createServer();
const wss = new WebSocketServer({ noServer: true });

wsServer.on('upgrade', (request, socket, head) => {
  const { pathname } = parse(request.url || '');
  const match = pathname?.match(/^\/ws\/(.+)$/);

  if (!match) {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(request, socket, head, (ws) => {
    const sessionId = match[1];
    const session = getSession(sessionId);
    session.clients.add(ws);

    console.log(`[WS] Client connected to session: ${sessionId} (${session.clients.size} clients)`);

    // Send current state on connect
    if (session.elements.length > 0) {
      ws.send(JSON.stringify({
        type: 'elements',
        elements: session.elements,
        appState: session.appState,
      }));
    }
    // Send current viewport if set
    if (session.viewport) {
      ws.send(JSON.stringify({
        type: 'viewport',
        viewport: session.viewport,
      }));
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type === 'update') {
          session.elements = msg.elements;
          // Broadcast to other clients (not the sender)
          for (const client of session.clients) {
            if (client !== ws && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'elements',
                elements: msg.elements,
              }));
            }
          }
        }
      } catch (err) {
        console.error('[WS] Message parse error:', err);
      }
    });

    ws.on('close', () => {
      session.clients.delete(ws);
      console.log(`[WS] Client disconnected from session: ${sessionId} (${session.clients.size} clients)`);
      // Clean up empty sessions after 5 minutes
      if (session.clients.size === 0) {
        setTimeout(() => {
          const s = sessions.get(sessionId);
          if (s && s.clients.size === 0) {
            sessions.delete(sessionId);
            console.log(`[WS] Session cleaned up: ${sessionId}`);
          }
        }, 5 * 60 * 1000);
      }
    });
  });
});

wsServer.listen(WS_PORT, () => {
  console.log(`[WS] WebSocket server running on port ${WS_PORT}`);
});

// --- HTTP API Server (port 3062) ---

const app = express();
app.use(express.json({ limit: '10mb' }));

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

  // Send elements to all clients
  broadcast(session, {
    type: 'elements',
    elements: session.elements,
    appState: session.appState,
  });

  // Send viewport updates (use last one as the final camera position)
  if (viewports.length > 0) {
    const viewport = viewports[viewports.length - 1];
    session.viewport = viewport;
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
      broadcast(session, { type: 'append', elements: drawElements });
    }

    if (viewports.length > 0) {
      const viewport = viewports[viewports.length - 1];
      session.viewport = viewport;
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
  session.elements = [];
  session.appState = null;
  session.viewport = null;

  broadcast(session, { type: 'clear' });

  res.json({ success: true });
});

app.listen(API_PORT, () => {
  console.log(`[HTTP] API server running on port ${API_PORT}`);
});
