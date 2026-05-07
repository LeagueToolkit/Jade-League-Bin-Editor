import { useState, useEffect, useRef } from 'react';
import './TitleBar.css';
import { CrystalBallIcon, PaletteIcon, PencilIcon, SettingsIcon, HelpIcon, MinimizeIcon, MaximizeIcon, RestoreIcon, CloseIcon, QuartzIcon, LibraryIcon, SaveIcon, UndoIcon, RedoIcon, ChevronDownIcon } from './Icons';
import type { EditorTab } from './TabBar';

interface TitleBarProps {
    appIcon?: string;
    isMaximized?: boolean;
    onThemes: () => void;
    onPreferences: () => void;
    onSettings: () => void;
    onAbout: () => void;
    onMinimize: () => void;
    onMaximize: () => void;
    onClose: () => void;
    onParticleEditor?: () => void;
    onMaterialLibrary?: () => void;
    onQuartzAction?: (mode: 'paint' | 'port' | 'bineditor' | 'vfxhub') => void;
    /** Click handler for the Jade icon at the far left. Wired up by the
     *  shell to surface the Welcome screen without closing open tabs. */
    onIconClick?: () => void;
    /** When set, the title bar swaps the "Jade - BIN Editor" label for the
     *  Word-style cluster: Save/Undo/Redo + a tabs dropdown showing the
     *  active document. The Word shell uses this to retire the tab strip. */
    wordMode?: boolean;
    tabs?: EditorTab[];
    activeTabId?: string | null;
    onTabSelect?: (tabId: string) => void;
    onTabClose?: (tabId: string) => void;
    onSave?: () => void;
    onUndo?: () => void;
    onRedo?: () => void;
}

