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
  if (elements.some((el: any) => el.label)) return true;
  if (elements.some((el: any) => !el.seed)) return true;
  return false;
}

// Use Excalidraw's built-in converter with font preloading and label defaults
async function sanitizeElements(elements: any[]): Promise<any[]> {
  if (!Array.isArray(elements)) return [];
  try {
    await ensureFontsLoaded();

    if (!needsConversion(elements)) {
      return elements;
    }

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

    const freqs: Record<string, number> = {
      rectangle: 800, ellipse: 600, diamond: 700,
      arrow: 1000, line: 900, text: 500,
    };
    osc.frequency.value = freqs[type] || 750;
    osc.type = 'sine';

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

// Build API base URL (same host in prod, different port in dev)
function getApiBase(): string {
  const protocol = window.location.protocol;
  const host = protocol === 'https:'
    ? window.location.host
    : `${window.location.hostname}:3062`;
  return `${protocol}//${host}/api`;
}

// Fetch an image via server proxy and convert to BinaryFileData for Excalidraw
async function fetchFileAsDataURL(
  sessionId: string,
  file: { id: string; cdnUrl: string; mimeType: string; created: number }
): Promise<{ id: string; dataURL: string; mimeType: string; created: number } | null> {
  try {
    // Use same-origin proxy to avoid CORS issues with DO Spaces
    const proxyUrl = `${getApiBase()}/session/${sessionId}/files/${file.id}`;
    const resp = await fetch(proxyUrl);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const dataURL = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { id: file.id, dataURL: dataURL as any, mimeType: file.mimeType, created: file.created };
  } catch (err) {
    console.error(`[Files] Failed to load ${file.id}:`, err);
    return null;
  }
}

interface Viewport {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FileMeta {
  id: string;
  cdnUrl: string;
  mimeType: string;
  created: number;
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

  // Use ref for excalidrawAPI so WebSocket handler doesn't need to reconnect
  const apiRef = useRef<any>(null);
  useEffect(() => { apiRef.current = excalidrawAPI; }, [excalidrawAPI]);

  // Track which files we've already uploaded or loaded
  const knownFileIds = useRef<Set<string>>(new Set());
  const uploadingFileIds = useRef<Set<string>>(new Set());

  // Preload fonts and load cached elements on mount
  useEffect(() => {
    ensureFontsLoaded();
    const cached = loadFromStorage(sessionId);
    if (cached && cached.length > 0) {
      setCachedElements(cached);
      lastElementCount.current = cached.length;
    }
  }, [sessionId]);

  // Upload new files to the server
  const uploadNewFiles = useCallback(async (files: Record<string, any>) => {
    if (!files) return;
    const apiBase = getApiBase();

    for (const [fileId, fileData] of Object.entries(files)) {
      if (knownFileIds.current.has(fileId) || uploadingFileIds.current.has(fileId)) continue;
      if (!fileData.dataURL) continue;

      uploadingFileIds.current.add(fileId);

      try {
        const resp = await fetch(`${apiBase}/session/${sessionId}/files`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fileId: fileData.id || fileId,
            dataURL: fileData.dataURL,
            mimeType: fileData.mimeType,
          }),
        });

        if (resp.ok) {
          const result = await resp.json();
          knownFileIds.current.add(fileId);
          console.log(`[Files] Uploaded ${fileId} → ${result.cdnUrl}`);
        } else {
          console.error(`[Files] Upload failed for ${fileId}:`, await resp.text());
        }
      } catch (err) {
        console.error(`[Files] Upload error for ${fileId}:`, err);
      } finally {
        uploadingFileIds.current.delete(fileId);
      }
    }
  }, [sessionId]);

  // Load files from server metadata and add to Excalidraw
  const loadFilesFromMeta = useCallback(async (filesMeta: Record<string, FileMeta>) => {
    if (!filesMeta || Object.keys(filesMeta).length === 0) return;

    const toLoad = Object.values(filesMeta).filter(f => !knownFileIds.current.has(f.id));
    if (toLoad.length === 0) return;

    console.log(`[Files] Loading ${toLoad.length} images from CDN...`);

    const loaded = (await Promise.all(toLoad.map(f => fetchFileAsDataURL(sessionId, f)))).filter(
      (f): f is NonNullable<typeof f> => f !== null
    );

    if (loaded.length > 0) {
      // Wait for API to be ready (it might arrive before Excalidraw mounts)
      const waitForApi = () => new Promise<void>((resolve) => {
        const check = () => {
          if (apiRef.current) { resolve(); return; }
          setTimeout(check, 100);
        };
        check();
      });
      await waitForApi();

      apiRef.current.addFiles(loaded);
      for (const f of loaded) knownFileIds.current.add(f.id);
      console.log(`[Files] Loaded ${loaded.length} images`);
    }
  }, []);

  // Connect to WebSocket server — runs once on mount, uses refs for API access
  useEffect(() => {
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsHost = window.location.protocol === 'https:'
      ? window.location.host
      : `${window.location.hostname}:3062`;
    const wsUrl = `${wsProtocol}//${wsHost}/ws/${sessionId}`;

    let ws: WebSocket | null = null;
    let timer: number | null = null;
    let destroyed = false;

    function connect() {
      if (destroyed) return;

      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onopen = () => {
          setConnected(true);
          setStatus(`Connected - Session: ${sessionId}`);
          if (timer) { clearTimeout(timer); timer = null; }
        };

        ws.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);
            const api = apiRef.current;

            if (msg.type === 'elements' && api) {
              isRemoteUpdate.current = true;
              const clean = await sanitizeElements(msg.elements);
              api.updateScene({ elements: clean });
              if (msg.appState) {
                api.updateScene({ appState: msg.appState });
              }
              const prevCount = lastElementCount.current;
              for (let i = prevCount; i < clean.length; i++) {
                playPencilSound(clean[i].type || 'rectangle');
              }
              lastElementCount.current = clean.length;
              saveToStorage(sessionId, clean);
              setTimeout(() => { isRemoteUpdate.current = false; }, 100);
              setStatus(`Connected - Session: ${sessionId} - ${clean.length} elements`);
            } else if (msg.type === 'append' && api) {
              isRemoteUpdate.current = true;
              const current = api.getSceneElements();
              const clean = await sanitizeElements(msg.elements);
              const allElements = [...current, ...clean];
              api.updateScene({ elements: allElements });
              for (const el of clean) {
                playPencilSound(el.type || 'rectangle');
              }
              lastElementCount.current = allElements.length;
              saveToStorage(sessionId, allElements);
              setTimeout(() => { isRemoteUpdate.current = false; }, 100);
            } else if (msg.type === 'viewport') {
              const api2 = apiRef.current;
              if (!api2) return;
              const container = document.querySelector('.excalidraw') as HTMLElement;
              if (!container) return;
              const canvasWidth = container.clientWidth;
              const canvasHeight = container.clientHeight;
              const viewport = msg.viewport as Viewport;
              const zoomX = canvasWidth / viewport.width;
              const zoomY = canvasHeight / viewport.height;
              const zoom = Math.min(zoomX, zoomY);
              const scrollX = -viewport.x * zoom + (canvasWidth - viewport.width * zoom) / 2;
              const scrollY = -viewport.y * zoom + (canvasHeight - viewport.height * zoom) / 2;
              isRemoteUpdate.current = true;
              api2.updateScene({
                appState: {
                  scrollX: scrollX / zoom,
                  scrollY: scrollY / zoom,
                  zoom: { value: zoom },
                },
              });
              setTimeout(() => { isRemoteUpdate.current = false; }, 200);
            } else if (msg.type === 'files-meta') {
              await loadFilesFromMeta(msg.files);
            } else if (msg.type === 'file-added') {
              if (!knownFileIds.current.has(msg.file.id)) {
                const loaded = await fetchFileAsDataURL(sessionId, msg.file);
                if (loaded && apiRef.current) {
                  apiRef.current.addFiles([loaded]);
                  knownFileIds.current.add(loaded.id);
                  console.log(`[Files] Received new file from collaborator: ${loaded.id}`);
                }
              }
            } else if (msg.type === 'clear' && api) {
              isRemoteUpdate.current = true;
              api.resetScene();
              lastElementCount.current = 0;
              knownFileIds.current.clear();
              clearStorage(sessionId);
              setTimeout(() => { isRemoteUpdate.current = false; }, 100);
            }
          } catch (err) {
            console.error('WebSocket message error:', err);
          }
        };

        ws.onclose = () => {
          if (destroyed) return;
          setConnected(false);
          setStatus('Disconnected - retrying in 5s...');
          wsRef.current = null;
          timer = window.setTimeout(connect, 5000);
        };

        ws.onerror = () => {
          setStatus('Connection error - will retry...');
        };
      } catch {
        setStatus('WebSocket unavailable - offline mode');
      }
    }

    connect();

    return () => {
      destroyed = true;
      if (ws) ws.close();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, loadFilesFromMeta]);

  // Send changes back to server when user edits
  const onChange = useCallback(
    (elements: readonly any[], _appState: any) => {
      if (isRemoteUpdate.current) return;

      const activeElements = elements.filter((el: any) => !el.isDeleted);

      saveToStorage(sessionId, activeElements as any[]);

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;

      wsRef.current.send(JSON.stringify({
        type: 'update',
        elements: activeElements,
      }));

      // Check for new image files via API (more reliable than onChange 3rd arg)
      const api = apiRef.current;
      if (api) {
        const files = api.getFiles();
        if (files && Object.keys(files).length > 0) {
          uploadNewFiles(files);
        }
      }
    },
    [sessionId, uploadNewFiles]
  );

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Status bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 8,
          left: '50%',
          transform: 'translateX(-50%)',
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
