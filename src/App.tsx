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

// --- IndexedDB Version History ---

const IDB_NAME = 'drawbridge-history';
const IDB_STORE = 'versions';
const IDB_VERSION = 1;
const MAX_VERSIONS_PER_SESSION = 20;
const VERSION_SAVE_THROTTLE_MS = 30_000; // 30 seconds

interface VersionEntry {
  id?: number; // auto-increment key
  timestamp: number;
  sessionId: string;
  elements: any[];
  elementCount: number;
  source: 'local' | 'server' | 'restored' | 'conflict-local' | 'conflict-server';
}

class VersionHistory {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(IDB_NAME, IDB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) {
          const store = db.createObjectStore(IDB_STORE, { keyPath: 'id', autoIncrement: true });
          store.createIndex('sessionId', 'sessionId', { unique: false });
          store.createIndex('session-timestamp', ['sessionId', 'timestamp'], { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async saveVersion(sessionId: string, elements: any[], source: VersionEntry['source'] = 'local'): Promise<void> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const entry: Omit<VersionEntry, 'id'> = {
        timestamp: Date.now(),
        sessionId,
        elements,
        elementCount: elements.length,
        source,
      };
      store.add(entry);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error('[VersionHistory] Save failed:', err);
    }
  }

  async getLatestVersion(sessionId: string): Promise<VersionEntry | null> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const index = store.index('session-timestamp');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
      const request = index.openCursor(range, 'prev');
      return new Promise((resolve, reject) => {
        request.onsuccess = () => {
          const cursor = request.result;
          resolve(cursor ? cursor.value : null);
        };
        request.onerror = () => reject(request.error);
      });
    } catch {
      return null;
    }
  }

  async listVersions(sessionId: string): Promise<VersionEntry[]> {
    try {
      const db = await this.dbPromise;
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const index = store.index('session-timestamp');
      const range = IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]);
      const request = index.getAll(range);
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve((request.result || []).reverse()); // newest first
        request.onerror = () => reject(request.error);
      });
    } catch {
      return [];
    }
  }

  async pruneOldVersions(sessionId: string): Promise<void> {
    try {
      const versions = await this.listVersions(sessionId);
      if (versions.length <= MAX_VERSIONS_PER_SESSION) return;
      const toDelete = versions.slice(MAX_VERSIONS_PER_SESSION);
      const db = await this.dbPromise;
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      for (const v of toDelete) {
        if (v.id !== undefined) store.delete(v.id);
      }
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } catch (err) {
      console.error('[VersionHistory] Prune failed:', err);
    }
  }
}

