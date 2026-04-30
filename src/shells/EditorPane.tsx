import Editor from '@monaco-editor/react';
import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { RITOBIN_LANGUAGE_ID } from '../lib/ritobinLanguage';
import { getFileExtension } from '../lib/binOperations';
import { getFileName } from '../components/TabBar';
import GeneralEditPanel from '../components/GeneralEditPanel';
import ParticleEditorPanel from '../components/ParticleEditorPanel';
import MarkdownPreview from '../components/MarkdownPreview';
import MarkdownEditPanel from '../components/MarkdownEditPanel';
import TexturePreviewTab from '../components/TexturePreviewTab';
import QuartzDiffTab from '../components/QuartzDiffTab';
import { useShell, type PerfMode } from './ShellContext';

/**
 * The editor surface — Monaco plus the variant tab types (texture, markdown
 * preview, quartz diff) plus the floating edit panels that anchor against
 * `.editor-container`.
 *
 * Shared between shells. The chrome around it (title bar, tab strip, ribbon
 * vs menu bar, etc.) lives in each shell's component.
 */
export default function EditorPane() {
    const s = useShell();
    const { activeTab, shellVariant } = s;
    const isWord = shellVariant === 'word';
    const isVS = shellVariant === 'visualstudio';
    const stripChrome = isWord; // VS keeps full Monaco chrome — only Word goes "page" mode
    const dockPanels = isWord || isVS;

    // User-tunable editor font size + line height. Loaded from prefs on
    // mount and live-updated via custom events the ribbon's Syntax group
    // dispatches. lineHeight=0 means "use Monaco's default", anything
    // else is a multiplier of the font size.
    const [editorFontSize, setEditorFontSize] = useState(14);
    const [editorLineHeight, setEditorLineHeight] = useState(0);
    useEffect(() => {
        let cancelled = false;
        invoke<string>('get_preference', { key: 'EditorFontSize', defaultValue: '14' })
            .then(v => { if (!cancelled) setEditorFontSize(Number(v) || 14); })
            .catch(() => {});
        invoke<string>('get_preference', { key: 'EditorLineHeight', defaultValue: '0' })
            .then(v => { if (!cancelled) setEditorLineHeight(Number(v) || 0); })
            .catch(() => {});
        const onSize = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) setEditorFontSize(n);
        };
        const onLh = (e: Event) => {
            const n = Number((e as CustomEvent).detail);
            if (Number.isFinite(n)) setEditorLineHeight(n);
        };
        window.addEventListener('jade-editor-fontsize-changed', onSize);
        window.addEventListener('jade-editor-lineheight-changed', onLh);
        return () => {
            cancelled = true;
            window.removeEventListener('jade-editor-fontsize-changed', onSize);
            window.removeEventListener('jade-editor-lineheight-changed', onLh);
        };
    }, []);



    return (
        <>
            {activeTab?.tabType === 'texture-preview' && activeTab.filePath && (
                <TexturePreviewTab
                    filePath={activeTab.filePath}
                    imageDataUrl={activeTab.textureDataUrl ?? null}
                    texWidth={activeTab.textureWidth ?? 0}
                    texHeight={activeTab.textureHeight ?? 0}
                    format={activeTab.textureFormat ?? 0}
                    error={activeTab.textureError ?? null}
                    isReloading={s.reloadingTexTabId === activeTab.id}
                    onEditImage={() => s.handleTexEditImage(activeTab.filePath)}
                    onShowInExplorer={() => s.handleTexShowInExplorer(activeTab.filePath)}
                    onReload={s.handleTexReload}
                />
            )}
            {activeTab?.tabType === 'markdown-preview' && (
                <MarkdownPreview content={s.mdPreviewContent} />
            )}
            {activeTab?.tabType === 'quartz-diff' && (
                <QuartzDiffTab
                    fileName={activeTab.diffSourceFilePath ? getFileName(activeTab.diffSourceFilePath) : activeTab.fileName}
                    mode={activeTab.diffMode ?? 'paint'}
                    status={activeTab.diffStatus ?? 'pending'}
                    originalContent={activeTab.diffOriginalContent ?? ''}
                    modifiedContent={activeTab.diffModifiedContent ?? ''}
                    revisionIndex={s.activeDiffRevisionIndex}
                    revisionCount={Math.max(1, s.activeDiffEntriesLength)}
                    onPrevRevision={() => s.switchQuartzDiffRevision(activeTab.id, 'prev')}
                    onNextRevision={() => s.switchQuartzDiffRevision(activeTab.id, 'next')}
                    onAccept={() => {
                        if (activeTab.diffEntryId) {
                            s.handleAcceptQuartzHistory(activeTab.diffEntryId);
                        }
                    }}
                    onReject={() => {
                        if (activeTab.diffEntryId) {
                            s.handleRejectQuartzHistory(activeTab.diffEntryId);
                        }
                    }}
                />
            )}

            <div
                className="editor-container"
                style={
                    s.tabs.length === 0 || !s.isEditorTab(activeTab)
                        ? { display: 'none' }
                        : undefined
                }
            >
                <Editor
                    height="100%"
                    defaultLanguage={RITOBIN_LANGUAGE_ID}
                    theme={s.editorTheme}
                    beforeMount={s.handleBeforeMount}
                    onMount={s.handleEditorMount}
                    onChange={s.handleEditorChange}
                    options={(() => {
                        const isBig = s.lineCount > s.bigFileLines;
                        const isOn = (mode: PerfMode) => mode === 'on' ? true : mode === 'off' ? false : !isBig;
                        // Word shell mimics MS Word's clean page surface — no
                        // minimap, no line numbers, no gutter, no overview ruler.
                        // The editor still keeps full bin syntax + features, but
                        // the chrome is stripped to feel like a document, not an IDE.
                        return {
                            minimap: { enabled: stripChrome ? false : isOn(s.perfPrefs.minimap) },
                            glyphMargin: !stripChrome,
                            lineNumbers: (stripChrome ? 'off' : 'on') as 'off' | 'on',
                            fontSize: editorFontSize,
                            // 0 == Monaco default. Non-zero is a multiplier
                            // of fontSize, converted to pixels for Monaco.
                            lineHeight: editorLineHeight > 0
                                ? Math.round(editorFontSize * editorLineHeight)
                                : 0,
                            scrollBeyondLastLine: false,
                            automaticLayout: true,
                            // Word shell defaults to a sans-serif "document"
                            // stack but yields to a user-selected font when
                            // one is set, so swapping fonts from the ribbon
                            // gallery actually changes Monaco's typeface.
                            // Other shells just honor the user override (or
                            // leave undefined to keep Monaco's own default).
                            fontFamily: stripChrome
                                ? (s.editorFontFamily || "'Aptos', 'Calibri', 'Segoe UI', system-ui, sans-serif")
                                : (s.editorFontFamily || undefined),
                            lineNumbersMinChars: stripChrome ? 0 : 6,
                            fixedOverflowWidgets: true,
                            contextmenu: false,
                            largeFileOptimizations: false,
                            maxTokenizationLineLength: 100_000,
                            folding: stripChrome ? false : isOn(s.perfPrefs.folding),
                            occurrencesHighlight: (!stripChrome && isOn(s.perfPrefs.occurrencesHighlight) ? 'singleFile' : 'off') as 'singleFile' | 'off',
                            selectionHighlight: !stripChrome && isOn(s.perfPrefs.selectionHighlight),
                            renderLineHighlight: (stripChrome
                                ? 'none'
                                : (isOn(s.perfPrefs.lineHighlight) ? 'all' : 'gutter')) as 'all' | 'gutter' | 'none',
                            stopRenderingLineAfter: isOn(s.perfPrefs.stopRenderingLine) ? -1 : 10000,
                            renderWhitespace: 'none' as const,
                            overviewRulerLanes: stripChrome ? 0 : 3,
                            overviewRulerBorder: !stripChrome,
                            hideCursorInOverviewRuler: stripChrome,
                            scrollbar: stripChrome
                                ? {
                                    // Word mode: the page rectangle is now
                                    // decorative (full height of the desk,
                                    // not scrollable on its own). Text
                                    // scrolls inside Monaco like a normal
                                    // code editor.
                                    vertical: 'auto' as const,
                                    horizontal: 'hidden' as const,
                                    useShadows: false,
                                }
                                : undefined,
                            // Word shell: inner top/bottom padding so the first
                            // and last lines don't hug the page edge. Combined
                            // with the desk margin in .editor-container this
                            // gives the standard Word ~1in page-margin feel.
                            padding: stripChrome ? { top: 56, bottom: 112 } : undefined,
                            // Pad the left side of every line so text starts
                            // ~1in from the page edge — Monaco has no native
                            // horizontal padding option, so we abuse the line
                            // decorations gutter instead.
                            lineDecorationsWidth: stripChrome ? 64 : undefined,
                            // Wrap earlier in Word mode so text leaves a
                            // right margin that visually mirrors the 64px
                            // left page margin (lineDecorationsWidth above).
                            // 'bounded' keeps the viewport edge as a hard
                            // backstop on narrow windows.
                            wordWrap: (stripChrome ? 'on' : 'off') as 'on' | 'off',
                            wordWrapColumn: stripChrome ? 64 : undefined,
                            find: {
                                addExtraSpaceOnTop: false,
                                autoFindInSelection: 'never' as const,
                                seedSearchStringFromSelection: 'always' as const,
                            },
                            ...({
                                "bracketPairColorization.enabled": !stripChrome && isOn(s.perfPrefs.bracketColors),
                                "suggest.maxVisibleSuggestions": 5,
                                "semanticHighlighting.enabled": false,
                                "guides.indentation": !stripChrome,
                            } as any),
                        };
                    })()}
                />
                {/* Floating edit panels are VSCode-shell only. The Word
                    and Visual Studio shells dock these in their own
                    side/right/bottom panes. */}
                {!dockPanels && activeTab && s.isEditorTab(activeTab) && (() => {
                    const tabName = activeTab.filePath ?? activeTab.fileName;
                    const ext = getFileExtension(tabName);
                    const isMarkdown = ext === 'md' || ext === 'markdown';
                    if (isMarkdown) {
                        return (
                            <MarkdownEditPanel
                                isOpen={s.generalEditPanelOpen}
                                onClose={() => s.setGeneralEditPanelOpen(false)}
                                wrapSelection={s.mdWrapSelection}
                                prefixLines={s.mdPrefixLines}
                                insertAtCaret={s.mdInsertAtCaret}
                            />
                        );
                    }
                    return (
                        <GeneralEditPanel
                            isOpen={s.generalEditPanelOpen}
                            onClose={() => s.setGeneralEditPanelOpen(false)}
                            editorContent={s.editorRef.current?.getValue() || activeTab.content}
                            onContentChange={s.handleGeneralEditContentChange}
                            filePath={activeTab.filePath ?? undefined}
                            onLibraryInsert={s.recordJadelibInsert}
                        />
                    );
                })()}
                {!dockPanels && activeTab && s.isEditorTab(activeTab) && (
                    <ParticleEditorPanel
                        isOpen={s.particlePanelOpen}
                        onClose={() => s.setParticlePanelOpen(false)}
                        editorContent={s.editorRef.current?.getValue() || activeTab.content}
                        onContentChange={s.handleGeneralEditContentChange}
                        onScrollToLine={s.handleScrollToLine}
                        onStatusUpdate={s.setStatusMessage}
                    />
                )}
            </div>
        </>
    );
}
