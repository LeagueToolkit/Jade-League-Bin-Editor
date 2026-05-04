import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
    LibraryIcon, PaletteIcon, SettingsIcon, ChevronRightIcon, SearchIcon,
    MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon,
} from './Icons';
import { FormatIcon, extractExtension } from './FormatIcons';
import { texBufferToDataURL, ddsBufferToDataURL, ddsFormatName, formatName as texFormatName } from '../lib/texFormat';
import ExtractionSettingsDialog from './ExtractionSettingsDialog';
import './WelcomeScreen.css';

interface WelcomeScreenProps {
    onOpenFile: () => void;
    openFileDisabled?: boolean;
    recentFiles?: string[];
    onOpenRecentFile?: (path: string) => void;
    onMaterialLibrary?: () => void;
    onThemes?: () => void;
    onSettings?: () => void;
    appIcon?: string;
    /** Custom window-chrome handlers — when supplied, the welcome screen
     *  draws its own title bar with min/max/close controls. Falls back
     *  gracefully when missing (no title bar shown). */
    onMinimize?: () => void;
    onMaximize?: () => void;
    onClose?: () => void;
    isMaximized?: boolean;
}

interface DirEntry {
    name: string;
    path: string;
    is_dir: boolean;
    size: number;
    modified: number;
    extension: string;
}

interface WadOpenResult {
    id: number;
    name: string;
    path: string;
    version: string;
    chunk_count: number;
}

interface WadEntry {
    path: string;
    path_hash_hex: string;
    size: number;
    compressed_size: number;
    compression: string;
    is_duplicated: boolean;
    unknown: boolean;
}

interface WadHashStatus {
    present: boolean;
    layout: 'split' | 'combined' | 'missing' | string;
    hash_dir: string;
}

interface WadExtractProgressEvent {
    action_id: string;
    phase: 'preparing' | 'extracting' | 'complete' | 'cancelled' | 'error';
    current: number;
    total: number;
    written: number;
    errors: number;
    message: string;
}

interface WadHashDownloadProgressEvent {
    phase: 'checking' | 'downloading' | 'decompressing' | 'complete' | 'error';
    message: string;
    downloaded: number;
    total: number;
}

interface WadExtractResult {
    action_id: string;
    written: number;
    skipped: number;
    errors: number;
    elapsed_ms: number;
    output_dir: string;
    cancelled: boolean;
}

type WelcomeView = 'home' | 'extract';

function isWadFileName(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.wad') || lower.endsWith('.wad.client') || lower.endsWith('.wad.mobile');
}

function timeOfDayGreeting(): string {
    const h = new Date().getHours();
    if (h < 5) return 'Good night';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 22) return 'Good evening';
    return 'Good night';
}

function formatRelative(timestamp: number): string {
    if (!timestamp) return '';
    const now = Date.now() / 1000;
    const diff = now - timestamp;
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
    const date = new Date(timestamp * 1000);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(bytes: number): string {
    if (!bytes) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let n = bytes;
    while (n >= 1024 && i < units.length - 1) {
        n /= 1024;
        i++;
    }
    return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Welcome / start screen — MS Word-inspired layout. A left rail of nav
 * tabs (Home / Open BIN / Extract Files / Themes / Settings), a main
 * content area whose contents change per tab. Open BIN is a sidebar
 * action button rather than a real tab — it just calls `onOpenFile`
 * straight away, dismissing the welcome screen via the parent shell's
 * usual "no tabs → welcome / has tabs → editor" toggle.
 *
 * The screen positions itself as a full-viewport overlay above every
 * shell chrome element (title bar text, tabs, status bar, ribbon, dock
 * panes). Only the OS window controls (min / max / close) stay clickable
 * thanks to the body.welcome-active class boosting their z-index.
 */
export default function WelcomeScreen({
    onOpenFile,
    openFileDisabled = false,
    recentFiles = [],
    onOpenRecentFile,
    onMaterialLibrary,
    onThemes,
    onSettings,
    appIcon,
    onMinimize,
    onMaximize,
    onClose,
    isMaximized = false,
}: WelcomeScreenProps) {
    const [view, setView] = useState<WelcomeView>('home');
    const [search, setSearch] = useState('');

    const greeting = useMemo(timeOfDayGreeting, []);

    // Extraction progress is owned by the welcome screen root so the
    // status bar can sit at the bottom of the layout (in its own grid
    // slot). The bar itself is only rendered when the user is on the
    // Extract view.
    const [progress, setProgress] = useState(0);
    // Single status string displayed *on top* of the progress bar — the
    // sources column used to host this and got pushed around when the
    // text appeared. Cleared together with the progress fade so both
    // disappear in one go.
    const [extractStatusText, setExtractStatusText] = useState<string | null>(null);
    const progressResetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    // While a multi-WAD batch is running, the per-WAD progress events
    // are noisy (each WAD blasts 0→100, plus its own status messages).
    // The batch loop in ExtractView drives the bar/status/taskbar
    // directly, so this listener short-circuits while the ref is set.
    const multiWadActiveRef = useRef(false);

    // Real extraction progress comes from the backend `wad-extract-progress`
    // event. We translate `current/total` into a percentage and clear the
    // bar a beat after completion so the user sees it land at 100%. The
    // same events also drive the Windows taskbar's per-window progress
    // overlay (the green fill behind the app icon).
    useEffect(() => {
        const setTaskbar = (
            state: 'no_progress' | 'indeterminate' | 'normal' | 'paused' | 'error',
            completed: number,
            total: number,
        ) => {
            invoke('set_taskbar_progress', { state, completed, total }).catch(() => {});
        };
        const unlisten = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (multiWadActiveRef.current) return;
            const { phase, current, total } = e.payload;
            if (progressResetTimer.current) {
                clearTimeout(progressResetTimer.current);
                progressResetTimer.current = null;
            }
            if (phase === 'preparing') {
                setProgress(0);
                setTaskbar('indeterminate', 0, 0);
                return;
            }
            if (phase === 'extracting') {
                setProgress(total > 0 ? Math.min(100, (current / total) * 100) : 0);
                setTaskbar('normal', current, Math.max(total, 1));
                return;
            }
            // complete / cancelled / error → land at 100% (or hold),
            // then fade the bar AND the status text away together.
            if (phase === 'complete') {
                setProgress(100);
                setTaskbar('normal', total || 1, total || 1);
            } else if (phase === 'error') {
                setTaskbar('error', current, Math.max(total, 1));
            } else {
                setTaskbar('no_progress', 0, 0);
            }
            progressResetTimer.current = setTimeout(() => {
                setProgress(0);
                setExtractStatusText(null);
                setTaskbar('no_progress', 0, 0);
            }, 2000);
        });
        return () => {
            unlisten.then((u) => u()).catch(() => {});
            if (progressResetTimer.current) clearTimeout(progressResetTimer.current);
        };
    }, []);

    // Tag the body while the welcome overlay is mounted — used by CSS
    // to hide the shell's own title-bar contents (the welcome screen
    // brings its own bar) and quiet any chrome behind us.
    useEffect(() => {
        document.body.classList.add('welcome-active');
        return () => document.body.classList.remove('welcome-active');
    }, []);

    return (
        <div className="welcome-screen-v2">
            {(onMinimize || onMaximize || onClose) && (
                <div className="welcome-titlebar" data-tauri-drag-region>
                    <div className="welcome-titlebar-brand">
                        <img
                            src={appIcon || '/media/jadejade.png'}
                            alt="Jade"
                            className="welcome-titlebar-icon"
                        />
                        <span className="welcome-titlebar-name">Jade</span>
                    </div>
                    <div className="welcome-titlebar-spacer" data-tauri-drag-region />
                    <div className="welcome-titlebar-controls">
                        {onMinimize && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-min"
                                onClick={onMinimize}
                                title="Minimize"
                            >
                                <MinimizeIcon size={14} />
                            </button>
                        )}
                        {onMaximize && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-max"
                                onClick={onMaximize}
                                title={isMaximized ? 'Restore' : 'Maximize'}
                            >
                                {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                            </button>
                        )}
                        {onClose && (
                            <button
                                type="button"
                                className="welcome-titlebar-btn welcome-titlebar-btn-close"
                                onClick={onClose}
                                title="Close"
                            >
                                <CloseIcon size={14} strokeWidth={2.2} />
                            </button>
                        )}
                    </div>
                </div>
            )}
            <aside className="welcome-rail">
                <button
                    type="button"
                    className={`welcome-rail-item${view === 'home' ? ' active' : ''}`}
                    onClick={() => setView('home')}
                >
                    <HomeIcon size={20} />
                    <span>Home</span>
                </button>

                <button
                    type="button"
                    className="welcome-rail-item welcome-rail-item-action"
                    onClick={onOpenFile}
                    disabled={openFileDisabled}
                    title="Open a .bin file (Ctrl+O)"
                >
                    <DocIcon size={20} />
                    <span>Open BIN</span>
                </button>

                <button
                    type="button"
                    className={`welcome-rail-item${view === 'extract' ? ' active' : ''}`}
                    onClick={() => setView('extract')}
                >
                    <FolderIcon size={20} />
                    <span>Extract Files</span>
                </button>

                <div className="welcome-rail-spacer" />

                {onSettings && (
                    <button type="button" className="welcome-rail-item" onClick={onSettings}>
                        <SettingsIcon size={20} />
                        <span>Settings</span>
                    </button>
                )}
            </aside>

            <main className="welcome-main">
                {view === 'home' && (
                    <HomeView
                        greeting={greeting}
                        search={search}
                        onSearch={setSearch}
                        recentFiles={recentFiles}
                        onOpenFile={onOpenFile}
                        onOpenRecentFile={onOpenRecentFile}
                        onMaterialLibrary={onMaterialLibrary}
                        onThemes={onThemes}
                        onSettings={onSettings}
                        openFileDisabled={openFileDisabled}
                    />
                )}
                {view === 'extract' && (
                    <ExtractView
                        onExtractStatus={setExtractStatusText}
                        onProgress={setProgress}
                        multiWadActiveRef={multiWadActiveRef}
                    />
                )}
            </main>

            {/* Status bar — only present on the Extract view. Sits in
                its own grid slot below `main`, leaving the rail (which
                spans the full height) untouched on the left. The fill
                animates left-to-right across the entire bar. The
                status text overlays the bar (centered) so progress
                updates don't jiggle the buttons in the sources column. */}
            {view === 'extract' && (
                <div className="welcome-status">
                    <div
                        className="welcome-status-fill"
                        style={{ width: `${progress}%` }}
                    />
                    {extractStatusText && (
                        <div className="welcome-status-text">{extractStatusText}</div>
                    )}
                </div>
            )}
        </div>
    );
}

