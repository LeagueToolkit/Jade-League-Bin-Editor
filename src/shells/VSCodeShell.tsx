import TitleBar from '../components/TitleBar';
import MenuBar from '../components/MenuBar';
import TabBar from '../components/TabBar';
import StatusBar from '../components/StatusBar';
import { WelcomeScreenWithExit } from '../components/WelcomeScreen';
import EditorPane from './EditorPane';
import SharedDialogs from './SharedDialogs';
import { useShell } from './ShellContext';

/**
 * VSCode-style shell — title bar, menu bar, tab strip, Monaco editor,
 * status bar. Tools open as floating popovers anchored to the editor.
 */
export default function VSCodeShell() {
    const s = useShell();
    const welcomeVisible = s.welcomeOverride === 'force'
        || (s.welcomeOverride !== 'hide' && s.tabs.length === 0);

    return (
        <div className={`app-container ${s.isDragging ? 'dragging' : ''}`}>
            <TitleBar
                appIcon={s.appIcon}
                isMaximized={s.isMaximized}
                onThemes={s.onThemes}
                onPreferences={s.onPreferences}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMinimize={s.onMinimize}
                onMaximize={s.onMaximize}
                onClose={s.onClose}
                onParticleEditor={s.onParticleEditor}
                onMaterialLibrary={s.onMaterialLibrary}
                onQuartzAction={s.onSendToQuartz}
                onIconClick={() => s.setWelcomeOverride('force')}
            />

            <MenuBar
                findActive={s.findWidgetOpen}
                replaceActive={s.replaceWidgetOpen}
                generalEditActive={s.generalEditPanelOpen}
                particlePanelActive={s.particlePanelOpen}
                particleDisabled={!s.isBinFileOpen()}
                onNewFile={s.onNew}
                onOpenFile={s.onOpen}
                onSaveFile={s.onSave}
                onSaveFileAs={s.onSaveAs}
                onOpenLog={s.onOpenLog}
                onExit={s.onClose}
                onUndo={s.onUndo}
                onRedo={s.onRedo}
                onCut={s.onCut}
                onCopy={s.onCopy}
                onPaste={s.onPaste}
                onFind={s.onFind}
                onReplace={s.onReplace}
                onCompareFiles={s.onCompareFiles}
                onSelectAll={s.onSelectAll}
                onGeneralEdit={s.onGeneralEdit}
                onParticlePanel={s.onParticlePanel}
                onThemes={s.onThemes}
                onSettings={s.onSettings}
                onAbout={s.onAbout}
                onMaterialLibrary={s.onMaterialLibrary}
                recentFiles={s.recentFiles}
                onOpenRecentFile={s.openFileFromPath}
                openFileDisabled={s.openFileDisabled}
                onMainPage={() => s.setWelcomeOverride('force')}
            />

            {s.tabs.length > 0 && (
                <TabBar
                    tabs={s.tabs}
                    activeTabId={s.activeTabId}
                    onTabSelect={s.onTabSelect}
                    onTabClose={s.onTabClose}
                    onTabCloseAll={s.onTabCloseAll}
                    onTabPin={s.onTabPin}
                />
            )}

            <WelcomeScreenWithExit
                visible={welcomeVisible && !s.fileLoading}
                onOpenFile={s.onOpen}
                onContinueWithoutFile={() => s.setWelcomeOverride('hide')}
                openFileDisabled={s.openFileDisabled}
                recentFiles={s.recentFiles}
                onOpenRecentFile={s.openFileFromPath}
                onMaterialLibrary={s.onMaterialLibrary}
                onThemes={s.onThemes}
                onSettings={s.onSettings}
                appIcon={s.appIcon}
                onMinimize={s.onMinimize}
                onMaximize={s.onMaximize}
                onClose={s.onClose}
                isMaximized={s.isMaximized}
            />
            {welcomeVisible && s.fileLoading && <div className="file-loading-backdrop" />}

            {/* Wrapper takes flex:1 so the StatusBar stays pinned to the
                bottom even when EditorPane has no active tab to render
                (no welcome overlay, e.g. after "Continue without file"). */}
            <div className="vscode-editor-area">
                <EditorPane />
            </div>

            <StatusBar
                status={s.statusText}
                lineCount={s.lineCount}
                caretLine={s.caretPosition.line}
                caretColumn={s.caretPosition.column}
                ramUsage={s.appMemoryBytes > 0 ? `${(s.appMemoryBytes / (1024 * 1024)).toFixed(0)} MB` : ''}
            />

            <SharedDialogs />
        </div>
    );
}
