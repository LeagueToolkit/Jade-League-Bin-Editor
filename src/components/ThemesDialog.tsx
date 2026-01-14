import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import {
    THEMES,
    SYNTAX_THEME_OPTIONS,
    getTheme,
    getSyntaxColors,
    getBracketColors,
    type ThemeColors
} from '../lib/themes';
import { applyTheme, applyRoundedCorners } from '../lib/themeApplicator';
import './ThemesDialog.css';

interface ThemesDialogProps {
    isOpen: boolean;
    onClose: () => void;
    onThemeApplied?: (themeId: string) => void;
}

interface CustomTheme {
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
}

export default function ThemesDialog({ isOpen, onClose, onThemeApplied }: ThemesDialogProps) {
    const [selectedTheme, setSelectedTheme] = useState('Default');
    const [selectedSyntaxTheme, setSelectedSyntaxTheme] = useState('Default');
    const [useCustomTheme, setUseCustomTheme] = useState(false);
    const [overrideSyntax, setOverrideSyntax] = useState(false);
    const [roundedCorners, setRoundedCorners] = useState(true); // Default to ON

    const [customTheme, setCustomTheme] = useState<CustomTheme>({
        windowBg: '#0F1928',
        editorBg: '#141E2D',
        titleBar: '#0F1928',
        statusBar: '#005A9E',
        text: '#D4D4D4',
        tabBg: '#1E1E1E',
        selectedTab: '#007ACC'
    });

    // Load preferences on mount
    useEffect(() => {
        if (isOpen) {
            loadPreferences();
        }
    }, [isOpen]);

    const loadPreferences = async () => {
        try {
            const theme = await invoke<string>('get_preference', { key: 'Theme', defaultValue: 'Default' });
            const syntaxTheme = await invoke<string>('get_preference', { key: 'SyntaxTheme', defaultValue: 'Default' });
            const override = await invoke<string>('get_preference', { key: 'OverrideSyntax', defaultValue: 'false' });
            const useCustom = await invoke<string>('get_preference', { key: 'UseCustomTheme', defaultValue: 'false' });
            const rounded = await invoke<string>('get_preference', { key: 'RoundedCorners', defaultValue: 'true' }); // Default to true

            setSelectedTheme(theme);
            setSelectedSyntaxTheme(syntaxTheme);
            setOverrideSyntax(override === 'true');
            setUseCustomTheme(useCustom === 'true');
            setRoundedCorners(rounded === 'true');

            // Load custom theme colors if using custom
            if (useCustom === 'true') {
                const customBg = await invoke<string>('get_preference', { key: 'Custom_Bg', defaultValue: '#0F1928' });
                const customEditorBg = await invoke<string>('get_preference', { key: 'Custom_EditorBg', defaultValue: '#141E2D' });
                const customTitleBar = await invoke<string>('get_preference', { key: 'Custom_TitleBar', defaultValue: '#0F1928' });
                const customStatusBar = await invoke<string>('get_preference', { key: 'Custom_StatusBar', defaultValue: '#005A9E' });
                const customText = await invoke<string>('get_preference', { key: 'Custom_Text', defaultValue: '#D4D4D4' });
                const customTabBg = await invoke<string>('get_preference', { key: 'Custom_TabBg', defaultValue: '#1E1E1E' });
                const customSelectedTab = await invoke<string>('get_preference', { key: 'Custom_SelectedTab', defaultValue: '#007ACC' });

                setCustomTheme({
                    windowBg: customBg,
                    editorBg: customEditorBg,
                    titleBar: customTitleBar,
                    statusBar: customStatusBar,
                    text: customText,
                    tabBg: customTabBg,
                    selectedTab: customSelectedTab
                });
            }
        } catch (error) {
            console.error('Failed to load theme preferences:', error);
        }
    };

    const handleApply = async () => {
        try {
            if (useCustomTheme) {
                // Save custom theme colors
                await invoke('set_preference', { key: 'Custom_Bg', value: customTheme.windowBg });
                await invoke('set_preference', { key: 'Custom_EditorBg', value: customTheme.editorBg });
                await invoke('set_preference', { key: 'Custom_TitleBar', value: customTheme.titleBar });
                await invoke('set_preference', { key: 'Custom_StatusBar', value: customTheme.statusBar });
                await invoke('set_preference', { key: 'Custom_Text', value: customTheme.text });
                await invoke('set_preference', { key: 'Custom_TabBg', value: customTheme.tabBg });
                await invoke('set_preference', { key: 'Custom_SelectedTab', value: customTheme.selectedTab });
                await invoke('set_preference', { key: 'UseCustomTheme', value: 'true' });
                await invoke('set_preference', { key: 'Theme', value: 'Custom' });

                // Apply custom theme immediately
                applyTheme('Custom', customTheme);
            } else {
                await invoke('set_preference', { key: 'Theme', value: selectedTheme });
                await invoke('set_preference', { key: 'UseCustomTheme', value: 'false' });

                // Apply selected theme immediately
                applyTheme(selectedTheme);
            }

            await invoke('set_preference', { key: 'SyntaxTheme', value: selectedSyntaxTheme });
            await invoke('set_preference', { key: 'OverrideSyntax', value: overrideSyntax.toString() });
            await invoke('set_preference', { key: 'RoundedCorners', value: roundedCorners.toString() });

            // Apply rounded corners immediately
            applyRoundedCorners(roundedCorners);

            onThemeApplied?.(useCustomTheme ? 'Custom' : selectedTheme);
            alert('Theme applied successfully!');
        } catch (error) {
            console.error('Failed to save theme preferences:', error);
            alert('Failed to apply theme. Please try again.');
        }
    };

    const handleThemeSelect = (themeId: string) => {
        setSelectedTheme(themeId);
        if (!overrideSyntax) {
            setSelectedSyntaxTheme(themeId);
        }
    };

    const handleCustomThemeToggle = (checked: boolean) => {
        setUseCustomTheme(checked);

        // If enabling custom theme and colors are default, populate from selected theme
        if (checked && customTheme.windowBg === '#0F1928') {
            const theme = getTheme(selectedTheme);
            if (theme) {
                setCustomTheme({
                    windowBg: theme.windowBg,
                    editorBg: theme.editorBg,
                    titleBar: theme.titleBar,
                    statusBar: theme.statusBar,
                    text: theme.text,
                    tabBg: theme.tabBg,
                    selectedTab: theme.selectedTab
                });
            }
        }
    };

    const getCurrentDisplayTheme = (): ThemeColors | CustomTheme => {
        if (useCustomTheme) {
            return customTheme;
        }
        return getTheme(selectedTheme) || THEMES[0];
    };

    const currentTheme = getCurrentDisplayTheme();
    const currentSyntax = getSyntaxColors(selectedSyntaxTheme);
    const currentBrackets = getBracketColors(selectedSyntaxTheme);

    if (!isOpen) return null;

    return (
        <div className="themes-dialog-overlay" onClick={onClose}>
            <div className="themes-dialog" onClick={(e) => e.stopPropagation()}>
                <div className="themes-dialog-header">
                    <h2>Jade Themes</h2>
                    <button className="close-button" onClick={onClose}>×</button>
                </div>

                <div className="themes-dialog-content">
                    <div className="themes-main-section">
                        <h3>Themes</h3>
                        <p className="current-theme">
                            Current Theme: {useCustomTheme ? 'Custom Theme' : (getTheme(selectedTheme)?.displayName || 'Unknown')}
                        </p>

                        <div className="themes-columns">
                            {/* UI Theme Section */}
                            <div className="theme-column">
                                <div className="section-header">
                                    <h4>UI Theme</h4>
                                    <label className="checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={useCustomTheme}
                                            onChange={(e) => handleCustomThemeToggle(e.target.checked)}
                                        />
                                        Use Custom Theme
                                    </label>
                                </div>

                                {!useCustomTheme ? (
                                    <div className="theme-list">
                                        {THEMES.map((theme) => (
                                            <div
                                                key={theme.id}
                                                className={`theme-item ${selectedTheme === theme.id ? 'selected' : ''}`}
                                                onClick={() => handleThemeSelect(theme.id)}
                                            >
                                                <span>{theme.displayName}</span>
                                                <div className="theme-preview-dots">
                                                    <div className="preview-dot" style={{ backgroundColor: theme.windowBg }} />
                                                    <div className="preview-dot" style={{ backgroundColor: theme.statusBar }} />
                                                </div>
                                            </div>
                                        ))}
                                    </div>
                                ) : (
                                    <div className="custom-theme-editor">
                                        <div className="color-input-group">
                                            <label>Window Background</label>
                                            <input
                                                type="color"
                                                value={customTheme.windowBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, windowBg: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.windowBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, windowBg: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Editor Background</label>
                                            <input
                                                type="color"
                                                value={customTheme.editorBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, editorBg: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.editorBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, editorBg: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Title Bar</label>
                                            <input
                                                type="color"
                                                value={customTheme.titleBar}
                                                onChange={(e) => setCustomTheme({ ...customTheme, titleBar: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.titleBar}
                                                onChange={(e) => setCustomTheme({ ...customTheme, titleBar: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Status Bar</label>
                                            <input
                                                type="color"
                                                value={customTheme.statusBar}
                                                onChange={(e) => setCustomTheme({ ...customTheme, statusBar: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.statusBar}
                                                onChange={(e) => setCustomTheme({ ...customTheme, statusBar: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Foreground Text</label>
                                            <input
                                                type="color"
                                                value={customTheme.text}
                                                onChange={(e) => setCustomTheme({ ...customTheme, text: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.text}
                                                onChange={(e) => setCustomTheme({ ...customTheme, text: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Tab Background</label>
                                            <input
                                                type="color"
                                                value={customTheme.tabBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, tabBg: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.tabBg}
                                                onChange={(e) => setCustomTheme({ ...customTheme, tabBg: e.target.value })}
                                            />
                                        </div>
                                        <div className="color-input-group">
                                            <label>Selected Tab</label>
                                            <input
                                                type="color"
                                                value={customTheme.selectedTab}
                                                onChange={(e) => setCustomTheme({ ...customTheme, selectedTab: e.target.value })}
                                            />
                                            <input
                                                type="text"
                                                value={customTheme.selectedTab}
                                                onChange={(e) => setCustomTheme({ ...customTheme, selectedTab: e.target.value })}
                                            />
                                        </div>
                                    </div>
                                )}
                            </div>

                            {/* Syntax Coloring Section */}
                            <div className="theme-column">
                                <div className="section-header">
                                    <h4>Syntax Coloring</h4>
                                    <label className="checkbox-label">
                                        <input
                                            type="checkbox"
                                            checked={overrideSyntax}
                                            onChange={(e) => setOverrideSyntax(e.target.checked)}
                                        />
                                        Override Theme Highlighting
                                    </label>
                                </div>

                                <div className="theme-list">
                                    {SYNTAX_THEME_OPTIONS.map((theme) => (
                                        <div
                                            key={theme.id}
                                            className={`theme-item ${selectedSyntaxTheme === theme.id ? 'selected' : ''}`}
                                            onClick={() => setSelectedSyntaxTheme(theme.id)}
                                        >
                                            <span>{theme.displayName}</span>
                                            <div className="theme-preview-dots">
                                                <div className="preview-dot" style={{ backgroundColor: getBracketColors(theme.id).color1 }} />
                                                <div className="preview-dot" style={{ backgroundColor: getBracketColors(theme.id).color2 }} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>

                            {/* Live Preview Section */}
                            <div className="theme-column preview-column">
                                <h4>Live Preview</h4>

                                <div className="color-palette">
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.windowBg }} />
                                        <span>Window Background</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.editorBg }} />
                                        <span>Editor Background</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.titleBar }} />
                                        <span>Title Bar</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.statusBar }} />
                                        <span>Status Bar</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.text }} />
                                        <span>Foreground Text</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.tabBg }} />
                                        <span>Tab Background</span>
                                    </div>
                                    <div className="palette-item">
                                        <div className="palette-color" style={{ backgroundColor: currentTheme.selectedTab }} />
                                        <span>Selected Tab</span>
                                    </div>
                                </div>

                                <h5>Syntax Preview</h5>
                                <div className="syntax-preview" style={{ backgroundColor: currentTheme.editorBg, color: currentTheme.text }}>
                                    <pre>
                                        <code>
                                            <span style={{ color: currentBrackets.color1 }}>{'{'}</span>{'\n'}
                                            {'  '}<span style={{ color: currentSyntax.comment }}># This is a comment</span>{'\n'}
                                            {'  '}<span style={{ color: currentSyntax.propertyColor }}>skinScale</span> : <span style={{ color: currentSyntax.keyword }}>f32</span> = <span style={{ color: currentSyntax.number }}>1.0</span>{'\n'}
                                            {'  '}<span style={{ color: currentSyntax.propertyColor }}>name</span> : <span style={{ color: currentSyntax.keyword }}>string</span> = <span style={{ color: currentSyntax.stringColor }}>"Example"</span>{'\n'}
                                            {'  '}<span style={{ color: currentBrackets.color2 }}>{'['}</span>{'\n'}
                                            {'    '}<span style={{ color: currentSyntax.number }}>i32</span> <span style={{ color: currentBrackets.color3 }}>(</span> <span style={{ color: currentSyntax.stringColor }}>"value"</span> <span style={{ color: currentBrackets.color3 }}>)</span>{'\n'}
                                            {'  '}<span style={{ color: currentBrackets.color2 }}>{']'}</span>{'\n'}
                                            <span style={{ color: currentBrackets.color1 }}>{'}'}</span>
                                        </code>
                                    </pre>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="themes-options">
                        <label className="checkbox-label">
                            <input
                                type="checkbox"
                                checked={roundedCorners}
                                onChange={(e) => setRoundedCorners(e.target.checked)}
                            />
                            Rounded Corners
                        </label>
                    </div>
                </div>

                <div className="themes-dialog-footer">
                    <button className="btn-apply" onClick={handleApply}>Apply</button>
                    <button className="btn-close" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
}
