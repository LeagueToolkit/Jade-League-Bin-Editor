import { useState, useEffect, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './MaterialOverrideDialog.css';

interface MaterialSuggestion {
  material: string;
  texture: string;
}

// Mirrors library_commands.rs
interface LibraryIndexEntry {
  id: string;
  path: string;
  name: string;
  category: string;
  champion: string | null;
  skin: string | null;
  description: string;
  tags: string[];
  hasPreview: boolean;
  userSlots: string[];
  featured: boolean;
  version: number;
  updatedAt: string;
  materialName: string | null;
}
interface LibraryIndex {
  schemaVersion: number;
  lastUpdated: string;
  categories: { id: string; name: string }[];
  champions: string[];
  materials: LibraryIndexEntry[];
}
interface DownloadedMaterialInfo {
  id: string;
  path: string;
  name: string;
  category: string;
  version: number;
  sizeBytes: number;
  hasPreview: boolean;
  previewPath: string | null;
}

export interface LibraryPairResult {
  materialId: string;
  materialPath: string;
  materialName: string; // jadelib_<id> the override should link to
}

interface MaterialOverrideDialogProps {
  type: 'texture' | 'material';
  defaultPath: string;
  onSubmit: (path: string, submesh: string) => void;
  /** Called instead of onSubmit when the user picked a library material to pair with. */
  onSubmitWithLibrary?: (
    path: string,
    submesh: string,
    library: LibraryPairResult
  ) => void;
  onCancel: () => void;
  suggestions?: MaterialSuggestion[];
}

export default function MaterialOverrideDialog({
  type,
  defaultPath,
  onSubmit,
  onSubmitWithLibrary,
  onCancel,
  suggestions
}: MaterialOverrideDialogProps) {
  const [path, setPath] = useState(defaultPath);
  const [submesh, setSubmesh] = useState(suggestions?.[0]?.material || 'submesh');
  const [error, setError] = useState('');

  // ── Library pairing state (only used for `type === 'material'`) ──
  const [libraryEnabled, setLibraryEnabled] = useState(false);
  const [libraryIndex, setLibraryIndex] = useState<LibraryIndex | null>(null);
  const [downloaded, setDownloaded] = useState<DownloadedMaterialInfo[]>([]);
  const [selectedLibPath, setSelectedLibPath] = useState<string>('');
  const [libraryError, setLibraryError] = useState<string>('');
  const [busy, setBusy] = useState(false);

  // Load library data lazily — only when the section is expanded
  useEffect(() => {
    if (!libraryEnabled || libraryIndex) return;
    (async () => {
      try {
        const cached = await invoke<LibraryIndex | null>('library_get_cached_index');
        if (cached) setLibraryIndex(cached);
        const d = await invoke<DownloadedMaterialInfo[]>('library_list_downloaded');
        setDownloaded(d);
      } catch (e) {
        setLibraryError(typeof e === 'string' ? e : String(e));
      }
    })();
  }, [libraryEnabled, libraryIndex]);

  const downloadedPaths = useMemo(
    () => new Set(downloaded.map((d) => d.path)),
    [downloaded]
  );

  // List for the selector: downloaded materials first (instant), then featured
  const selectorItems = useMemo(() => {
    if (!libraryIndex) return [] as Array<{ entry: LibraryIndexEntry; cached: boolean }>;
    const result: Array<{ entry: LibraryIndexEntry; cached: boolean }> = [];
    for (const m of libraryIndex.materials) {
      if (downloadedPaths.has(m.path)) {
        result.push({ entry: m, cached: true });
      }
    }
    for (const m of libraryIndex.materials) {
      if (!downloadedPaths.has(m.path) && m.featured) {
        result.push({ entry: m, cached: false });
      }
    }
    return result;
  }, [libraryIndex, downloadedPaths]);

  // When user picks a library material, auto-fill the material path with
  // the prefixed material name from the index (materialName field) or fall
  // back to deriving it from the id.
  useEffect(() => {
    if (!selectedLibPath || type !== 'material') return;
    const entry = libraryIndex?.materials.find((m) => m.path === selectedLibPath);
    const materialName =
      entry?.materialName || `jadelib_${(entry?.id || selectedLibPath).replace(/-/g, '_')}`;
    setPath(materialName);
  }, [selectedLibPath, type, libraryIndex]);

  // When user picks a suggestion, fill both fields
  const applySuggestion = (s: MaterialSuggestion) => {
    setSubmesh(s.material);
    if (type === 'texture' && s.texture) {
      setPath(s.texture);
    }
  };

  const handleSubmit = async () => {
    const trimmedPath = path.trim();
    const trimmedSubmesh = submesh.trim();

    if (!trimmedPath) {
      setError('Path cannot be empty');
      return;
    }
    if (!trimmedSubmesh) {
      setError('Submesh cannot be empty');
      return;
    }

    // Library pairing path
    if (libraryEnabled && selectedLibPath && onSubmitWithLibrary) {
      setBusy(true);
      try {
        if (!downloadedPaths.has(selectedLibPath)) {
          await invoke('library_fetch_material', { path: selectedLibPath });
        }
        const entry = libraryIndex?.materials.find((m) => m.path === selectedLibPath);
        const materialName =
          entry?.materialName ||
          `jadelib_${(entry?.id || selectedLibPath).replace(/-/g, '_')}`;
        onSubmitWithLibrary(trimmedPath, trimmedSubmesh, {
          materialId: entry?.id || selectedLibPath,
          materialPath: selectedLibPath,
          materialName,
        });
      } catch (e) {
        setError(`Failed to fetch library material: ${e}`);
        setBusy(false);
        return;
      }
      setBusy(false);
      return;
    }

    onSubmit(trimmedPath, trimmedSubmesh);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSubmit();
    else if (e.key === 'Escape') onCancel();
  };

  const title = type === 'texture' ? 'Add Texture Entry' : 'Add Material Entry';
  const pathLabel = type === 'texture' ? 'Texture Path' : 'Material Path';
  const hasSuggestions = suggestions && suggestions.length > 0;

  return (
    <div className="mod-overlay" onClick={onCancel}>
      <div className="mod-dialog" onClick={(e) => e.stopPropagation()} onKeyDown={handleKeyDown}>
        <div className="mod-header">
          <span className="mod-title">{title}</span>
          <button
            className="mod-close-btn"
            onClick={onCancel}
            title="Cancel (Escape)"
          />
        </div>

        <div className="mod-content">
          {hasSuggestions && (
            <div className="mod-field">
              <label className="mod-label">Suggested from SKN</label>
              <div className="mod-suggestions">
                {suggestions!.map((s, i) => (
                  <button
                    key={i}
                    className={`mod-suggestion ${submesh === s.material ? 'active' : ''}`}
                    onClick={() => applySuggestion(s)}
                    title={s.texture || 'No texture match'}
                  >
                    <span className="mod-suggestion-name">{s.material}</span>
                    {s.texture ? (
                      <span className="mod-suggestion-match">matched</span>
                    ) : (
                      <span className="mod-suggestion-nomatch">no match</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="mod-field">
            <label className="mod-label">{pathLabel}</label>
            <input
              type="text"
              className="mod-input mod-input-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="ASSETS/Characters/..."
              autoFocus={!hasSuggestions}
              title={path}
            />
          </div>

          <div className="mod-field">
            <label className="mod-label">Submesh</label>
            <input
              type="text"
              className="mod-input"
              value={submesh}
              onChange={(e) => setSubmesh(e.target.value)}
              placeholder="submesh"
            />
          </div>

          {/* ── Library pairing (only for material entries) ── */}
          {type === 'material' && onSubmitWithLibrary && (
            <div className="mod-library-section">
              <label className="mod-library-toggle">
                <input
                  type="checkbox"
                  checked={libraryEnabled}
                  onChange={(e) => {
                    setLibraryEnabled(e.target.checked);
                    if (!e.target.checked) setSelectedLibPath('');
                  }}
                />
                <span>Pair with Library Material</span>
              </label>

              {libraryEnabled && (
                <div className="mod-library-body">
                  {libraryError && (
                    <div className="mod-library-error">{libraryError}</div>
                  )}

                  {!libraryIndex && !libraryError && (
                    <div className="mod-library-empty">Loading library…</div>
                  )}

                  {libraryIndex && selectorItems.length === 0 && (
                    <div className="mod-library-empty">
                      No materials available. Open the Material Library to download some.
                    </div>
                  )}

                  {selectorItems.length > 0 && (
                    <select
                      className="mod-input mod-library-select"
                      value={selectedLibPath}
                      onChange={(e) => setSelectedLibPath(e.target.value)}
                    >
                      <option value="">— Select a material —</option>
                      <optgroup label="Downloaded">
                        {selectorItems
                          .filter((s) => s.cached)
                          .map((s) => (
                            <option key={s.entry.path} value={s.entry.path}>
                              {s.entry.name} (v{s.entry.version})
                            </option>
                          ))}
                      </optgroup>
                      <optgroup label="★ Featured">
                        {selectorItems
                          .filter((s) => !s.cached)
                          .map((s) => (
                            <option key={s.entry.path} value={s.entry.path}>
                              {s.entry.name} — fetch on insert
                            </option>
                          ))}
                      </optgroup>
                    </select>
                  )}

                  {selectedLibPath && (
                    <p className="mod-library-hint">
                      Insert will add both the override entry and the full{' '}
                      <code>StaticMaterialDef</code> from{' '}
                      <code>{selectedLibPath}</code>.
                    </p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {error && (
          <div className="mod-error">{error}</div>
        )}

        <div className="mod-actions">
          <button className="mod-btn mod-btn-cancel" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="mod-btn mod-btn-accept" onClick={handleSubmit} disabled={busy}>
            {busy ? 'Working…' : 'Accept'}
          </button>
        </div>
      </div>
    </div>
  );
}
