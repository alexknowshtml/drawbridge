import { useState, useEffect, useCallback, useRef } from 'react';
import { Excalidraw, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';

// Get session ID from URL hash or generate one
function getSessionId(): string {
  const hash = window.location.hash.slice(1);
  if (hash) return hash;
  return 'default';
}

// Font preloading — ensure Excalidraw fonts are ready before text measurement
let fontsReady: Promise<void> | null = null;
function ensureFontsLoaded(): Promise<void> {
  if (!fontsReady) {
    fontsReady = Promise.all([
      document.fonts.load('20px Excalifont'),
      document.fonts.load('400 16px Assistant'),
      document.fonts.load('500 16px Assistant'),
      document.fonts.load('700 16px Assistant'),
    ]).then(() => {});
  }
  return fontsReady;
}

// Detect whether elements are skeleton format (need conversion) or already fully converted
function needsConversion(elements: any[]): boolean {
  // If any element has a `label` property, it's skeleton format from the skill
  if (elements.some((el: any) => el.label)) return true;
  // If any element lacks Excalidraw internals like `seed`, it needs conversion
  if (elements.some((el: any) => !el.seed)) return true;
  return false;
}

// Use Excalidraw's built-in converter with font preloading and label defaults
async function sanitizeElements(elements: any[]): Promise<any[]> {
  if (!Array.isArray(elements)) return [];
  try {
    await ensureFontsLoaded();

    if (!needsConversion(elements)) {
      // Already fully converted — pass through as-is
      return elements;
    }

    // Add label defaults (textAlign/verticalAlign) like the original MCP app does
    const withDefaults = elements.map((el: any) =>
      el.label ? { ...el, label: { textAlign: 'center', verticalAlign: 'middle', ...el.label } } : el
    );
    return convertToExcalidrawElements(withDefaults, { regenerateIds: false }) as any[];
  } catch (e) {
    console.error('convertToExcalidrawElements failed, passing through:', e);
    return elements;
  }
}

// Simple pencil stroke sound using Web Audio API
// Defer AudioContext creation until first user gesture (browser requirement)
let audioCtx: AudioContext | null = null;
function getAudioContext(): AudioContext | null {
  if (!audioCtx && typeof AudioContext !== 'undefined') {
    audioCtx = new AudioContext();
  }
  if (audioCtx?.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}
// Initialize audio on first user interaction
if (typeof document !== 'undefined') {
  const initAudio = () => {
    getAudioContext();
    document.removeEventListener('click', initAudio);
    document.removeEventListener('keydown', initAudio);
  };
  document.addEventListener('click', initAudio, { once: true });
  document.addEventListener('keydown', initAudio, { once: true });
}

function playPencilSound(type: string) {
  const ctx = getAudioContext();
  if (!ctx || ctx.state !== 'running') return;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);

    // Different frequencies for different element types
    const freqs: Record<string, number> = {
      rectangle: 800, ellipse: 600, diamond: 700,
      arrow: 1000, line: 900, text: 500,
    };
    osc.frequency.value = freqs[type] || 750;
    osc.type = 'sine';

    // Short scratchy burst
    gain.gain.setValueAtTime(0.03, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.08);
  } catch {
    // Audio failures are non-critical
  }
}

// localStorage persistence — cache elements per session
const STORAGE_PREFIX = 'drawbridge:';

function saveToStorage(sessionId: string, elements: any[]) {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${sessionId}`, JSON.stringify(elements));
  } catch {
    // Storage full or unavailable — non-critical
  }
}

function loadFromStorage(sessionId: string): any[] | null {
  try {
    const stored = localStorage.getItem(`${STORAGE_PREFIX}${sessionId}`);
    if (stored) return JSON.parse(stored);
  } catch {
    // Parse error — ignore
  }
  return null;
}

function clearStorage(sessionId: string) {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${sessionId}`);
  } catch {
    // Non-critical
  }
}

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

