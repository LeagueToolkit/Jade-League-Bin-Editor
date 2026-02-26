// Theme application utilities
// Applies themes dynamically to the application

import { getTheme, getSyntaxColors, getBracketColors } from './themes';
import type { Monaco } from '@monaco-editor/react';

interface CustomThemeColors {
    windowBg: string;
    editorBg: string;
    titleBar: string;
    statusBar: string;
    text: string;
    tabBg: string;
    selectedTab: string;
}

/**
 * Lighten or darken a hex color
 */
function adjustColor(hex: string, amount: number): string {
    // Remove # if present
    hex = hex.replace('#', '');
    
    // Parse the color
    const num = parseInt(hex, 16);
    let r = (num >> 16) + amount;
    let g = ((num >> 8) & 0x00FF) + amount;
    let b = (num & 0x0000FF) + amount;
    
    // Clamp values
    r = Math.max(0, Math.min(255, r));
    g = Math.max(0, Math.min(255, g));
    b = Math.max(0, Math.min(255, b));
    
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

/**
 * Calculate scrollbar colors based on theme
 */
function calculateScrollbarColors(selectedTab: string, _editorBg: string): { thumb: string; thumbHover: string } {
    // Use selectedTab as the base for scrollbar thumb
    // Make hover state slightly lighter
    return {
        thumb: selectedTab,
        thumbHover: adjustColor(selectedTab, 30)
    };
}

/**
 * Apply a theme to the application by updating CSS custom properties
 */
export function applyTheme(themeId: string, customColors?: CustomThemeColors) {
    const root = document.documentElement;

    if (themeId === 'Custom' && customColors) {
        // Apply custom theme colors
        root.style.setProperty('--window-bg', customColors.windowBg);
        root.style.setProperty('--editor-bg', customColors.editorBg);
        root.style.setProperty('--title-bar-bg', customColors.titleBar);
        root.style.setProperty('--status-bar-bg', customColors.statusBar);
        root.style.setProperty('--text-color', customColors.text);
        root.style.setProperty('--tab-bg', customColors.tabBg);
        root.style.setProperty('--selected-tab-bg', customColors.selectedTab);

        // Calculate and apply scrollbar colors
        const scrollbarColors = calculateScrollbarColors(customColors.selectedTab, customColors.editorBg);
        root.style.setProperty('--scrollbar-thumb', scrollbarColors.thumb);
        root.style.setProperty('--scrollbar-thumb-hover', scrollbarColors.thumbHover);

        // Accent color: drives jade-accent, used everywhere for glows/highlights
        root.style.setProperty('--jade-accent', customColors.statusBar);

        // Update Monaco editor background
        updateMonacoBackground(customColors.editorBg);
    } else {
        // Apply built-in theme
        const theme = getTheme(themeId);
        if (theme) {
            root.style.setProperty('--window-bg', theme.windowBg);
            root.style.setProperty('--editor-bg', theme.editorBg);
            root.style.setProperty('--title-bar-bg', theme.titleBar);
            root.style.setProperty('--status-bar-bg', theme.statusBar);
            root.style.setProperty('--text-color', theme.text);
            root.style.setProperty('--tab-bg', theme.tabBg);
            root.style.setProperty('--selected-tab-bg', theme.selectedTab);

            // Calculate and apply scrollbar colors
            const scrollbarColors = calculateScrollbarColors(theme.selectedTab, theme.editorBg);
            root.style.setProperty('--scrollbar-thumb', scrollbarColors.thumb);
            root.style.setProperty('--scrollbar-thumb-hover', scrollbarColors.thumbHover);

            // Accent color: drives jade-accent, used everywhere for glows/highlights
            root.style.setProperty('--jade-accent', theme.statusBar);

            // Update Monaco editor background
            updateMonacoBackground(theme.editorBg);
        }
    }
}

/**
 * Update Monaco editor background color.
 * In modern UI mode we force transparent so the app-container gradient
 * shows through.  In classic mode we restore the solid color.
 *
 * Targets every element Monaco uses to paint its background:
 *   - .monaco-editor            outermost shell
 *   - .overflow-guard           clipping container
 *   - .monaco-editor-background the inner div Monaco fills with the theme bg
 *   - .margin                   gutter / line numbers
 *
 * NOTE: .minimap is intentionally excluded so it keeps its solid themed
 * background (set via Monaco theme token), ensuring minimap code pixels
 * render with correct contrast regardless of the app gradient beneath.
 */
function updateMonacoBackground(bgColor: string) {
    const isModern = document.documentElement.getAttribute('data-ui-mode') === 'modern';
    const bg = isModern ? 'transparent' : bgColor;

    const selectors = [
        '.monaco-editor',
        '.monaco-editor .overflow-guard',
        '.monaco-editor .monaco-editor-background',
        '.monaco-editor .margin',
    ];

    selectors.forEach((selector) => {
        document.querySelectorAll<HTMLElement>(selector).forEach((el) => {
            el.style.backgroundColor = bg;
        });
    });
}

/**
 * Apply rounded corners setting
 */
export function applyRoundedCorners(enabled: boolean) {
    const root = document.documentElement;
    root.style.setProperty('--border-radius', enabled ? '4px' : '0px');
}

/**
 * Apply/remove the Modern UI (Quartz-inspired glass morphism) mode.
 * Sets data-ui-mode="modern" on <html> when enabled, removes it when disabled.
 * Also refreshes Monaco's background immediately so transparency kicks in
 * without needing a full theme reload.
 */
export function applyModernUI(enabled: boolean) {
    const root = document.documentElement;
    if (enabled) {
        root.setAttribute('data-ui-mode', 'modern');
    } else {
        root.removeAttribute('data-ui-mode');
    }

    // Read the current editor bg from the CSS custom property and re-apply.
    // updateMonacoBackground checks data-ui-mode itself, so it will use
    // 'transparent' when modern is on and the solid color when it's off.
    const editorBg =
        root.style.getPropertyValue('--editor-bg') ||
        getComputedStyle(root).getPropertyValue('--editor-bg').trim() ||
        '#1E1E1E';
    updateMonacoBackground(editorBg);
}

/**
 * Create and register a Monaco editor theme from syntax colors
 */
export function createMonacoTheme(monaco: Monaco, themeId: string, syntaxThemeId: string) {
    const colors = getSyntaxColors(syntaxThemeId);
    const brackets = getBracketColors(syntaxThemeId);
    const theme = getTheme(themeId);

    const editorBg = theme?.editorBg || '#1E1E1E';
    const textColor = theme?.text || '#D4D4D4';

    // Always pass the real editorBg as editor.background — even in modern UI
    // mode.  Monaco uses this color internally to composite the minimap pixel
    // map (syntax token colors blended against editor.background).  Passing
    // #00000000 here causes minimap colors to be computed against
    // transparent-black, which produces wrong shades for every theme.
    //
    // Visual transparency in the main editor is achieved entirely through CSS
    // `background: transparent !important` rules and the JS inline-style
    // override in updateMonacoBackground — neither of which requires the
    // Monaco theme token to be transparent.
    monaco.editor.defineTheme('jade-dynamic', {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'comment', foreground: colors.comment.replace('#', '') },
            { token: 'string', foreground: colors.stringColor.replace('#', '') },
            { token: 'keyword', foreground: colors.keyword.replace('#', ''), fontStyle: 'bold' },
            { token: 'number', foreground: colors.number.replace('#', '') },
            { token: 'type', foreground: colors.propertyColor.replace('#', '') },
            { token: 'identifier', foreground: colors.propertyColor.replace('#', '') },
            { token: 'delimiter.bracket', foreground: brackets.color1.replace('#', '') },
            { token: 'delimiter.square', foreground: brackets.color2.replace('#', '') },
            { token: 'delimiter.parenthesis', foreground: brackets.color3.replace('#', '') },
        ],
        colors: {
            'editor.background': editorBg,
            'editor.foreground': textColor,
            'editorLineNumber.foreground': '#858585',
            'editor.selectionBackground': '#264F78',
            'editor.inactiveSelectionBackground': '#3A3D41',

            // Find/Replace Widget
            'editorWidget.background': theme?.editorBg || '#252526',
            'editorWidget.border': '#454545',
            'editorWidget.resizeBorder': '#454545',

            // Input fields in widgets
            'input.background': theme?.tabBg || '#3C3C3C',
            'input.foreground': textColor,
            'input.border': '#3C3C3C',

            // Buttons
            'button.background': '#0E639C',
            'button.foreground': '#FFFFFF',
            'button.hoverBackground': '#1177BB',

            // Bracket pair colorization (depth-based)
            'editorBracketHighlight.foreground1': brackets.color1,
            'editorBracketHighlight.foreground2': brackets.color2,
            'editorBracketHighlight.foreground3': brackets.color3,
            'editorBracketHighlight.foreground4': brackets.color1,
            'editorBracketHighlight.foreground5': brackets.color2,
            'editorBracketHighlight.foreground6': brackets.color3,
            'editorBracketHighlight.unexpectedBracket.foreground': '#FF0000',

            // Validation
            'inputValidation.infoBackground': '#063B49',
            'inputValidation.infoBorder': '#007ACC',
            'inputValidation.warningBackground': '#352A05',
            'inputValidation.warningBorder': '#B89500',
            'inputValidation.errorBackground': '#5A1D1D',
            'inputValidation.errorBorder': '#BE1100',

            // Minimap: always use the solid editor bg so its tiny code pixels
            // render with correct contrast (we don't make minimap transparent).
            'minimap.background': editorBg,
            'minimapSlider.background': adjustColor(editorBg, 20) + '66',
            'minimapSlider.hoverBackground': adjustColor(editorBg, 30) + '99',
            'minimapSlider.activeBackground': adjustColor(editorBg, 40) + 'BB',

            // Sticky scroll: explicitly pin to the solid editor bg so lines
            // remain readable when editor.background is #00000000 (transparent).
            'editorStickyScroll.background': editorBg,
            'editorStickyScrollHover.background': adjustColor(editorBg, 12),
            'editorStickyScrollBorder.background': adjustColor(editorBg, 20),
        }
    });

    return 'jade-dynamic';
}