/* ────────────────── Home view ────────────────── */
function HomeView({
    greeting,
    search,
    onSearch,
    recentFiles,
    onOpenFile,
    onOpenRecentFile,
    onMaterialLibrary,
    onThemes,
    onSettings,
    openFileDisabled,
}: {
    greeting: string;
    search: string;
    onSearch: (s: string) => void;
    recentFiles: string[];
    onOpenFile: () => void;
    onOpenRecentFile?: (path: string) => void;
    onMaterialLibrary?: () => void;
    onThemes?: () => void;
    onSettings?: () => void;
    openFileDisabled?: boolean;
}) {
    const filteredRecent = useMemo(() => {
        if (!search.trim()) return recentFiles.slice(0, 12);
        const q = search.toLowerCase();
        return recentFiles.filter(p => p.toLowerCase().includes(q)).slice(0, 12);
    }, [recentFiles, search]);

    // Fetch the on-disk mtime for each visible recent file so the
    // "Last edited" column reflects the actual file system timestamp,
    // not the time we added it to the recent-files list. Files that
    // were moved or deleted resolve to undefined and render as a dash.
    const [mtimes, setMtimes] = useState<Record<string, number>>({});
    useEffect(() => {
        if (filteredRecent.length === 0) return;
        let cancelled = false;
        (async () => {
            const next: Record<string, number> = {};
            await Promise.all(filteredRecent.map(async (path) => {
                try {
                    const millis = await invoke<number>('get_file_mtime', { path });
                    next[path] = Math.floor(millis / 1000);
                } catch { /* missing/inaccessible file — skip */ }
            }));
            if (!cancelled) setMtimes(prev => ({ ...prev, ...next }));
        })();
        return () => { cancelled = true; };
    }, [filteredRecent]);

    return (
        <div className="welcome-home">
            <h1 className="welcome-greeting">{greeting}</h1>

            <section className="welcome-section">
                <div className="welcome-section-head">
                    <h2 className="welcome-section-title">Quick actions</h2>
                </div>
                <div className="welcome-tiles">
                    <ActionTile
                        label="Open BIN"
                        sub="Open a .bin file"
                        icon={<DocIcon size={28} />}
                        onClick={onOpenFile}
                        disabled={openFileDisabled}
                    />
                    {onMaterialLibrary && (
                        <ActionTile
                            label="Material Library"
                            sub="Browse downloaded materials"
                            icon={<LibraryIcon size={28} />}
                            onClick={onMaterialLibrary}
                        />
                    )}
                    {onThemes && (
                        <ActionTile
                            label="Themes"
                            sub="Change look + accent"
                            icon={<PaletteIcon size={28} />}
                            onClick={onThemes}
                        />
                    )}
                    {onSettings && (
                        <ActionTile
                            label="Settings"
                            sub="Preferences and tools"
                            icon={<SettingsIcon size={28} />}
                            onClick={onSettings}
                        />
                    )}
                </div>
            </section>

            <section className="welcome-section">
                <div className="welcome-search-wrap">
                    <input
                        type="text"
                        className="welcome-search"
                        placeholder="Search recent files…"
                        value={search}
                        onChange={e => onSearch(e.target.value)}
                    />
                </div>

                <div className="welcome-section-head welcome-section-head-tabs">
                    <span className="welcome-tab active">Recent</span>
                </div>

                <div className="welcome-recent-table">
                    <div className="welcome-recent-row welcome-recent-row-header">
                        <span className="col-icon" />
                        <span className="col-name">Name</span>
                        <span className="col-modified">Last edited</span>
                    </div>
                    {filteredRecent.length === 0 && (
                        <div className="welcome-recent-empty">
                            {search.trim() ? 'No matches.' : 'No recent files yet — open a BIN to get started.'}
                        </div>
                    )}
                    {filteredRecent.map((filePath, i) => {
                        const parts = filePath.replace(/\\/g, '/').split('/');
                        const fileName = parts.pop() || filePath;
                        const dir = parts.join('/');
                        const ext = extractExtension(filePath);
                        return (
                            <button
                                key={i}
                                type="button"
                                className="welcome-recent-row"
                                onClick={() => onOpenRecentFile?.(filePath)}
                                title={filePath}
                            >
                                <span className="col-icon">
                                    <FormatIcon extension={ext} size={32} />
                                </span>
                                <span className="col-name">
                                    <span className="welcome-recent-name">{fileName}</span>
                                    <span className="welcome-recent-path">{dir}</span>
                                </span>
                                <span className="col-modified">
                                    {mtimes[filePath] ? formatRelative(mtimes[filePath]) : '—'}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>
        </div>
    );
}

function ActionTile({
    label,
    sub,
    icon,
    onClick,
    disabled,
}: {
    label: string;
    sub: string;
    icon: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
}) {
    return (
        <button type="button" className="welcome-tile" onClick={onClick} disabled={disabled}>
            <span className="welcome-tile-icon">{icon}</span>
            <span className="welcome-tile-label">{label}</span>
            <span className="welcome-tile-sub">{sub}</span>
        </button>
    );
}

/* ────────────────── Extract view ────────────────── */
function ExtractView({
    onExtractStatus,
    onProgress,
    multiWadActiveRef,
}: {
    onExtractStatus: (s: string | null) => void;
    onProgress: (pct: number) => void;
    multiWadActiveRef: React.MutableRefObject<boolean>;
}) {
    const [leagueInstall, setLeagueInstall] = useState<string | null>(null);
    const [leaguePbeInstall, setLeaguePbeInstall] = useState<string | null>(null);
    const [home, setHome] = useState<string | null>(null);
    /** Recently opened WAD paths — persisted via the preference store
     *  so they survive restarts. Most-recent first, capped at 8. */
    const [recentWads, setRecentWads] = useState<string[]>([]);
    /** True while a `.wad.client` is being dragged over the window —
     *  shows the drop overlay below. */
    const [dropActive, setDropActive] = useState(false);
    const [currentPath, setCurrentPath] = useState<string>('');
    const [entries, setEntries] = useState<DirEntry[]>([]);
    const [selected, setSelected] = useState<DirEntry | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [search, setSearch] = useState('');

    // ── WAD mount state ──
    const [mountInfo, setMountInfo] = useState<WadOpenResult | null>(null);
    const [wadEntries, setWadEntries] = useState<WadEntry[]>([]);
    const [wadCurrentDir, setWadCurrentDir] = useState<string>('');
    const [wadSelected, setWadSelected] = useState<WadEntry | null>(null);
    const [openingWad, setOpeningWad] = useState(false);
    const [extracting, setExtracting] = useState(false);
    /** Bridge to the welcome-screen-level status overlay. Passing the
     *  setter through a prop instead of duplicating state keeps the
     *  status text in one place — overlaid on the progress bar so it
     *  doesn't shove the action buttons around when it appears. */
    const setExtractMessage = onExtractStatus;
    const extractActionRef = useRef<string | null>(null);
    /** JS-side cancel flag for the multi-WAD loop. Backend cancels are
     *  per-action via `wad_cancel_extract`; this flag stops the *loop*
     *  itself from kicking off the next WAD after the current one is
     *  cancelled. */
    const cancelRef = useRef(false);

    // Multi-select set for the WAD list — Explorer-style checkboxes.
    // Stores file `path_hash_hex` values; folder rows toggle every file
    // under their prefix in/out of the set in one action.
    const [selectedHashes, setSelectedHashes] = useState<Set<string>>(new Set());

    // Disk-mode counterpart: full paths of `.wad.client` rows the user
    // ticked. Lets the same Extract Selected button kick off a batch
    // extraction of multiple WADs without ever opening any of them. Reset
    // when the current disk folder changes — selections from a previous
    // dir wouldn't be visible/cancellable from the new view.
    const [selectedDiskWads, setSelectedDiskWads] = useState<Set<string>>(new Set());
    useEffect(() => { setSelectedDiskWads(new Set()); }, [currentPath]);

    // ── Extraction settings (persisted preferences) ──
    // The "Extraction settings" button in the sources column opens a
    // modal mirroring the main Settings dialog's layout. State for each
    // toggle lives here so it survives the dialog mount/unmount cycle
    // and threads cleanly into the extraction commands.
    const [extractionSettingsOpen, setExtractionSettingsOpen] = useState(false);
    const [useRenamePattern, setUseRenamePattern] = useState(true);
    useEffect(() => {
        invoke<string>('get_preference', {
            key: 'WadUseRenamePattern',
            defaultValue: 'True',
        })
            .then(v => setUseRenamePattern(v === 'True'))
            .catch(() => { /* offline / no APPDATA — keep default */ });
    }, []);
    const toggleRenamePattern = (next: boolean) => {
        setUseRenamePattern(next);
        invoke('set_preference', {
            key: 'WadUseRenamePattern',
            value: next ? 'True' : 'False',
        }).catch(() => {});
    };

    // ── Preview state for WAD chunks (DDS / TEX / browser image). Disk-
    // side files only show metadata in the preview pane today. ──
    const [previewState, setPreviewState] = useState<{
        loading: boolean;
        dataUrl: string | null;
        error: string | null;
        format: string | null;
        width: number | null;
        height: number | null;
    }>({ loading: false, dataUrl: null, error: null, format: null, width: null, height: null });

    // ── Hash status / download ──
    const [hashStatus, setHashStatus] = useState<WadHashStatus | null>(null);
    const [hashDownloading, setHashDownloading] = useState(false);
    const [hashDownloadProgress, setHashDownloadProgress] = useState<WadHashDownloadProgressEvent | null>(null);

    // Probe hash status on first mount. The LMDB envs themselves open
    // lazily on the first lookup, so there's no eager warmup to schedule.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const status = await invoke<WadHashStatus>('wad_hash_status');
                if (cancelled) return;
                setHashStatus(status);
            } catch { /* offline / no APPDATA — leave status null */ }
        })();
        return () => { cancelled = true; };
    }, []);

    // Pipe hash-download progress into UI state. Runs once for the lifetime
    // of the view — multiple concurrent downloads aren't possible from the UI.
    useEffect(() => {
        const unlisten = listen<WadHashDownloadProgressEvent>('wad-hash-download-progress', (e) => {
            setHashDownloadProgress(e.payload);
            if (e.payload.phase === 'complete' || e.payload.phase === 'error') {
                setHashDownloading(false);
                // Re-check status so the banner disappears on success.
                invoke<WadHashStatus>('wad_hash_status').then(setHashStatus).catch(() => {});
            }
        });
        return () => { unlisten.then((u) => u()).catch(() => {}); };
    }, []);

    // Mirror extract-progress to local "extracting" state too so we can
    // show inline status text inside the WAD view (separate from the
    // global progress bar at the bottom). Suppressed during multi-WAD
    // batches — the loop drives status itself with a per-WAD aggregate
    // message rather than the noisy per-file event stream.
    useEffect(() => {
        const unlisten = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (multiWadActiveRef.current) return;
            const { phase, current, total, written, errors, action_id } = e.payload;
            if (extractActionRef.current && action_id !== extractActionRef.current) return;
            if (phase === 'preparing') {
                setExtractMessage('Preparing…');
            } else if (phase === 'extracting') {
                setExtractMessage(`Extracting ${current}/${total}…`);
            } else if (phase === 'complete') {
                setExtractMessage(`Extracted ${written} files${errors > 0 ? ` (${errors} errors)` : ''}`);
                setExtracting(false);
                extractActionRef.current = null;
            } else if (phase === 'cancelled') {
                setExtractMessage(`Cancelled at ${written} files`);
                setExtracting(false);
                extractActionRef.current = null;
            } else if (phase === 'error') {
                setExtractMessage('Extraction failed');
                setExtracting(false);
                extractActionRef.current = null;
            }
        });
        return () => { unlisten.then((u) => u()).catch(() => {}); };
    }, [multiWadActiveRef, setExtractMessage]);

    const downloadHashes = async () => {
        setHashDownloading(true);
        setHashDownloadProgress({ phase: 'checking', message: 'Connecting…', downloaded: 0, total: 0 });
        try {
            await invoke<string>('wad_download_hashes', { force: false });
        } catch (e) {
            setHashDownloading(false);
            setHashDownloadProgress({
                phase: 'error',
                message: typeof e === 'string' ? e : 'Download failed',
                downloaded: 0, total: 0,
            });
        }
    };

    const closeWad = async () => {
        if (mountInfo) {
            try { await invoke('wad_close', { id: mountInfo.id }); } catch { /* ignore */ }
        }
        setMountInfo(null);
        setWadEntries([]);
        setWadCurrentDir('');
        setWadSelected(null);
        setSelectedHashes(new Set());
    };

    const openWad = async (path: string) => {
        setOpeningWad(true);
        setError(null);
        // Browsing into a WAD shouldn't keep the disk-side preview row
        // selected, otherwise the preview pane shows stale info.
        setSelected(null);
        try {
            const info = await invoke<WadOpenResult>('wad_open', { path });
            const items = await invoke<WadEntry[]>('wad_list_entries', { id: info.id });
            setMountInfo(info);
            setWadEntries(items);
            setWadCurrentDir('');
            setWadSelected(null);
            rememberRecentWad(path);
        } catch (e) {
            setError(typeof e === 'string' ? e : 'Failed to open WAD');
        } finally {
            setOpeningWad(false);
        }
    };

    // Switch to a disk source — close any active WAD first so we don't
    // leave a stale mount around when the user navigates elsewhere.
    const goToSource = async (path: string) => {
        if (mountInfo) await closeWad();
        setCurrentPath(path);
    };

    const startExtraction = async (overrideHashes?: string[]) => {
        if (!mountInfo) return;
        cancelRef.current = false;
        // Default: use the effective selection (checkboxes + click-pin).
        // Caller can pass an override — `[]` explicitly means "extract
        // everything" (Extract WAD button); a non-empty array means
        // "extract these specific hashes".
        const sel = overrideHashes !== undefined
            ? overrideHashes
            : effectiveSelection;
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked !== 'string') return;

        // Always nest the WAD's contents under a folder named after the
        // WAD itself, so picking `test/` for `aatrox.wad.client` produces
        // `test/aatrox/assets/...` instead of dumping `assets/` straight
        // into `test/`. Mirrors Quartz's default extract layout.
        const wadStem = mountInfo.name
            .replace(/\.wad\.client$/i, '')
            .replace(/\.wad\.mobile$/i, '')
            .replace(/\.wad$/i, '');
        const sep = picked.includes('\\') ? '\\' : '/';
        const targetDir = picked.endsWith(sep)
            ? `${picked}${wadStem}`
            : `${picked}${sep}${wadStem}`;

        const actionId = `extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        extractActionRef.current = actionId;
        setExtracting(true);
        setExtractMessage('Starting…');
        try {
            const result = await invoke<WadExtractResult>('wad_extract', {
                id: mountInfo.id,
                outputDir: targetDir,
                actionId,
                selectedHashes: sel.length > 0 ? sel : null,
                useRename: useRenamePattern,
            });
            // Final summary already covered by the progress event; keep
            // this for cases where the event might lag the result.
            if (!extracting) {
                setExtractMessage(
                    `Wrote ${result.written}${result.errors ? ` (${result.errors} errors)` : ''} in ${(result.elapsed_ms / 1000).toFixed(1)}s`
                );
            }
        } catch (e) {
            setExtracting(false);
            extractActionRef.current = null;
            setExtractMessage(typeof e === 'string' ? e : 'Extraction failed');
        }
    };

    /** Drag-and-drop wiring. While the Extract view is mounted, dropping
     *  a `.wad.client` file anywhere on the window opens it directly —
     *  saves the user from drilling through Open / locations to find a
     *  WAD that's already on their desktop. Multiple WADs at once are
     *  supported: the first one is opened for browsing, the rest land
     *  in the recent-WADs list for quick access.
     *
     *  Tauri 2 surfaces drag-drop via the `tauri://drag-drop` event with
     *  a tagged payload; we listen on the global event API so this works
     *  regardless of which webview window the file was dropped on. */
    useEffect(() => {
        let unlistenDrop: (() => void) | undefined;
        let unlistenHover: (() => void) | undefined;
        let unlistenCancel: (() => void) | undefined;

        listen<{ paths?: string[]; type?: string }>('tauri://drag-enter', () => {
            setDropActive(true);
        }).then(u => { unlistenHover = u; }).catch(() => {});

        listen<{ paths?: string[]; type?: string }>('tauri://drag-leave', () => {
            setDropActive(false);
        }).then(u => { unlistenCancel = u; }).catch(() => {});

        listen<{ paths?: string[]; type?: string }>('tauri://drag-drop', (e) => {
            setDropActive(false);
            const paths = Array.isArray(e.payload?.paths) ? e.payload!.paths! : [];
            const wads = paths.filter(p => isWadFileName(p.replace(/\\/g, '/').split('/').pop() || ''));
            if (wads.length === 0) return;
            // First WAD: open it. Anything extra: just remember as
            // recents so the user can pick from there.
            const [first, ...rest] = wads;
            void openWad(first);
            for (const r of rest) rememberRecentWad(r);
        }).then(u => { unlistenDrop = u; }).catch(() => {});

        return () => {
            unlistenDrop?.();
            unlistenHover?.();
            unlistenCancel?.();
        };
    // openWad is stable enough across renders for our purposes; we don't
    // want to tear-down/re-register the global listener every time the
    // user clicks a file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const cancelExtraction = async () => {
        // Stop the multi-WAD loop from picking the next WAD.
        cancelRef.current = true;
        // And cancel whatever WAD is currently being processed (single
        // or multi — both cases fall through here).
        if (extractActionRef.current) {
            try {
                await invoke('wad_cancel_extract', { actionId: extractActionRef.current });
            } catch { /* ignore */ }
        }
    };

    /** Sequentially extract a list of disk-side `.wad.client` files,
     *  each into its own `<output>/<wadStem>/` folder.
     *
     *  Drives the global progress bar by aggregated **file count** so
     *  the bar fills smoothly across the whole batch — but the status
     *  text only mentions WAD count so the user sees a clean "X of Y
     *  WADs" instead of the noisy per-file numbers. */
    const startDiskWadsExtraction = async (wadPaths: string[]) => {
        if (wadPaths.length === 0) return;
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked !== 'string') return;

        cancelRef.current = false;
        multiWadActiveRef.current = true;
        setExtracting(true);
        onProgress(0);
        onExtractStatus(`Reading ${wadPaths.length} WAD header${wadPaths.length === 1 ? '' : 's'}…`);
        invoke('set_taskbar_progress', { state: 'indeterminate', completed: 0, total: 0 })
            .catch(() => {});

        // Step 1 — pre-mount every WAD up front so we know the total
        // file count before extraction starts. WAD `mount` is cheap
        // (TOC parse + bulk hash resolve, ~10-50 ms each), and having
        // an accurate `totalFiles` lets the bar fill smoothly across
        // the whole batch instead of resetting per WAD.
        type MountedRef = { path: string; info: WadOpenResult };
        const mounts: MountedRef[] = [];
        let totalFiles = 0;
        try {
            for (const path of wadPaths) {
                if (cancelRef.current) break;
                const info = await invoke<WadOpenResult>('wad_open', { path });
                mounts.push({ path, info });
                totalFiles += info.chunk_count;
            }
        } catch (e) {
            for (const m of mounts) {
                try { await invoke('wad_close', { id: m.info.id }); } catch { /* ignore */ }
            }
            multiWadActiveRef.current = false;
            setExtracting(false);
            extractActionRef.current = null;
            onExtractStatus(`Failed to read WADs: ${typeof e === 'string' ? e : (e instanceof Error ? e.message : 'unknown')}`);
            invoke('set_taskbar_progress', { state: 'error', completed: 0, total: 1 })
                .catch(() => {});
            setTimeout(() => {
                onProgress(0);
                onExtractStatus(null);
                invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                    .catch(() => {});
            }, 2500);
            return;
        }

        if (cancelRef.current || mounts.length === 0) {
            for (const m of mounts) {
                try { await invoke('wad_close', { id: m.info.id }); } catch { /* ignore */ }
            }
            multiWadActiveRef.current = false;
            setExtracting(false);
            extractActionRef.current = null;
            onExtractStatus(null);
            onProgress(0);
            invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                .catch(() => {});
            return;
        }

        const sep = picked.includes('\\') ? '\\' : '/';
        const totalWads = mounts.length;

        // Step 2 — listen to the live extracting events so the bar
        // updates *per file* but reflects the cumulative count across
        // every WAD already done.
        let baseFiles = 0;
        let activeAction: string | null = null;
        const unlistenPromise = listen<WadExtractProgressEvent>('wad-extract-progress', (e) => {
            if (e.payload.action_id !== activeAction) return;
            if (e.payload.phase !== 'extracting') return;
            const aggregated = baseFiles + e.payload.current;
            const denom = Math.max(totalFiles, 1);
            onProgress(Math.min(100, (aggregated / denom) * 100));
            invoke('set_taskbar_progress', {
                state: 'normal',
                completed: aggregated,
                total: denom,
            }).catch(() => {});
        });
        const unlisten = await unlistenPromise;

        let totalWritten = 0;
        let totalErrors = 0;
        let i = 0;
        try {
            for (; i < totalWads; i++) {
                if (cancelRef.current) break;
                const { path, info } = mounts[i];
                const baseName = path.replace(/\\/g, '/').split('/').pop() || path;
                const wadStem = baseName
                    .replace(/\.wad\.client$/i, '')
                    .replace(/\.wad\.mobile$/i, '')
                    .replace(/\.wad$/i, '');
                const targetDir = picked.endsWith(sep)
                    ? `${picked}${wadStem}`
                    : `${picked}${sep}${wadStem}`;

                onExtractStatus(`Processing ${i + 1} of ${totalWads} WAD${totalWads === 1 ? '' : 's'}`);

                const actionId = `disk-extract-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                activeAction = actionId;
                extractActionRef.current = actionId;
                try {
                    const result = await invoke<WadExtractResult>('wad_extract', {
                        id: info.id,
                        outputDir: targetDir,
                        actionId,
                        selectedHashes: null,
                        useRename: useRenamePattern,
                    });
                    totalWritten += result.written;
                    totalErrors += result.errors;
                    if (result.cancelled) cancelRef.current = true;
                } catch (e) {
                    console.error(`[disk-extract] ${baseName} failed:`, e);
                    totalErrors += 1;
                }
                baseFiles += info.chunk_count;
                try { await invoke('wad_close', { id: info.id }); } catch { /* ignore */ }
            }
        } finally {
            unlisten();
        }

        // Close any mounts we never got to (cancelled mid-loop).
        for (let j = i; j < mounts.length; j++) {
            try { await invoke('wad_close', { id: mounts[j].info.id }); } catch { /* ignore */ }
        }

        const cancelled = cancelRef.current;
        const processedWads = i;
        multiWadActiveRef.current = false;
        setExtracting(false);
        extractActionRef.current = null;

        if (cancelled) {
            onProgress(100);
            onExtractStatus(`Cancelled — ${processedWads} of ${totalWads} WAD${totalWads === 1 ? '' : 's'} · ${totalWritten} files`);
            invoke('set_taskbar_progress', { state: 'error', completed: processedWads, total: totalWads })
                .catch(() => {});
        } else {
            onProgress(100);
            onExtractStatus(`Done — ${totalWads} WAD${totalWads === 1 ? '' : 's'} · ${totalWritten} files${totalErrors ? ` · ${totalErrors} errors` : ''}`);
            invoke('set_taskbar_progress', { state: 'normal', completed: totalFiles, total: Math.max(totalFiles, 1) })
                .catch(() => {});
        }

        setTimeout(() => {
            onProgress(0);
            onExtractStatus(null);
            invoke('set_taskbar_progress', { state: 'no_progress', completed: 0, total: 0 })
                .catch(() => {});
        }, 2000);
    };

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const [league, pbe, h, recents] = await Promise.all([
                    invoke<string | null>('detect_league_install'),
                    invoke<string | null>('detect_league_pbe_install'),
                    invoke<string | null>('get_home_directory'),
                    invoke<string>('get_preference', { key: 'RecentWads', defaultValue: '[]' }).catch(() => '[]'),
                ]);
                if (cancelled) return;
                setLeagueInstall(league);
                setLeaguePbeInstall(pbe);
                setHome(h);
                try {
                    const list = JSON.parse(recents);
                    if (Array.isArray(list)) setRecentWads(list.filter((p): p is string => typeof p === 'string'));
                } catch { /* corrupt JSON — leave empty */ }
                // Default browse path: Live install → PBE install → home.
                const initial = league || pbe || h || '';
                if (initial) setCurrentPath(initial);
            } catch { /* nothing — leave user to manually pick */ }
        })();
        return () => { cancelled = true; };
    }, []);

    /** Push a WAD path onto the recents list, dedup and cap at 8. */
    const rememberRecentWad = (path: string) => {
        setRecentWads(prev => {
            const filtered = prev.filter(p => p !== path);
            const next = [path, ...filtered].slice(0, 8);
            invoke('set_preference', { key: 'RecentWads', value: JSON.stringify(next) }).catch(() => {});
            return next;
        });
    };

    // Reset the search box whenever the current location changes — picking
    // a new directory (or stepping inside a WAD) should start fresh, not
    // keep filtering by a query that was meant for the previous level.
    useEffect(() => { setSearch(''); }, [currentPath, mountInfo?.id, wadCurrentDir]);

    // Disk listing — only refetch on disk side. When mounted into a WAD
    // we render `wadEntries` instead of hitting the filesystem again.
    useEffect(() => {
        if (!currentPath || mountInfo) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        invoke<DirEntry[]>('list_directory', { path: currentPath })
            .then(es => {
                if (cancelled) return;
                setEntries(es);
                setSelected(null);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(typeof e === 'string' ? e : 'Failed to read directory');
                setEntries([]);
            })
            .finally(() => { if (!cancelled) setLoading(false); });
        return () => { cancelled = true; };
    }, [currentPath, mountInfo]);

    // Up button: in a WAD subdir → walk to parent subdir; at WAD root →
    // unmount and stay at the disk dir that contained the WAD; on disk →
    // go to the parent directory as before.
    const goUp = async () => {
        if (mountInfo) {
            if (wadCurrentDir) {
                const idx = wadCurrentDir.lastIndexOf('/');
                setWadCurrentDir(idx === -1 ? '' : wadCurrentDir.slice(0, idx));
            } else {
                await closeWad();
            }
            return;
        }
        if (!currentPath) return;
        const parent = await invoke<string>('parent_directory', { path: currentPath });
        if (parent && parent !== currentPath) setCurrentPath(parent);
    };

    const browseFolder = async () => {
        // Lazily pull plugin-dialog so the welcome screen doesn't drag it
        // in unless the user actually clicks Browse.
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({ directory: true, multiple: false });
        if (typeof picked === 'string') {
            if (mountInfo) await closeWad();
            setCurrentPath(picked);
        }
    };

    // Unified row model — one list whether we're browsing the disk or
    // the inside of a mounted WAD. The row's `kind` discriminates click
    // behaviour and which icon / metadata columns we show.
    type BrowseRow =
        | { kind: 'disk-folder'; entry: DirEntry }
        | { kind: 'disk-file'; entry: DirEntry }
        | { kind: 'wad-folder'; name: string; size: number; count: number; subPath: string }
        | { kind: 'wad-file'; entry: WadEntry };

    // Pre-build a path tree once on mount. Without this, every folder
    // navigation re-iterated the full `wadEntries` array (O(N)) just to
    // group entries by their direct-child folder name — felt fine on
    // 5k-entry WADs but turned into a multi-second freeze when stepping
    // into a 30k+ entry WAD's root.
    //
    // With the tree we walk straight to the target node and read its
    // already-grouped `children` map and `files` array. O(folder
    // children) per navigation regardless of total WAD size.
    type WadTreeNode = {
        name: string;
        fullPath: string;
        children: Map<string, WadTreeNode>;
        files: WadEntry[];
        descendantFileCount: number;
        descendantTotalSize: number;
        /** Every chunk hash under this folder — bubbled up at tree-build
         *  time so checkbox state queries don't re-scan `wadEntries` on
         *  every render. Populated for folder nodes only; leaf files
         *  are tracked through their parent's `files` array. */
        descendantHashes: string[];
    };
    const wadTree: WadTreeNode | null = useMemo(() => {
        if (!mountInfo) return null;
        const newNode = (name: string, fullPath: string): WadTreeNode => ({
            name, fullPath,
            children: new Map(), files: [],
            descendantFileCount: 0, descendantTotalSize: 0,
            descendantHashes: [],
        });
        const root = newNode('', '');
        for (const entry of wadEntries) {
            const parts = entry.path.split('/');
            if (parts.length === 0) continue;
            // Strip the file name — what's left is the directory chain.
            parts.pop();
            let node = root;
            let acc = '';
            for (const part of parts) {
                if (!part) continue;
                acc = acc ? `${acc}/${part}` : part;
                let child = node.children.get(part);
                if (!child) {
                    child = newNode(part, acc);
                    node.children.set(part, child);
                }
                child.descendantFileCount += 1;
                child.descendantTotalSize += entry.size;
                child.descendantHashes.push(entry.path_hash_hex);
                node = child;
            }
            node.files.push(entry);
        }
        return root;
    }, [mountInfo, wadEntries]);

    // Walk the tree to a sub-path. O(depth) — used by the folder
    // checkbox state lookups so they don't re-scan `wadEntries`.
    const getWadNode = (subPath: string): WadTreeNode | null => {
        if (!wadTree) return null;
        if (!subPath) return wadTree;
        let node: WadTreeNode = wadTree;
        for (const part of subPath.split('/')) {
            if (!part) continue;
            const child = node.children.get(part);
            if (!child) return null;
            node = child;
        }
        return node;
    };

    // Searching builds a flat list — pre-lowercase every path once so
    // each keystroke doesn't pay `path.toLowerCase()` × N. Cheap memo,
    // ~10 ms for 20k entries.
    const wadSearchIndex = useMemo<{ entry: WadEntry; lower: string }[] | null>(() => {
        if (!mountInfo) return null;
        return wadEntries.map(entry => ({ entry, lower: entry.path.toLowerCase() }));
    }, [mountInfo, wadEntries]);

    const visibleRows: BrowseRow[] = useMemo(() => {
        const q = search.trim().toLowerCase();
        if (mountInfo && wadTree) {
            // WAD mode — search bypasses the tree and returns the first
            // 1000 substring matches across the whole WAD; otherwise we
            // walk the tree to the current sub-path and project its
            // children into rows.
            if (q && wadSearchIndex) {
                const out: BrowseRow[] = [];
                for (const { entry, lower } of wadSearchIndex) {
                    if (lower.includes(q)) {
                        out.push({ kind: 'wad-file', entry });
                        if (out.length >= 1000) break;
                    }
                }
                return out;
            }
            let node = wadTree;
            if (wadCurrentDir) {
                for (const part of wadCurrentDir.split('/')) {
                    if (!part) continue;
                    const child = node.children.get(part);
                    if (!child) return [];
                    node = child;
                }
            }
            const dirRows: BrowseRow[] = [];
            for (const child of node.children.values()) {
                dirRows.push({
                    kind: 'wad-folder',
                    name: child.name,
                    size: child.descendantTotalSize,
                    count: child.descendantFileCount,
                    subPath: child.fullPath,
                });
            }
            dirRows.sort((a, b) => {
                const an = (a as Extract<BrowseRow, { kind: 'wad-folder' }>).name;
                const bn = (b as Extract<BrowseRow, { kind: 'wad-folder' }>).name;
                return an.localeCompare(bn);
            });
            const fileRows: BrowseRow[] = node.files
                .slice()
                .sort((a, b) => a.path.localeCompare(b.path))
                .map(entry => ({ kind: 'wad-file' as const, entry }));
            return dirRows.concat(fileRows);
        }
        // Disk mode — substring filter on file names.
        const list = q ? entries.filter(e => e.name.toLowerCase().includes(q)) : entries;
        return list.map(entry => ({
            kind: entry.is_dir ? 'disk-folder' as const : 'disk-file' as const,
            entry,
        }));
    }, [mountInfo, wadTree, wadSearchIndex, wadCurrentDir, entries, search]);

    // Breadcrumb walks disk → WAD file → in-WAD path. Each segment is
    // clickable; clicking a disk segment while inside a WAD unmounts it
    // first so we don't end up with a stale mount.
    type Crumb = { label: string; onClick: () => void };
    const breadcrumb: Crumb[] = useMemo(() => {
        const out: Crumb[] = [];
        if (currentPath) {
            const norm = currentPath.replace(/\\/g, '/');
            const parts = norm.split('/').filter(Boolean);
            let acc = norm.startsWith('/') ? '/' : '';
            for (const p of parts) {
                if (acc && !acc.endsWith('/') && !acc.endsWith('\\')) acc += '/';
                acc += p;
                const seg = acc.replace(/\//g, '\\');
                out.push({
                    label: p,
                    onClick: () => {
                        if (mountInfo) {
                            void closeWad().then(() => setCurrentPath(seg));
                        } else {
                            setCurrentPath(seg);
                        }
                    },
                });
            }
        }
        if (mountInfo) {
            // WAD itself sits as a "folder" segment between disk and in-WAD
            // path. Clicking it returns to the WAD's root.
            out.push({ label: mountInfo.name, onClick: () => setWadCurrentDir('') });
            const subParts = wadCurrentDir.split('/').filter(Boolean);
            let acc = '';
            for (const p of subParts) {
                acc = acc ? `${acc}/${p}` : p;
                const path = acc;
                out.push({ label: p, onClick: () => setWadCurrentDir(path) });
            }
        }
        return out;
    }, [currentPath, mountInfo, wadCurrentDir]);

    // Preview pipeline — runs for whichever side is currently selected
    // (WAD chunk or disk file). Both paths flow through the same TEX /
    // DDS / browser-image decoder; only the byte source differs:
    //   • WAD chunk → `wad_read_chunk_b64`
    //   • Disk file → `read_file_base64`
    // Disk-mode .dds and .tex previews exist so already-extracted assets
    // stay viewable from the file list.
    useEffect(() => {
        const reset = () => setPreviewState({
            loading: false, dataUrl: null, error: null, format: null, width: null, height: null,
        });

        type Source = { path: string; fetchB64: () => Promise<string> };
        let source: Source | null = null;
        if (wadSelected && mountInfo) {
            const id = mountInfo.id;
            const hex = wadSelected.path_hash_hex;
            source = {
                path: wadSelected.path,
                fetchB64: () => invoke<string>('wad_read_chunk_b64', { id, pathHashHex: hex }),
            };
        } else if (selected && !selected.is_dir) {
            const path = selected.path;
            source = {
                path,
                fetchB64: () => invoke<string>('read_file_base64', { path }),
            };
        }
        if (!source) { reset(); return; }

        const lower = source.path.toLowerCase();
        const dot = lower.lastIndexOf('.');
        const ext = dot === -1 ? '' : lower.slice(dot);
        const isDDS = ext === '.dds';
        const isTEX = ext === '.tex';
        const isBrowserImg = ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.bmp';
        if (!isDDS && !isTEX && !isBrowserImg) { reset(); return; }

        let cancelled = false;
        setPreviewState({ loading: true, dataUrl: null, error: null, format: null, width: null, height: null });
        (async () => {
            try {
                const b64 = await source!.fetchB64();
                if (cancelled) return;
                const bin = atob(b64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

                if (isDDS) {
                    const { dataURL, width, height, ddsFormat } = ddsBufferToDataURL(bytes.buffer, 512);
                    if (!cancelled) setPreviewState({
                        loading: false, dataUrl: dataURL, error: null,
                        format: ddsFormatName(ddsFormat), width, height,
                    });
                } else if (isTEX) {
                    const { dataURL, width, height, format } = texBufferToDataURL(bytes.buffer, 512);
                    if (!cancelled) setPreviewState({
                        loading: false, dataUrl: dataURL, error: null,
                        format: texFormatName(format), width, height,
                    });
                } else {
                    const mime = ext === '.png' ? 'image/png' : ext === '.bmp' ? 'image/bmp' : 'image/jpeg';
                    const dataURL = `data:${mime};base64,${b64}`;
                    const img = new Image();
                    await new Promise<void>((res, rej) => {
                        img.onload = () => res();
                        img.onerror = () => rej(new Error('Image decode failed'));
                        img.src = dataURL;
                    });
                    if (!cancelled) setPreviewState({
                        loading: false, dataUrl: dataURL, error: null,
                        format: ext.slice(1).toUpperCase(), width: img.width, height: img.height,
                    });
                }
            } catch (e) {
                if (!cancelled) setPreviewState({
                    loading: false, dataUrl: null,
                    error: typeof e === 'string' ? e : (e instanceof Error ? e.message : 'Preview failed'),
                    format: null, width: null, height: null,
                });
            }
        })();
        return () => { cancelled = true; };
    }, [wadSelected, selected, mountInfo]);

    const previewItem: { name: string; ext: string; size: number; type: string; path: string } | null = useMemo(() => {
        if (wadSelected) {
            const dot = wadSelected.path.lastIndexOf('.');
            const ext = dot === -1 ? '' : wadSelected.path.slice(dot);
            const name = wadSelected.path.includes('/')
                ? wadSelected.path.slice(wadSelected.path.lastIndexOf('/') + 1)
                : wadSelected.path;
            return {
                name,
                ext,
                size: wadSelected.size,
                type: wadSelected.unknown ? 'Unknown' : (ext || 'File'),
                path: wadSelected.path,
            };
        }
        if (selected) {
            return {
                name: selected.name,
                ext: selected.extension ? `.${selected.extension}` : '',
                size: selected.size,
                type: selected.is_dir
                    ? 'Folder'
                    : (selected.extension ? `.${selected.extension}` : 'File'),
                path: selected.path,
            };
        }
        return null;
    }, [wadSelected, selected]);

    // Pin the breadcrumb's horizontal scroll to its right edge whenever
    // the path changes, so an overflowing path always shows the latest
    // segments — matching Windows Explorer's address bar truncation.
    const breadcrumbRef = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
        const el = breadcrumbRef.current;
        if (!el) return;
        el.scrollLeft = el.scrollWidth;
    }, [breadcrumb]);

    // ── Virtualised list rendering ──
    // Row height is fixed at 52px (CSS) so we can compute a window of
    // rows directly from `scrollTop` instead of measuring each row.
    // Critical for WADs with 5–20k+ chunks where rendering every row
    // froze the UI for seconds.
    //
    // Layout: a single content div with `height = N*52` holds every row
    // absolutely-positioned at `top = i*52`. Switching from a
    // top/bottom-spacer-div approach to absolute positioning means the
    // content div's own height never changes during scroll — only the
    // small set of rendered rows have their inline `top` style mutated,
    // which React applies as a tiny DOM diff. The previous spacer
    // approach forced the parent flex container to relayout on every
    // scroll tick, which was visible as blank rows on big WADs.
    const ROW_HEIGHT = 52;
    const ROW_OVERSCAN = 24;
    const listRef = useRef<HTMLDivElement>(null);
    const [listScrollTop, setListScrollTop] = useState(0);
    const [listViewH, setListViewH] = useState(600);
    const scrollRafRef = useRef<number | null>(null);
    useEffect(() => {
        const el = listRef.current;
        if (!el) return;
        const update = () => setListViewH(el.clientHeight);
        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => {
            ro.disconnect();
            if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
        };
    }, []);
    // Reset scroll when the row set changes — otherwise the user lands
    // mid-list when navigating into a new folder.
    useEffect(() => {
        setListScrollTop(0);
        if (listRef.current) listRef.current.scrollTop = 0;
    }, [currentPath, mountInfo?.id, wadCurrentDir, search]);
    // rAF-coalesce scrollTop updates so we don't re-render at the
    // browser's full scroll-event rate (which can exceed 120Hz on
    // some setups). One render per frame is plenty.
    const handleListScroll = () => {
        if (scrollRafRef.current !== null) return;
        scrollRafRef.current = requestAnimationFrame(() => {
            scrollRafRef.current = null;
            const el = listRef.current;
            if (el) setListScrollTop(el.scrollTop);
        });
    };
    const totalRows = visibleRows.length;
    const visibleStart = Math.max(0, Math.floor(listScrollTop / ROW_HEIGHT) - ROW_OVERSCAN);
    const visibleEnd = Math.min(totalRows, Math.ceil((listScrollTop + listViewH) / ROW_HEIGHT) + ROW_OVERSCAN);
    const renderedRows = visibleRows.slice(visibleStart, visibleEnd);

    const handleRowClick = (row: BrowseRow) => {
        if (row.kind === 'disk-folder') {
            setCurrentPath(row.entry.path);
            return;
        }
        if (row.kind === 'disk-file') {
            if (isWadFileName(row.entry.name)) {
                openWad(row.entry.path);
            } else {
                setSelected(row.entry);
                setWadSelected(null);
            }
            return;
        }
        if (row.kind === 'wad-folder') {
            setWadCurrentDir(row.subPath);
            setWadSelected(null);
            return;
        }
        // wad-file click semantics:
        //   - First click toggles the checkbox ON and shows the preview.
        //   - Clicking the *same* (currently-previewed) file again toggles
        //     the checkbox back OFF and clears the preview.
        //   - Clicking a *different* file just promotes it to the preview
        //     and adds it to the selection. Other checkboxes are never
        //     touched, mirroring Explorer's per-row behavior.
        const hash = row.entry.path_hash_hex;
        const isCurrentPreview = wadSelected?.path_hash_hex === hash;
        if (isCurrentPreview) {
            setSelectedHashes(prev => {
                const next = new Set(prev);
                next.delete(hash);
                return next;
            });
            setWadSelected(null);
        } else {
            setSelectedHashes(prev => {
                if (prev.has(hash)) return prev;
                const next = new Set(prev);
                next.add(hash);
                return next;
            });
            setWadSelected(row.entry);
            setSelected(null);
        }
    };

    // Hashes under a WAD sub-path. Reads them straight off the tree
    // node (populated at mount time) — used to be `wadEntries.filter`
    // which was O(total-WAD) per call and turned folder rendering into
    // a multi-second freeze on big WADs because every visible folder
    // row re-scanned the whole entry list twice.
    const hashesUnderPath = (subPath: string): string[] => {
        const node = getWadNode(subPath);
        return node ? node.descendantHashes : [];
    };

    const toggleFileHash = (hash: string) => {
        setSelectedHashes(prev => {
            const next = new Set(prev);
            if (next.has(hash)) next.delete(hash);
            else next.add(hash);
            return next;
        });
    };

    const toggleFolderHashes = (subPath: string) => {
        const folderHashes = hashesUnderPath(subPath);
        setSelectedHashes(prev => {
            const allChecked = folderHashes.length > 0
                && folderHashes.every(h => prev.has(h));
            const next = new Set(prev);
            if (allChecked) for (const h of folderHashes) next.delete(h);
            else for (const h of folderHashes) next.add(h);
            return next;
        });
    };

    // Folder selection state — short-circuits aggressively because the
    // common case is "no checkboxes ticked anywhere", in which every
    // folder is trivially "none". Only when `selectedHashes` is non-
    // empty do we actually scan the folder's descendant hashes.
    const folderSelectionState = (
        subPath: string,
    ): 'none' | 'partial' | 'full' => {
        if (selectedHashes.size === 0) return 'none';
        const hashes = hashesUnderPath(subPath);
        if (hashes.length === 0) return 'none';
        let any = false;
        let allSelected = true;
        for (const h of hashes) {
            if (selectedHashes.has(h)) any = true;
            else allSelected = false;
            // Once we've seen both, we know it's partial — bail early.
            if (any && !allSelected) return 'partial';
        }
        if (allSelected) return 'full';
        return 'none';
    };
    const isFolderFullySelected = (subPath: string): boolean =>
        folderSelectionState(subPath) === 'full';
    const isFolderPartiallySelected = (subPath: string): boolean =>
        folderSelectionState(subPath) === 'partial';

    // Click on a wad-file already adds it to `selectedHashes`, so the
    // "Extract Selected" set is just the checkbox state — no separate
    // click-pin layer to merge.
    const effectiveSelection = useMemo(() => Array.from(selectedHashes), [selectedHashes]);
    // Total queued items, mode-aware: WAD-mode counts files in the
    // mount, disk-mode counts ticked `.wad.client` paths.
    const totalSelectedFiles = mountInfo
        ? effectiveSelection.length
        : selectedDiskWads.size;

    const toggleDiskWad = (path: string) => {
        setSelectedDiskWads(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    // Range-select anchor: the index of the most recent checkbox click.
    // Reset whenever the visible row set changes — referencing an old
    // index after navigation would select garbage rows.
    const lastCheckboxIndexRef = useRef<number | null>(null);
    useEffect(() => {
        lastCheckboxIndexRef.current = null;
    }, [wadCurrentDir, mountInfo?.id, search]);

    const handleCheckboxClick = (rowIndex: number, e: React.MouseEvent) => {
        e.stopPropagation();
        const row = visibleRows[rowIndex];
        if (!row) return;
        // Only WAD entries (in-WAD) and disk-mode `.wad.client` rows are
        // meaningful targets — disk folders / non-WAD files have no
        // checkbox to toggle.
        const isCheckable = row.kind === 'wad-file'
            || row.kind === 'wad-folder'
            || (row.kind === 'disk-file' && isWadFileName(row.entry.name));
        if (!isCheckable) return;

        const collectHashes = (r: BrowseRow): string[] => {
            if (r.kind === 'wad-file') return [r.entry.path_hash_hex];
            if (r.kind === 'wad-folder') return hashesUnderPath(r.subPath);
            return [];
        };
        const collectDiskWads = (r: BrowseRow): string[] => {
            if (r.kind === 'disk-file' && isWadFileName(r.entry.name)) {
                return [r.entry.path];
            }
            return [];
        };
        const isRowChecked = (r: BrowseRow): boolean => {
            if (r.kind === 'wad-file') return selectedHashes.has(r.entry.path_hash_hex);
            if (r.kind === 'wad-folder') return isFolderFullySelected(r.subPath);
            if (r.kind === 'disk-file' && isWadFileName(r.entry.name)) {
                return selectedDiskWads.has(r.entry.path);
            }
            return false;
        };

        if (e.shiftKey && lastCheckboxIndexRef.current !== null) {
            const start = Math.min(lastCheckboxIndexRef.current, rowIndex);
            const end = Math.max(lastCheckboxIndexRef.current, rowIndex);
            // Target state = whatever the just-clicked row is about to
            // become, applied uniformly to the whole range. Mirrors
            // Explorer's shift-range select.
            const target = !isRowChecked(row);
            if (mountInfo) {
                setSelectedHashes(prev => {
                    const next = new Set(prev);
                    for (let i = start; i <= end; i++) {
                        for (const h of collectHashes(visibleRows[i])) {
                            if (target) next.add(h);
                            else next.delete(h);
                        }
                    }
                    return next;
                });
            } else {
                setSelectedDiskWads(prev => {
                    const next = new Set(prev);
                    for (let i = start; i <= end; i++) {
                        for (const p of collectDiskWads(visibleRows[i])) {
                            if (target) next.add(p);
                            else next.delete(p);
                        }
                    }
                    return next;
                });
            }
        } else if (row.kind === 'wad-file') {
            toggleFileHash(row.entry.path_hash_hex);
        } else if (row.kind === 'wad-folder') {
            toggleFolderHashes(row.subPath);
        } else if (row.kind === 'disk-file') {
            toggleDiskWad(row.entry.path);
        }
        lastCheckboxIndexRef.current = rowIndex;
    };

    return (
        <div className="welcome-extract">
            {/* 3-column Word-Open layout: sources column on the left,
                file list in the middle, preview on the right. WADs slot
                into this same layout — they act like folders inside the
                file list, with the breadcrumb walking through the WAD
                path and the preview pane decoding DDS / TEX entries. */}
            <h1 className="welcome-extract-title">Extract</h1>

            {hashStatus && !hashStatus.present && (
                <div className="welcome-hash-banner">
                    <div className="welcome-hash-banner-text">
                        <strong>WAD hashes not downloaded.</strong>
                        <span>
                            File names will appear as 16-char hex until the LMDB hashtable is fetched (~50 MB, shared with Quartz).
                        </span>
                    </div>
                    <button
                        type="button"
                        className="welcome-hash-banner-btn"
                        disabled={hashDownloading}
                        onClick={downloadHashes}
                    >
                        {hashDownloading
                            ? hashDownloadProgress
                                ? `${hashDownloadProgress.phase}…`
                                : 'Downloading…'
                            : 'Download hashes'}
                    </button>
                </div>
            )}

            <div className="welcome-extract-cols">
                {/* ── Sources column ── */}
                <div className="welcome-extract-sources-col">
                    <div className="welcome-source-section-title">Locations</div>
                    {leagueInstall ? (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === leagueInstall) ? ' active' : ''}`}
                            onClick={() => goToSource(leagueInstall)}
                        >
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends</span>
                                <span className="welcome-source-row-path" title={leagueInstall}>
                                    {leagueInstall}
                                </span>
                            </span>
                        </button>
                    ) : (
                        <div className="welcome-source-row welcome-source-disabled">
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends</span>
                                <span className="welcome-source-row-path">Not detected</span>
                            </span>
                        </div>
                    )}
                    {leaguePbeInstall ? (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === leaguePbeInstall) ? ' active' : ''}`}
                            onClick={() => goToSource(leaguePbeInstall)}
                        >
                            <FolderIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">League of Legends PBE</span>
                                <span className="welcome-source-row-path" title={leaguePbeInstall}>
                                    {leaguePbeInstall}
                                </span>
                            </span>
                        </button>
                    ) : null}
                    {home && (
                        <button
                            type="button"
                            className={`welcome-source-row${(!mountInfo && currentPath === home) ? ' active' : ''}`}
                            onClick={() => goToSource(home)}
                        >
                            <HomeIcon size={20} />
                            <span className="welcome-source-row-text">
                                <span className="welcome-source-row-label">User folder</span>
                                <span className="welcome-source-row-path" title={home}>{home}</span>
                            </span>
                        </button>
                    )}

                    {recentWads.length > 0 && (
                        <>
                            <div className="welcome-source-section-title welcome-source-section-spaced">
                                Recent WADs
                            </div>
                            {recentWads.map(path => {
                                const baseName = path.replace(/\\/g, '/').split('/').pop() || path;
                                const parent = path.replace(/\\/g, '/').split('/').slice(0, -1).join('/') || path;
                                return (
                                    <button
                                        key={path}
                                        type="button"
                                        className="welcome-source-row"
                                        onClick={() => openWad(path)}
                                        title={path}
                                    >
                                        <BoxIcon size={20} />
                                        <span className="welcome-source-row-text">
                                            <span className="welcome-source-row-label">{baseName}</span>
                                            <span className="welcome-source-row-path" title={parent}>{parent}</span>
                                        </span>
                                    </button>
                                );
                            })}
                        </>
                    )}

                    <div className="welcome-source-section-title welcome-source-section-spaced">
                        Other locations
                    </div>
                    <button type="button" className="welcome-source-row" onClick={browseFolder}>
                        <FolderIcon size={20} />
                        <span className="welcome-source-row-text">
                            <span className="welcome-source-row-label">Browse…</span>
                            <span className="welcome-source-row-path">Pick any folder</span>
                        </span>
                    </button>

                    {/* Extraction-specific settings — pinned to the bottom
                        of the sources column via `margin-top: auto`. The
                        button opens a tabbed dialog (mirrors the global
                        Settings layout) so the settings panel can grow
                        alongside future extraction-only options. */}
                    <div className="welcome-source-extract-settings">
                        <button
                            type="button"
                            className="welcome-source-settings-toggle"
                            onClick={() => setExtractionSettingsOpen(true)}
                        >
                            <span>Extraction settings</span>
                            <svg
                                width="12"
                                height="12"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="1.8"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <circle cx="12" cy="12" r="3" />
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                            </svg>
                        </button>
                    </div>
                </div>

                <ExtractionSettingsDialog
                    isOpen={extractionSettingsOpen}
                    onClose={() => setExtractionSettingsOpen(false)}
                    useRenamePattern={useRenamePattern}
                    onUseRenamePatternChange={toggleRenamePattern}
                />

                {/* Drop overlay — dimmed sheet across the whole Extract
                    view while a `.wad.client` is being dragged in. */}
                {dropActive && (
                    <div className="welcome-extract-dropzone" aria-hidden>
                        <div className="welcome-extract-dropzone-inner">
                            <BoxIcon size={48} />
                            <span>Drop a .wad.client to mount</span>
                        </div>
                    </div>
                )}

                {/* ── File list column ── */}
                <div className="welcome-extract-files-col">
                    <div className="welcome-extract-toolbar">
                        <button
                            type="button"
                            className="welcome-tool-btn"
                            onClick={goUp}
                            disabled={!currentPath && !mountInfo}
                            title={mountInfo
                                ? (wadCurrentDir ? 'Up one folder (inside WAD)' : 'Close WAD')
                                : 'Up one folder'}
                        >
                            <ArrowUpIcon size={16} />
                        </button>
                        <button
                            type="button"
                            className="welcome-tool-btn"
                            onClick={() => {
                                if (!currentPath) return;
                                invoke('open_folder_in_explorer', { path: currentPath })
                                    .catch(() => {});
                            }}
                            disabled={!currentPath || !!mountInfo}
                            title="Reveal current folder in Explorer"
                        >
                            <FolderRevealIcon size={16} />
                        </button>
                        <div className="welcome-breadcrumb" ref={breadcrumbRef}>
                            {breadcrumb.length === 0 && (
                                <span className="welcome-breadcrumb-empty">
                                    Pick a source on the left
                                </span>
                            )}
                            {breadcrumb.map((b, i) => (
                                <span key={i} className="welcome-breadcrumb-segment">
                                    <button
                                        type="button"
                                        className="welcome-breadcrumb-btn"
                                        onClick={b.onClick}
                                    >
                                        {b.label}
                                    </button>
                                    {i < breadcrumb.length - 1 && <ChevronRightIcon size={12} />}
                                </span>
                            ))}
                        </div>
                    </div>

                    {/* Search filters the current directory's entries by
                        substring — Word's "Search" box behavior. Inside
                        a WAD it becomes a whole-WAD substring search. */}
                    <div className="welcome-extract-search">
                        <span className="welcome-extract-search-icon">
                            <SearchIcon size={14} />
                        </span>
                        <input
                            type="text"
                            className="welcome-extract-search-input"
                            placeholder={mountInfo
                                ? 'Search this WAD…'
                                : (currentPath ? 'Search this folder…' : 'Pick a location first')}
                            value={search}
                            onChange={e => setSearch(e.target.value)}
                            disabled={!currentPath && !mountInfo}
                        />
                    </div>

                    <div className={`welcome-extract-table${mountInfo ? ' wad-mode' : ' disk-mode'}`}>
                        <div className="welcome-extract-row welcome-extract-row-header">
                            {(() => {
                                // Same header checkbox cell in both modes — the
                                // toggle scope changes (wad files vs disk wads),
                                // but the UI shape stays consistent so columns
                                // line up between in- and out-of-WAD views.
                                const checkableRows = visibleRows.filter(r => {
                                    if (mountInfo) return r.kind === 'wad-file' || r.kind === 'wad-folder';
                                    return r.kind === 'disk-file' && isWadFileName(r.entry.name);
                                });
                                const allChecked = checkableRows.length > 0 && checkableRows.every(r => {
                                    if (r.kind === 'wad-file') return selectedHashes.has(r.entry.path_hash_hex);
                                    if (r.kind === 'wad-folder') return isFolderFullySelected(r.subPath);
                                    if (r.kind === 'disk-file') return selectedDiskWads.has(r.entry.path);
                                    return false;
                                });
                                const handleHeaderToggle = () => {
                                    if (checkableRows.length === 0) return;
                                    const target = !allChecked;
                                    if (mountInfo) {
                                        setSelectedHashes(prev => {
                                            const next = new Set(prev);
                                            for (const r of checkableRows) {
                                                if (r.kind === 'wad-file') {
                                                    if (target) next.add(r.entry.path_hash_hex);
                                                    else next.delete(r.entry.path_hash_hex);
                                                } else if (r.kind === 'wad-folder') {
                                                    for (const h of hashesUnderPath(r.subPath)) {
                                                        if (target) next.add(h);
                                                        else next.delete(h);
                                                    }
                                                }
                                            }
                                            return next;
                                        });
                                    } else {
                                        setSelectedDiskWads(prev => {
                                            const next = new Set(prev);
                                            for (const r of checkableRows) {
                                                if (r.kind === 'disk-file') {
                                                    if (target) next.add(r.entry.path);
                                                    else next.delete(r.entry.path);
                                                }
                                            }
                                            return next;
                                        });
                                    }
                                };
                                return (
                                    <span
                                        className={`welcome-extract-row-checkbox${checkableRows.length === 0 ? ' welcome-extract-row-checkbox-empty' : ''}`}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            handleHeaderToggle();
                                        }}
                                        title={checkableRows.length === 0
                                            ? 'Nothing selectable in this folder'
                                            : mountInfo
                                                ? 'Select all visible'
                                                : 'Select all visible WADs'}
                                    >
                                        {checkableRows.length > 0 && (
                                            <input
                                                type="checkbox"
                                                checked={allChecked}
                                                onChange={() => { /* span handles it */ }}
                                                tabIndex={-1}
                                            />
                                        )}
                                    </span>
                                );
                            })()}
                            <span className="welcome-extract-row-icon" />
                            <span className="welcome-extract-row-name">Name</span>
                            <span className="welcome-extract-row-meta">Type</span>
                            <span className="welcome-extract-row-meta welcome-extract-row-size">Size</span>
                            {!mountInfo && <span className="welcome-extract-row-meta">Modified</span>}
                        </div>
                        <div
                            className="welcome-extract-list"
                            ref={listRef}
                            onScroll={handleListScroll}
                        >
                        {!mountInfo && loading && <div className="welcome-extract-empty">Loading…</div>}
                        {!mountInfo && !loading && error && (
                            <div className="welcome-extract-empty welcome-extract-error">{error}</div>
                        )}
                        {openingWad && (
                            <div className="welcome-extract-empty">Mounting WAD…</div>
                        )}
                        {!mountInfo && !loading && !error && !currentPath && (
                            <div className="welcome-extract-empty">Pick a location to start browsing</div>
                        )}
                        {!openingWad && visibleRows.length === 0 && (currentPath || mountInfo) && (
                            <div className="welcome-extract-empty">
                                {search.trim()
                                    ? 'No matches'
                                    : (mountInfo ? 'Empty folder' : 'Empty folder')}
                            </div>
                        )}
                        {!openingWad && totalRows > 0 && visibleStart > 0 && (
                            <div style={{ height: visibleStart * ROW_HEIGHT, flexShrink: 0 }} aria-hidden />
                        )}
                        {!openingWad && renderedRows.map((row, sliceIdx) => {
                            const rowIndex = visibleStart + sliceIdx;
                            if (row.kind === 'disk-folder' || row.kind === 'disk-file') {
                                const e = row.entry;
                                const isWad = row.kind === 'disk-file' && isWadFileName(e.name);
                                const isSelected = !mountInfo && selected?.path === e.path;
                                const isWadChecked = isWad && selectedDiskWads.has(e.path);
                                return (
                                    <button
                                        key={`disk:${e.path}`}
                                        type="button"
                                        className={`welcome-extract-row${isSelected ? ' selected' : ''}${isWad ? ' wad-file' : ''}${isWadChecked ? ' has-selection' : ''}`}
                                        onClick={() => handleRowClick(row)}
                                        onDoubleClick={() => row.kind === 'disk-folder' && setCurrentPath(e.path)}
                                        title={e.path}
                                    >
                                        {/* Checkbox cell stays present on every disk row so the
                                            divider line aligns vertically with the WAD-mode list.
                                            Folders + non-WAD files render the cell empty. */}
                                        <span
                                            className={`welcome-extract-row-checkbox${!isWad ? ' welcome-extract-row-checkbox-empty' : ''}`}
                                            onClick={(ev) => {
                                                if (!isWad) { ev.stopPropagation(); return; }
                                                handleCheckboxClick(rowIndex, ev);
                                            }}
                                        >
                                            {isWad && (
                                                <input
                                                    type="checkbox"
                                                    checked={isWadChecked}
                                                    onChange={() => { /* span handles it */ }}
                                                    tabIndex={-1}
                                                    aria-label={`Select WAD ${e.name}`}
                                                />
                                            )}
                                        </span>
                                        <span className="welcome-extract-row-icon">
                                            {e.is_dir
                                                ? <FolderIcon size={16} />
                                                : isWad
                                                    ? <BoxIcon size={16} />
                                                    : iconForExtension(e.extension)}
                                        </span>
                                        <span className="welcome-extract-row-name">{e.name}</span>
                                        <span className="welcome-extract-row-meta">
                                            {e.is_dir ? 'Folder' : (e.extension ? `.${e.extension}` : 'File')}
                                        </span>
                                        <span className="welcome-extract-row-meta welcome-extract-row-size">
                                            {e.is_dir ? '' : formatBytes(e.size)}
                                        </span>
                                        <span className="welcome-extract-row-meta">
                                            {formatRelative(e.modified)}
                                        </span>
                                    </button>
                                );
                            }
                            if (row.kind === 'wad-folder') {
                                const fullySelected = isFolderFullySelected(row.subPath);
                                const partiallySelected = isFolderPartiallySelected(row.subPath);
                                return (
                                    <button
                                        key={`wad-dir:${row.subPath}`}
                                        type="button"
                                        className={`welcome-extract-row${partiallySelected || fullySelected ? ' has-selection' : ''}`}
                                        onClick={() => handleRowClick(row)}
                                        title={row.subPath}
                                    >
                                        <span
                                            className="welcome-extract-row-checkbox"
                                            onClick={(e) => handleCheckboxClick(rowIndex, e)}
                                        >
                                            <input
                                                type="checkbox"
                                                checked={fullySelected}
                                                onChange={() => { /* span handles it */ }}
                                                ref={el => { if (el) el.indeterminate = partiallySelected; }}
                                                tabIndex={-1}
                                                aria-label={`Select folder ${row.name}`}
                                            />
                                        </span>
                                        <span className="welcome-extract-row-icon"><FolderIcon size={16} /></span>
                                        <span className="welcome-extract-row-name">{row.name}</span>
                                        <span className="welcome-extract-row-meta">Folder</span>
                                        <span className="welcome-extract-row-meta welcome-extract-row-size">{formatBytes(row.size)}</span>
                                    </button>
                                );
                            }
                            // wad-file
                            const f = row.entry;
                            const fname = f.path.includes('/')
                                ? f.path.slice(f.path.lastIndexOf('/') + 1)
                                : f.path;
                            const fdot = fname.lastIndexOf('.');
                            const fext = fdot === -1 ? '' : fname.slice(fdot);
                            const isPinned = wadSelected?.path_hash_hex === f.path_hash_hex;
                            const isChecked = selectedHashes.has(f.path_hash_hex);
                            return (
                                <button
                                    key={`wad-file:${f.path_hash_hex}`}
                                    type="button"
                                    className={`welcome-extract-row${isPinned ? ' selected' : ''}${isChecked ? ' has-selection' : ''}${f.unknown ? ' wad-unknown' : ''}`}
                                    onClick={() => handleRowClick(row)}
                                    title={f.path}
                                >
                                    <span
                                        className="welcome-extract-row-checkbox"
                                        onClick={(e) => handleCheckboxClick(rowIndex, e)}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isChecked}
                                            onChange={() => { /* span handles it */ }}
                                            tabIndex={-1}
                                            aria-label={`Select file ${fname}`}
                                        />
                                    </span>
                                    <span className="welcome-extract-row-icon">
                                        {iconForExtension(fext.replace(/^\./, ''))}
                                    </span>
                                    <span className="welcome-extract-row-name">
                                        {search.trim() ? f.path : fname}
                                    </span>
                                    <span className="welcome-extract-row-meta">
                                        {fext || (f.unknown ? 'Unknown' : 'File')}
                                    </span>
                                    <span className="welcome-extract-row-meta welcome-extract-row-size">
                                        {formatBytes(f.size)}
                                    </span>
                                </button>
                            );
                        })}
                        {!openingWad && totalRows > 0 && visibleEnd < totalRows && (
                            <div style={{ height: (totalRows - visibleEnd) * ROW_HEIGHT, flexShrink: 0 }} aria-hidden />
                        )}
                        </div>
                    </div>
                </div>

                {/* ── Preview column ── */}
                <aside className="welcome-extract-preview">
                    {/* Body — empty state, mount summary, or file detail.
                        Wrapped in its own flex container so the preview
                        image fills the column above the action strip. */}
                    <div className="welcome-preview-body">
                    {!previewItem && !mountInfo && (
                        <div className="welcome-preview-empty">
                            <DocIcon size={40} />
                            <span>Select a file to preview</span>
                            <span className="welcome-preview-empty-sub">
                                Click a <code>.wad.client</code> file to step inside and browse its contents.
                            </span>
                        </div>
                    )}
                    {!previewItem && mountInfo && (
                        <div className="welcome-preview-detail">
                            <div className="welcome-preview-name" title={mountInfo.path}>
                                {mountInfo.name}
                            </div>
                            <div className="welcome-preview-row">
                                <span className="welcome-preview-key">WAD version</span>
                                <span className="welcome-preview-val">v{mountInfo.version}</span>
                            </div>
                            <div className="welcome-preview-row">
                                <span className="welcome-preview-key">Files</span>
                                <span className="welcome-preview-val">
                                    {mountInfo.chunk_count.toLocaleString()}
                                </span>
                            </div>
                        </div>
                    )}
                    {previewItem && (
                        <div className="welcome-preview-detail">
                            {previewState.dataUrl && (
                                <div className="welcome-preview-image">
                                    <img src={previewState.dataUrl} alt={previewItem.name} />
                                </div>
                            )}
                            {previewState.loading && (
                                <div className="welcome-preview-image welcome-preview-image-loading">
                                    Decoding preview…
                                </div>
                            )}
                            {previewState.error && (
                                <div className="welcome-preview-image welcome-preview-image-error">
                                    {previewState.error}
                                </div>
                            )}
                            <div className="welcome-preview-name" title={previewItem.path}>
                                {previewItem.name}
                            </div>
                            <div className="welcome-preview-meta-line">
                                {previewItem.type}
                                {' · '}
                                {formatBytes(previewItem.size)}
                                {previewState.format && (
                                    <>{' · '}{previewState.format}</>
                                )}
                                {previewState.width && previewState.height && (
                                    <>{' · '}{previewState.width}×{previewState.height}</>
                                )}
                            </div>
                            {/* Disk-only "Open WAD" shortcut — for everything else, the
                                Extract button on the left column is the canonical action. */}
                            {!mountInfo && selected && isWadFileName(selected.name) && (
                                <div className="welcome-preview-actions">
                                    <button
                                        type="button"
                                        className="welcome-preview-action"
                                        onClick={() => openWad(selected.path)}
                                        disabled={openingWad}
                                    >
                                        {openingWad ? 'Opening…' : 'Open WAD'}
                                    </button>
                                </div>
                            )}
                        </div>
                    )}
                    </div>

                    {/* Actions strip — pinned to the bottom of the preview
                        pane. Always rendered; buttons grey out when there's
                        nothing to act on. */}
                    <div className="welcome-preview-actions">
                        <button
                            type="button"
                            className="welcome-source-action-btn"
                            onClick={() => {
                                if (mountInfo) {
                                    startExtraction(effectiveSelection);
                                } else {
                                    startDiskWadsExtraction(Array.from(selectedDiskWads));
                                }
                            }}
                            disabled={extracting || totalSelectedFiles === 0}
                            title={totalSelectedFiles === 0
                                ? mountInfo
                                    ? 'Tick checkboxes or click a file to mark items for extraction'
                                    : 'Tick a .wad.client file to queue it for extraction'
                                : `${totalSelectedFiles.toLocaleString()} ${mountInfo ? 'file' : 'WAD'}(s) queued`}
                        >
                            {extracting && totalSelectedFiles > 0
                                ? 'Extracting…'
                                : totalSelectedFiles > 0
                                    ? mountInfo
                                        ? `Extract selected (${totalSelectedFiles.toLocaleString()})`
                                        : `Extract ${totalSelectedFiles.toLocaleString()} WAD${totalSelectedFiles === 1 ? '' : 's'}`
                                    : 'Extract selected'}
                        </button>
                        <button
                            type="button"
                            className="welcome-source-action-btn primary"
                            onClick={() => startExtraction([])}
                            disabled={!mountInfo || extracting}
                            title={mountInfo
                                ? `Extracts every file in ${mountInfo.name}`
                                : 'Open a .wad.client file first'}
                        >
                            {extracting && mountInfo && totalSelectedFiles === 0
                                ? 'Extracting…'
                                : mountInfo
                                    ? `Extract WAD (${mountInfo.chunk_count.toLocaleString()})`
                                    : 'Extract WAD'}
                        </button>
                        <button
                            type="button"
                            className="welcome-source-action-cancel"
                            onClick={cancelExtraction}
                            disabled={!extracting}
                            title={extracting ? 'Cancel extraction' : 'Nothing to cancel'}
                            aria-label="Cancel extraction"
                        >
                            <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2.2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                            >
                                <line x1="6" y1="6" x2="18" y2="18" />
                                <line x1="18" y1="6" x2="6" y2="18" />
                            </svg>
                        </button>
                    </div>
                </aside>
            </div>
        </div>
    );
}

/* Local outlined glyphs — kept here so the welcome screen has its own
   simple line-icon set that matches PaletteIcon / LibraryIcon /
   SettingsIcon (the other icons we use). The ribbon's filled Fluent
   DocIcon / FolderIcon would clash visually, so we don't reuse
   those here. All draw in currentColor only — no accent fills. */
function HomeIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M3 11.5 12 4l9 7.5" />
            <path d="M5 10v10h14V10" />
            <path d="M10 20v-6h4v6" />
        </svg>
    );
}

function DocIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
        </svg>
    );
}

function FolderIcon({ size = 20 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M20 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    );
}

/* Cardboard-box glyph — used for `.wad.client` rows so they read as
   "package containing files" rather than a plain document. A flat
   front-on box with a top lid + a horizontal seam that suggests
   shipping tape. Stays in lockstep with the other line icons via
   `currentColor`. */
function BoxIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="2.5" y="3.5" width="19" height="5" rx="0.5" />
            <path d="M3.5 8.5v11a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5v-11" />
            <line x1="9.5" y1="13" x2="14.5" y2="13" />
        </svg>
    );
}

/* Texture / image glyph — picture frame with sun + mountain. Used for
   `.dds` and `.tex` rows in the WAD list so the eye spots textures
   without reading the extension column. */
function TextureIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="9" r="1.5" />
            <path d="M21 15l-4.5-4.5a1.5 1.5 0 0 0-2.12 0L4 21" />
        </svg>
    );
}

/** Pick the right outlined glyph for a file row by extension. WAD
 *  package files are handled separately (caller checks `isWadFileName`)
 *  because their extension is `.client` rather than `.wad`. */
function iconForExtension(ext: string): React.ReactElement {
    const lower = (ext || '').toLowerCase();
    if (lower === 'dds' || lower === 'tex' || lower === 'png' || lower === 'jpg' || lower === 'jpeg' || lower === 'bmp') {
        return <TextureIcon size={16} />;
    }
    return <DocIcon size={16} />;
}

function ArrowUpIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M12 19V5" />
            <path d="M5 12l7-7 7 7" />
        </svg>
    );
}

/* Plain folder — "reveal this folder in the OS file manager". */
function FolderRevealIcon({ size = 16 }: { size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
        >
            <path d="M20 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
    );
}
