import { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import MaterialOverrideDockPanel, { type LibraryPairResult } from './MaterialOverrideDockPanel';
import { useShell } from './ShellContext';

interface AutoMaterialResult {
    matches: { material: string; texture: string }[];
    skn_path: string;
    unmatched: string[];
    textures: string[];
}

interface MaterialOverridePanelProps {
    /** `'texture'`: insert `texture: string = "..."`.
     *  `'material'`: insert `material: link = "..."`. */
    entryType: 'texture' | 'material';
    /** Called when the user closes the panel via Cancel / dock × button. */
    onClose: () => void;
}

/**
 * Dockable variant of the material-override insert flow. Re-uses the
 * full `MaterialOverrideDialog` component in `embedded` mode so SKN
 * suggestions, library pairing, texture previews, and the manual
 * texture picker all keep working — only the modal overlay is
 * stripped. State (active bin path, default texture, suggestions,
 * detected textures) is derived from `useShell()` instead of being
 * piped through props from a parent.
 */
export default function MaterialOverridePanel({ entryType, onClose }: MaterialOverridePanelProps) {
    const s = useShell();
    const tab = s.activeTab;
    const filePath = tab?.filePath ?? undefined;

    const [defaultPath, setDefaultPath] = useState('');
    const [suggestions, setSuggestions] = useState<{ material: string; texture: string }[]>([]);
    const [detectedTextures, setDetectedTextures] = useState<string[]>([]);

    // ── Helpers — same logic the General Edit panel uses, kept local
    //     so this panel stands alone. ──
    const editorContent = () =>
        s.editorRef.current?.getValue() ?? tab?.content ?? '';

    const extractFirst = (key: string): string => {
        const lines = editorContent().split('\n');
        for (const raw of lines) {
            const trimmed = raw.trim();
            if (trimmed.toLowerCase().startsWith(key.toLowerCase() + ':')) {
                const parts = trimmed.split('=');
                if (parts.length >= 2) {
                    return parts[1].trim().replace(/^["']|["']$/g, '');
                }
            }
        }
        return '';
    };

    // Initial defaults + lazy suggestion load whenever the active file
    // or tool open state changes.
    useEffect(() => {
        let cancelled = false;
        const texturePath = extractFirst('texture');
        setDefaultPath(texturePath);
        setSuggestions([]);
        setDetectedTextures([]);

        if (!filePath) return;
        const simpleSkinPath = extractFirst('simpleSkin');
        if (!simpleSkinPath || !texturePath) return;

        (async () => {
            try {
                const matchModeStr = await invoke<string>('get_preference', {
                    key: 'MaterialMatchMode',
                    defaultValue: '3',
                });
                const matchMode = parseInt(matchModeStr, 10) || 3;
                const result = await invoke<AutoMaterialResult>('auto_material_override', {
                    binFilePath: filePath,
                    simpleSkinPath,
                    texturePath,
                    matchMode,
                });
                if (cancelled) return;

                // Skip submeshes that already have a material override.
                const existing = new Set<string>();
                for (const line of editorContent().split('\n')) {
                    const t = line.trim();
                    if (t.toLowerCase().startsWith('submesh:')) {
                        const parts = t.split('=');
                        if (parts.length >= 2) {
                            existing.add(parts[1].trim().replace(/^["']|["']$/g, '').toLowerCase());
                        }
                    }
                }

                const out: { material: string; texture: string }[] = [];
                for (const m of result.matches) {
                    if (!existing.has(m.material.toLowerCase())) out.push({ material: m.material, texture: m.texture });
                }
                for (const u of result.unmatched) {
                    if (!existing.has(u.toLowerCase())) out.push({ material: u, texture: '' });
                }
                setSuggestions(out);
                setDetectedTextures(result.textures ?? []);
            } catch {
                // Silently fall back to manual mode.
            }
        })();
        return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [filePath, tab?.id, entryType]);

    // ── Insert logic — mirrors GeneralEditPanel.addMaterialOverrideEntry. ──
    const insertEntry = useCallback((path: string, submesh: string, type: 'texture' | 'material') => {
        const content = editorContent();
        if (!content) return false;
        const lines = content.split('\n');

        let mainIndex = -1;
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) {
                mainIndex = i;
                break;
            }
        }
        if (mainIndex === -1) return false;

        let depth = 0;
        let insertIndex = -1;
        for (let j = mainIndex; j < lines.length; j++) {
            for (const c of lines[j]) {
                if (c === '{') depth++;
                else if (c === '}') depth--;
            }
            if (depth === 0 && j > mainIndex) { insertIndex = j; break; }
        }
        if (insertIndex === -1) return false;

        let indent = '            ';
        const sample = lines[mainIndex + 1];
        if (sample && sample.trim()) {
            const m = sample.match(/^(\s*)/);
            if (m) indent = m[1];
        }

        const propertyType = type === 'texture' ? 'string' : 'link';
        const propertyName = type === 'texture' ? 'texture' : 'material';
        const block = [
            `${indent}SkinMeshDataProperties_MaterialOverride {`,
            `${indent}    ${propertyName}: ${propertyType} = "${path}"`,
            `${indent}    Submesh: string = "${submesh}"`,
            `${indent}}`,
        ];

        const next: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            if (i === insertIndex) next.push(...block);
            next.push(lines[i]);
        }
        s.handleGeneralEditContentChange(next.join('\n'));
        return true;
    }, [s, tab]);

    const onSubmit = useCallback((path: string, submesh: string) => {
        insertEntry(path, submesh, entryType);
        onClose();
    }, [insertEntry, entryType, onClose]);

    const onSubmitWithLibrary = useCallback((
        _path: string,
        submesh: string,
        library: LibraryPairResult,
    ) => {
        // Library pairing inserts both an override entry AND the
        // StaticMaterialDef snippet — that flow is owned by the
        // GeneralEditPanel today (resolves SKN user slots, etc.).
        // For the standalone panel we insert the override row only;
        // the user can drop the full snippet via General Editing
        // when they need it.
        insertEntry(library.materialName, submesh, 'material');
        if (filePath) {
            s.recordJadelibInsert(filePath, library.materialPath, library.materialId);
        }
        onClose();
    }, [insertEntry, filePath, s, onClose]);

    return (
        <MaterialOverrideDockPanel
            type={entryType}
            defaultPath={defaultPath}
            suggestions={suggestions}
            detectedTextures={detectedTextures}
            binFilePath={filePath}
            onSubmit={onSubmit}
            onSubmitWithLibrary={onSubmitWithLibrary}
            onCancel={onClose}
        />
    );
}