/**
 * Apply the theme to the Monaco editor
 */
export function applyMonacoTheme(
    monaco: Monaco,
    themeId: string,
    syntaxThemeId: string
) {
    const themeName = createMonacoTheme(monaco, themeId, syntaxThemeId);
    monaco.editor.setTheme(themeName);

    // Monaco resets inline background styles during setTheme, so we
    // re-apply transparency on the next animation frame after Monaco settles.
    if (document.documentElement.getAttribute('data-ui-mode') === 'modern') {
        const editorBg =
            document.documentElement.style.getPropertyValue('--editor-bg') ||
            getComputedStyle(document.documentElement).getPropertyValue('--editor-bg').trim() ||
            '#1E1E1E';
        requestAnimationFrame(() => updateMonacoBackground(editorBg));
    }
}

/**
 * Load and apply saved theme from preferences
 */
export async function loadSavedTheme(
    invoke: (cmd: string, args?: any) => Promise<any>,
    monaco?: Monaco
) {
    try {
        const theme = await invoke('get_preference', { key: 'Theme', defaultValue: 'Default' }) as string;
        const useCustom = await invoke('get_preference', { key: 'UseCustomTheme', defaultValue: 'false' }) as string;
        const roundedCorners = await invoke('get_preference', { key: 'RoundedCorners', defaultValue: 'true' }) as string;
        const modernUI = await invoke('get_preference', { key: 'ModernUI', defaultValue: 'true' }) as string;
        const syntaxTheme = await invoke('get_preference', { key: 'SyntaxTheme', defaultValue: 'Default' }) as string;
        const overrideSyntax = await invoke('get_preference', { key: 'OverrideSyntax', defaultValue: 'false' }) as string;

        // Apply rounded corners (default to true/ON)
        applyRoundedCorners(roundedCorners === 'true');

        // Apply Modern UI mode (default to true/ON)
        applyModernUI(modernUI !== 'false');

        let activeThemeId = theme;

        if (useCustom === 'true') {
            // Load custom theme colors
            const customBg = await invoke('get_preference', { key: 'Custom_Bg', defaultValue: '#0F1928' }) as string;
            const customEditorBg = await invoke('get_preference', { key: 'Custom_EditorBg', defaultValue: '#141E2D' }) as string;
            const customTitleBar = await invoke('get_preference', { key: 'Custom_TitleBar', defaultValue: '#0F1928' }) as string;
            const customStatusBar = await invoke('get_preference', { key: 'Custom_StatusBar', defaultValue: '#005A9E' }) as string;
            const customText = await invoke('get_preference', { key: 'Custom_Text', defaultValue: '#D4D4D4' }) as string;
            const customTabBg = await invoke('get_preference', { key: 'Custom_TabBg', defaultValue: '#1E1E1E' }) as string;
            const customSelectedTab = await invoke('get_preference', { key: 'Custom_SelectedTab', defaultValue: '#007ACC' }) as string;

            activeThemeId = 'Custom';

            applyTheme('Custom', {
                windowBg: customBg,
                editorBg: customEditorBg,
                titleBar: customTitleBar,
                statusBar: customStatusBar,
                text: customText,
                tabBg: customTabBg,
                selectedTab: customSelectedTab
            });
        } else {
            applyTheme(theme);
        }

        // Apply Monaco theme if instance is available
        if (monaco) {
            // Determine syntax theme: if override is false, we might want to match UI theme
            // But for now, let's use the saved SyntaxTheme or fallback to UI theme if Default
            let activeSyntaxTheme = syntaxTheme;
            if (activeSyntaxTheme === 'Default') {
                activeSyntaxTheme = (activeThemeId === 'Custom') ? 'Dark Emptiness' : activeThemeId;
            }

            applyMonacoTheme(monaco, activeThemeId, activeSyntaxTheme);
        }

        return {
            theme,
            useCustom: useCustom === 'true',
            roundedCorners: roundedCorners === 'true',
            syntaxTheme,
            overrideSyntax: overrideSyntax === 'true'
        };
    } catch (error) {
        console.error('[Theme] Failed to load saved theme:', error);
        // Apply defaults
        applyTheme('Default');
        applyRoundedCorners(true); // Default to ON
        applyModernUI(true); // Default to ON

        if (monaco) {
            applyMonacoTheme(monaco, 'Default', 'Default');
        }

        return { theme: 'Default', useCustom: false, roundedCorners: true, modernUI: true };
    }
}