const versionHistory = new VersionHistory();

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

  // Conflict resolution state
  const [conflict, setConflict] = useState<{
    localElements: any[];
    serverElements: any[];
    viewing: 'local' | 'server';
  } | null>(null);

  // Version history panel
  const [showHistory, setShowHistory] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<VersionEntry[]>([]);
  const [serverVersions, setServerVersions] = useState<any[]>([]);
  const [previewingVersion, setPreviewingVersion] = useState<number | null>(null);
  const previewOriginalElements = useRef<any[] | null>(null);

  // Throttle IndexedDB saves
  const lastVersionSave = useRef(0);

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
              const serverElements = await sanitizeElements(msg.elements);
              const localElements = api.getSceneElements().filter((el: any) => !el.isDeleted);

              // Compare element IDs to detect conflicts
              const localIds = localElements.map((el: any) => el.id).sort().join(',');
              const serverIds = serverElements.map((el: any) => el.id).sort().join(',');
              const hasConflict = localIds !== serverIds && localElements.length > 0;

              if (hasConflict && !msg.source) {
                // Save both states to IndexedDB
                await versionHistory.saveVersion(sessionId, localElements, 'conflict-local');
                await versionHistory.saveVersion(sessionId, serverElements, 'conflict-server');

                // Show conflict banner - don't apply server state yet
                setConflict({
                  localElements,
                  serverElements,
                  viewing: 'local',
                });
                setStatus(`Connected - Session: ${sessionId} - CONFLICT DETECTED`);
              } else {
                // No conflict or this is a restore broadcast - apply silently
                isRemoteUpdate.current = true;
                api.updateScene({ elements: serverElements });
                if (msg.appState) {
                  api.updateScene({ appState: msg.appState });
                }
                const prevCount = lastElementCount.current;
                for (let i = prevCount; i < serverElements.length; i++) {
                  playPencilSound(serverElements[i].type || 'rectangle');
                }
                lastElementCount.current = serverElements.length;
                saveToStorage(sessionId, serverElements);

                // Save to IndexedDB (throttled)
                const now = Date.now();
                if (now - lastVersionSave.current > VERSION_SAVE_THROTTLE_MS) {
                  lastVersionSave.current = now;
                  versionHistory.saveVersion(sessionId, serverElements, msg.source === 'restore' ? 'restored' : 'server');
                  versionHistory.pruneOldVersions(sessionId);
                }

                setTimeout(() => { isRemoteUpdate.current = false; }, 100);
                setStatus(`Connected - Session: ${sessionId} - ${serverElements.length} elements`);
              }
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

      // Save to IndexedDB (throttled to every 30s)
      const now = Date.now();
      if (now - lastVersionSave.current > VERSION_SAVE_THROTTLE_MS) {
        lastVersionSave.current = now;
        versionHistory.saveVersion(sessionId, activeElements as any[], 'local');
        versionHistory.pruneOldVersions(sessionId);
      }

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

  // --- Conflict resolution handlers ---

  const resolveConflict = useCallback((choice: 'local' | 'server') => {
    if (!conflict || !excalidrawAPI) return;
    const elements = choice === 'local' ? conflict.localElements : conflict.serverElements;

    isRemoteUpdate.current = true;
    excalidrawAPI.updateScene({ elements });
    lastElementCount.current = elements.length;
    saveToStorage(sessionId, elements);
    versionHistory.saveVersion(sessionId, elements, 'restored');

    // Push chosen state to server
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'update', elements }));
    }

    setConflict(null);
    setTimeout(() => { isRemoteUpdate.current = false; }, 100);
    setStatus(`Connected - Session: ${sessionId} - ${elements.length} elements`);
  }, [conflict, excalidrawAPI, sessionId]);

  const toggleConflictView = useCallback(() => {
    if (!conflict || !excalidrawAPI) return;
    const next = conflict.viewing === 'local' ? 'server' : 'local';
    const elements = next === 'local' ? conflict.localElements : conflict.serverElements;
    isRemoteUpdate.current = true;
    excalidrawAPI.updateScene({ elements });
    setTimeout(() => { isRemoteUpdate.current = false; }, 100);
    setConflict({ ...conflict, viewing: next });
  }, [conflict, excalidrawAPI]);

  // --- Version history handlers ---

  const loadHistoryEntries = useCallback(async () => {
    const local = await versionHistory.listVersions(sessionId);
    setHistoryEntries(local);

    try {
      const resp = await fetch(`${getApiBase()}/session/${sessionId}/versions`);
      if (resp.ok) {
        const data = await resp.json();
        setServerVersions(data.versions || []);
      }
    } catch {
      setServerVersions([]);
    }
  }, [sessionId]);

  const openHistory = useCallback(() => {
    loadHistoryEntries();
    setShowHistory(true);
  }, [loadHistoryEntries]);

  const previewVersion = useCallback((elements: any[]) => {
    if (!excalidrawAPI) return;
    if (!previewOriginalElements.current) {
      previewOriginalElements.current = excalidrawAPI.getSceneElements().filter((el: any) => !el.isDeleted);
    }
    isRemoteUpdate.current = true;
    excalidrawAPI.updateScene({ elements });
    setPreviewingVersion(Date.now());
    setTimeout(() => { isRemoteUpdate.current = false; }, 100);
  }, [excalidrawAPI]);

  const cancelPreview = useCallback(() => {
    if (!excalidrawAPI || !previewOriginalElements.current) return;
    isRemoteUpdate.current = true;
    excalidrawAPI.updateScene({ elements: previewOriginalElements.current });
    previewOriginalElements.current = null;
    setPreviewingVersion(null);
    setTimeout(() => { isRemoteUpdate.current = false; }, 100);
  }, [excalidrawAPI]);

  const restoreVersion = useCallback(async (elements: any[], source: 'local' | 'server', serverTimestamp?: number) => {
    if (!excalidrawAPI) return;

    if (source === 'server' && serverTimestamp) {
      // Restore via server API
      try {
        await fetch(`${getApiBase()}/session/${sessionId}/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ timestamp: serverTimestamp }),
        });
      } catch (err) {
        console.error('[History] Server restore failed:', err);
      }
    } else {
      // Local restore: apply + push to server
      isRemoteUpdate.current = true;
      excalidrawAPI.updateScene({ elements });
      lastElementCount.current = elements.length;
      saveToStorage(sessionId, elements);
      await versionHistory.saveVersion(sessionId, elements, 'restored');

      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'update', elements }));
      }
      setTimeout(() => { isRemoteUpdate.current = false; }, 100);
    }

    previewOriginalElements.current = null;
    setPreviewingVersion(null);
    setShowHistory(false);
    setStatus(`Connected - Session: ${sessionId} - ${elements.length} elements (restored)`);
  }, [excalidrawAPI, sessionId]);

  // Ctrl+H keyboard shortcut for history
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'h') {
        e.preventDefault();
        if (showHistory) {
          if (previewingVersion) cancelPreview();
          setShowHistory(false);
        } else {
          openHistory();
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [showHistory, previewingVersion, cancelPreview, openHistory]);

  // Merge local + server versions for the history panel
  const allVersions = (() => {
    const merged: Array<{
      timestamp: number;
      elementCount: number;
      source: string;
      elements?: any[];
      serverTimestamp?: number;
    }> = [];

    for (const entry of historyEntries) {
      merged.push({
        timestamp: entry.timestamp,
        elementCount: entry.elementCount,
        source: entry.source,
        elements: entry.elements,
      });
    }

    for (const sv of serverVersions) {
      // Skip if we already have a client entry within 2s of this timestamp
      const hasDupe = historyEntries.some(e => Math.abs(e.timestamp - sv.timestamp) < 2000);
      if (!hasDupe) {
        merged.push({
          timestamp: sv.timestamp,
          elementCount: sv.elementCount,
          source: 'server-backup',
          serverTimestamp: sv.timestamp,
        });
      }
    }

    merged.sort((a, b) => b.timestamp - a.timestamp);
    return merged;
  })();

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Conflict resolution banner */}
      {conflict && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, zIndex: 100,
          background: '#fff3cd', borderBottom: '2px solid #ffc107',
          padding: '10px 16px', display: 'flex', alignItems: 'center',
          gap: 12, fontFamily: 'system-ui', fontSize: 13,
        }}>
          <span style={{ fontWeight: 600, color: '#856404' }}>
            Your canvas differs from the server.
          </span>
          <button onClick={toggleConflictView} style={{
            padding: '4px 12px', borderRadius: 4, border: '1px solid #856404',
            background: conflict.viewing === 'local' ? '#856404' : 'transparent',
            color: conflict.viewing === 'local' ? '#fff' : '#856404',
            cursor: 'pointer', fontSize: 12,
          }}>Mine</button>
          <button onClick={toggleConflictView} style={{
            padding: '4px 12px', borderRadius: 4, border: '1px solid #856404',
            background: conflict.viewing === 'server' ? '#856404' : 'transparent',
            color: conflict.viewing === 'server' ? '#fff' : '#856404',
            cursor: 'pointer', fontSize: 12,
          }}>Server's</button>
          <div style={{ flex: 1 }} />
          <button onClick={() => resolveConflict('local')} style={{
            padding: '5px 14px', borderRadius: 4, border: 'none',
            background: '#2f9e44', color: '#fff', cursor: 'pointer',
            fontWeight: 600, fontSize: 12,
          }}>Keep mine</button>
          <button onClick={() => resolveConflict('server')} style={{
            padding: '5px 14px', borderRadius: 4, border: 'none',
            background: '#1971c2', color: '#fff', cursor: 'pointer',
            fontWeight: 600, fontSize: 12,
          }}>Use server's</button>
        </div>
      )}

      {/* History button — matches Excalidraw undo/redo style, positioned beside them */}
      <button
        onClick={showHistory ? () => { if (previewingVersion) cancelPreview(); setShowHistory(false); } : openHistory}
        title="Version History (Ctrl+H)"
        style={{
          position: 'absolute', bottom: 80, left: 16, zIndex: 50,
          width: 36, height: 36, borderRadius: 8,
          border: 'none', background: showHistory ? '#d0ebff' : '#ececf4',
          cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.05)',
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#495057" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </svg>
      </button>

      {/* Version history panel */}
      {showHistory && (
        <div style={{
          position: 'absolute', top: 0, right: 0, bottom: 0, width: 320,
          zIndex: 90, background: '#fff', borderLeft: '1px solid #dee2e6',
          display: 'flex', flexDirection: 'column', fontFamily: 'system-ui',
          boxShadow: '-2px 0 8px rgba(0,0,0,0.1)',
        }}>
          <div style={{
            padding: '12px 16px', borderBottom: '1px solid #dee2e6',
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          }}>
            <span style={{ fontWeight: 600, fontSize: 14 }}>Version History</span>
            <button onClick={() => { if (previewingVersion) cancelPreview(); setShowHistory(false); }} style={{
              background: 'none', border: 'none', cursor: 'pointer', fontSize: 18, color: '#868e96',
            }}>&times;</button>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
            {allVersions.length === 0 ? (
              <div style={{ padding: '20px 16px', color: '#868e96', fontSize: 13, textAlign: 'center' }}>
                No version history yet. Edits are saved automatically.
              </div>
            ) : allVersions.map((v, i) => (
              <div key={`${v.timestamp}-${i}`} style={{
                padding: '8px 16px', borderBottom: '1px solid #f1f3f5',
                display: 'flex', flexDirection: 'column', gap: 4,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 12, color: '#495057' }}>
                    {new Date(v.timestamp).toLocaleString()}
                  </span>
                  <span style={{
                    fontSize: 10, padding: '1px 6px', borderRadius: 3,
                    background: v.source === 'local' ? '#d3f9d8' :
                      v.source === 'server' ? '#d0ebff' :
                      v.source === 'restored' ? '#e7f5ff' :
                      v.source === 'server-backup' ? '#fff3bf' :
                      v.source.startsWith('conflict') ? '#ffe3e3' : '#f1f3f5',
                    color: '#495057',
                  }}>
                    {v.source}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span style={{ fontSize: 11, color: '#868e96' }}>{v.elementCount} elements</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {v.elements && (
                      <button onClick={() => previewVersion(v.elements!)} style={{
                        padding: '2px 8px', borderRadius: 3, border: '1px solid #dee2e6',
                        background: '#fff', cursor: 'pointer', fontSize: 11, color: '#495057',
                      }}>Preview</button>
                    )}
                    <button onClick={() => {
                      if (v.elements) {
                        restoreVersion(v.elements, 'local');
                      } else if (v.serverTimestamp) {
                        restoreVersion([], 'server', v.serverTimestamp);
                      }
                    }} style={{
                      padding: '2px 8px', borderRadius: 3, border: 'none',
                      background: '#228be6', color: '#fff', cursor: 'pointer', fontSize: 11,
                    }}>Restore</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {previewingVersion && (
            <div style={{
              padding: '10px 16px', borderTop: '1px solid #dee2e6',
              background: '#fff9db', display: 'flex', justifyContent: 'space-between',
              alignItems: 'center',
            }}>
              <span style={{ fontSize: 12, color: '#856404' }}>Previewing version</span>
              <button onClick={cancelPreview} style={{
                padding: '3px 10px', borderRadius: 3, border: '1px solid #856404',
                background: 'transparent', color: '#856404', cursor: 'pointer', fontSize: 11,
              }}>Cancel preview</button>
            </div>
          )}
        </div>
      )}

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