export default function App() {
  const [excalidrawAPI, setExcalidrawAPI] = useState<any>(null);
  const [connected, setConnected] = useState(false);
  const [sessionId] = useState(getSessionId);
  const [status, setStatus] = useState('Connecting...');
  const wsRef = useRef<WebSocket | null>(null);
  const isRemoteUpdate = useRef(false);
  const reconnectTimer = useRef<number | null>(null);
  const lastElementCount = useRef(0);
  const [cachedElements, setCachedElements] = useState<any[] | null>(null);

  // Preload fonts and load cached elements on mount
  useEffect(() => {
    ensureFontsLoaded();
    const cached = loadFromStorage(sessionId);
    if (cached && cached.length > 0) {
      setCachedElements(cached);
      lastElementCount.current = cached.length;
    }
  }, [sessionId]);

  // Apply viewport: convert scene-space rect to Excalidraw scrollX/scrollY/zoom
  const applyViewport = useCallback((viewport: Viewport) => {
    if (!excalidrawAPI) return;
    const container = document.querySelector('.excalidraw') as HTMLElement;
    if (!container) return;

    const canvasWidth = container.clientWidth;
    const canvasHeight = container.clientHeight;

    // Calculate zoom to fit viewport rect into canvas
    const zoomX = canvasWidth / viewport.width;
    const zoomY = canvasHeight / viewport.height;
    const zoom = Math.min(zoomX, zoomY);

    // Calculate scroll to center the viewport in the canvas
    const scrollX = -viewport.x * zoom + (canvasWidth - viewport.width * zoom) / 2;
    const scrollY = -viewport.y * zoom + (canvasHeight - viewport.height * zoom) / 2;

    isRemoteUpdate.current = true;
    excalidrawAPI.updateScene({
      appState: {
        scrollX: scrollX / zoom,
        scrollY: scrollY / zoom,
        zoom: { value: zoom },
      },
    });
    setTimeout(() => { isRemoteUpdate.current = false; }, 200);
  }, [excalidrawAPI]);

  // Connect to WebSocket server with retry (no page reload)
  const connectWs = useCallback(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.hostname}:3061/ws/${sessionId}`;

    try {
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        setConnected(true);
        setStatus(`Connected - Session: ${sessionId}`);
        if (reconnectTimer.current) {
          clearTimeout(reconnectTimer.current);
          reconnectTimer.current = null;
        }
      };

      ws.onmessage = async (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === 'elements' && excalidrawAPI) {
            isRemoteUpdate.current = true;
            const clean = await sanitizeElements(msg.elements);
            excalidrawAPI.updateScene({ elements: clean });
            if (msg.appState) {
              excalidrawAPI.updateScene({ appState: msg.appState });
            }
            // Play sounds for new elements
            const prevCount = lastElementCount.current;
            for (let i = prevCount; i < clean.length; i++) {
              playPencilSound(clean[i].type || 'rectangle');
            }
            lastElementCount.current = clean.length;
            saveToStorage(sessionId, clean);
            setTimeout(() => { isRemoteUpdate.current = false; }, 100);
            setStatus(`Connected - Session: ${sessionId} - ${clean.length} elements`);
          } else if (msg.type === 'append' && excalidrawAPI) {
            isRemoteUpdate.current = true;
            const current = excalidrawAPI.getSceneElements();
            const clean = await sanitizeElements(msg.elements);
            const allElements = [...current, ...clean];
            excalidrawAPI.updateScene({ elements: allElements });
            // Play sounds for appended elements
            for (const el of clean) {
              playPencilSound(el.type || 'rectangle');
            }
            lastElementCount.current = allElements.length;
            saveToStorage(sessionId, allElements);
            setTimeout(() => { isRemoteUpdate.current = false; }, 100);
          } else if (msg.type === 'viewport' && excalidrawAPI) {
            applyViewport(msg.viewport);
          } else if (msg.type === 'clear' && excalidrawAPI) {
            isRemoteUpdate.current = true;
            excalidrawAPI.resetScene();
            lastElementCount.current = 0;
            clearStorage(sessionId);
            setTimeout(() => { isRemoteUpdate.current = false; }, 100);
          }
        } catch (err) {
          console.error('WebSocket message error:', err);
        }
      };

      ws.onclose = () => {
        setConnected(false);
        setStatus('Disconnected - retrying in 5s...');
        wsRef.current = null;
        // Retry connection after 5 seconds (no page reload)
        reconnectTimer.current = window.setTimeout(connectWs, 5000);
      };

      ws.onerror = () => {
        setStatus('Connection error - will retry...');
      };
    } catch {
      setStatus('WebSocket unavailable - offline mode');
    }
  }, [sessionId, excalidrawAPI, applyViewport]);

  useEffect(() => {
    connectWs();
    return () => {
      if (wsRef.current) wsRef.current.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [connectWs]);

  // Send changes back to server when user edits
  const onChange = useCallback(
    (elements: readonly any[]) => {
      if (isRemoteUpdate.current) return;

      const activeElements = elements.filter((el: any) => !el.isDeleted);

      // Always save to localStorage, even if WebSocket is disconnected
      saveToStorage(sessionId, activeElements as any[]);

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      wsRef.current.send(JSON.stringify({
        type: 'update',
        elements: activeElements,
      }));
    },
    [sessionId]
  );

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Status bar */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          zIndex: 10,
          background: connected ? '#d3f9d8' : '#ffe3e3',
          color: connected ? '#2f9e44' : '#c92a2a',
          padding: '4px 12px',
          borderRadius: 6,
          fontSize: 12,
          fontFamily: 'system-ui',
          border: `1px solid ${connected ? '#b2f2bb' : '#ffc9c9'}`,
        }}
      >
        {status}
      </div>

      <Excalidraw
        excalidrawAPI={(api: any) => setExcalidrawAPI(api)}
        onChange={onChange}
        initialData={{
          elements: cachedElements || [],
          appState: {
            viewBackgroundColor: '#ffffff',
            theme: 'light' as const,
          },
        }}
      />
    </div>
  );
}