export default function TitleBar({
    appIcon = '/media/jade.ico',
    isMaximized = false,
    onThemes,
    onPreferences,
    onSettings,
    onAbout,
    onMinimize,
    onMaximize,
    onClose,
    onParticleEditor,
    onMaterialLibrary,
    onQuartzAction,
    onIconClick,
    wordMode = false,
    tabs,
    activeTabId,
    onTabSelect,
    onTabClose,
    onSave,
    onUndo,
    onRedo,
}: TitleBarProps) {
    const [currentIcon, setCurrentIcon] = useState(appIcon);
    const [showQuartzMenu, setShowQuartzMenu] = useState(false);
    const [showTabsMenu, setShowTabsMenu] = useState(false);
    const quartzMenuRef = useRef<HTMLDivElement | null>(null);
    const tabsMenuRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        setCurrentIcon(appIcon);
    }, [appIcon]);

    useEffect(() => {
        const handleOutsideClick = (event: MouseEvent) => {
            const target = event.target as Node;
            if (quartzMenuRef.current && !quartzMenuRef.current.contains(target)) {
                setShowQuartzMenu(false);
            }
            if (tabsMenuRef.current && !tabsMenuRef.current.contains(target)) {
                setShowTabsMenu(false);
            }
        };

        window.addEventListener('mousedown', handleOutsideClick);
        return () => window.removeEventListener('mousedown', handleOutsideClick);
    }, []);

    const activeTab = tabs?.find(t => t.id === activeTabId) ?? null;
    const activeTabLabel = activeTab
        ? `${activeTab.fileName}${activeTab.isModified ? ' •' : ''}`
        : 'No document';

    return (
        <div className={`title-bar${wordMode ? ' title-bar-word' : ''}`} data-tauri-drag-region>
            <div className="title-bar-content">
                {/* Left: Icon + (Title | Word toolbar) */}
                <div className="title-section">
                    {onIconClick ? (
                        <button
                            type="button"
                            className="title-icon-btn"
                            onClick={onIconClick}
                            title="Main page"
                        >
                            <img src={currentIcon} alt="Jade" className="title-icon" />
                        </button>
                    ) : (
                        <img src={currentIcon} alt="Jade" className="title-icon" />
                    )}
                    {wordMode ? (
                        <div className="title-word-cluster">
                            <button
                                className="toolbar-btn"
                                title="Save"
                                onClick={onSave}
                                disabled={!onSave || !activeTab}
                            >
                                <SaveIcon size={14} />
                            </button>
                            <button
                                className="toolbar-btn"
                                title="Undo"
                                onClick={onUndo}
                                disabled={!onUndo || !activeTab}
                            >
                                <UndoIcon size={14} />
                            </button>
                            <button
                                className="toolbar-btn"
                                title="Redo"
                                onClick={onRedo}
                                disabled={!onRedo || !activeTab}
                            >
                                <RedoIcon size={14} />
                            </button>
                            <div className="title-word-tabs" ref={tabsMenuRef}>
                                <button
                                    className="title-word-tabs-btn"
                                    onClick={() => setShowTabsMenu(prev => !prev)}
                                    disabled={!tabs || tabs.length === 0}
                                    title={activeTab?.filePath ?? activeTabLabel}
                                >
                                    <span className="title-word-tabs-label">{activeTabLabel}</span>
                                    <ChevronDownIcon size={12} strokeWidth={1.8} />
                                </button>
                                {showTabsMenu && tabs && tabs.length > 0 && (
                                    <div className="title-word-tabs-popup">
                                        {tabs.map(t => (
                                            <div
                                                key={t.id}
                                                className={`title-word-tab-row${t.id === activeTabId ? ' active' : ''}`}
                                            >
                                                <button
                                                    className="title-word-tab-name"
                                                    title={t.filePath ?? t.fileName}
                                                    onClick={() => {
                                                        setShowTabsMenu(false);
                                                        onTabSelect?.(t.id);
                                                    }}
                                                >
                                                    <span className="title-word-tab-text">
                                                        {t.fileName}
                                                        {t.isModified && <span className="title-word-tab-dot"> •</span>}
                                                    </span>
                                                </button>
                                                <button
                                                    className="title-word-tab-close"
                                                    title="Close"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        onTabClose?.(t.id);
                                                    }}
                                                >
                                                    <CloseIcon size={11} strokeWidth={2} />
                                                </button>
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    ) : (
                        <span className="title-text">Jade - BIN Editor</span>
                    )}
                </div>

                {/* Center: Spacer */}
                <div className="title-spacer" data-tauri-drag-region />

                {/* Right: Toolbar */}
                <div className="title-toolbar">
                    {/* Editing Tools */}
                    <button
                        className="toolbar-btn"
                        title="Particle Editor (Full Window)"
                        onClick={() => onParticleEditor?.()}
                    >
                        <CrystalBallIcon size={16} />
                    </button>

                    <button
                        className="toolbar-btn"
                        title="Material Library"
                        onClick={() => onMaterialLibrary?.()}
                    >
                        <LibraryIcon size={16} />
                    </button>

                    <div className="toolbar-menu-wrap" ref={quartzMenuRef}>
                        <button
                            className="toolbar-btn"
                            title="Quartz Actions"
                            onClick={() => setShowQuartzMenu(prev => !prev)}
                        >
                            <QuartzIcon size={16} />
                        </button>
                        {showQuartzMenu && (
                            <div className="toolbar-menu-popup">
                                <button
                                    className="toolbar-menu-item"
                                    onClick={() => {
                                        setShowQuartzMenu(false);
                                        onQuartzAction?.('paint');
                                    }}
                                >
                                    Paint In Quartz
                                </button>
                                <button
                                    className="toolbar-menu-item"
                                    onClick={() => {
                                        setShowQuartzMenu(false);
                                        onQuartzAction?.('port');
                                    }}
                                >
                                    Port In Quartz
                                </button>
                                <button
                                    className="toolbar-menu-item"
                                    onClick={() => {
                                        setShowQuartzMenu(false);
                                        onQuartzAction?.('bineditor');
                                    }}
                                >
                                    Open In BinEditor
                                </button>
                                <button
                                    className="toolbar-menu-item"
                                    onClick={() => {
                                        setShowQuartzMenu(false);
                                        onQuartzAction?.('vfxhub');
                                    }}
                                >
                                    Open In VFXHub
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="toolbar-separator" />

                    {/* Settings */}
                    <button className="toolbar-btn" title="Themes" onClick={onThemes}>
                        <PaletteIcon size={16} />
                    </button>
                    <button className="toolbar-btn" title="Preferences" onClick={onPreferences}>
                        <PencilIcon size={16} />
                    </button>
                    <button className="toolbar-btn" title="Settings" onClick={onSettings}>
                        <SettingsIcon size={16} />
                    </button>
                    <button className="toolbar-btn" title="About Jade" onClick={onAbout}>
                        <HelpIcon size={16} />
                    </button>
                </div>

                {/* Window Controls */}
                <div className="window-controls">
                    <div className="controls-separator" />
                    <button className="control-btn minimize-btn" onClick={onMinimize}>
                        <MinimizeIcon size={14} />
                    </button>
                    <button className="control-btn maximize-btn" onClick={onMaximize}>
                        {isMaximized ? <RestoreIcon size={14} /> : <MaximizeIcon size={14} />}
                    </button>
                    <button className="control-btn close-btn" onClick={onClose}>
                        <CloseIcon size={14} />
                    </button>
                </div>
            </div>
        </div>
    );
}
