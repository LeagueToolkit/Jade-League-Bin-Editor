import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import './AboutDialog.css';

const BUILTIN_ICONS = [
    { name: 'jade', path: '/media/jade.ico', label: 'Jade' },
    { name: 'jadejade', path: '/media/jadejade.ico', label: 'JadeJade' },
    { name: 'noBrain', path: '/media/noBrain.ico', label: 'No Brain' },
];

interface AboutDialogProps {
    isOpen: boolean;
    onClose: () => void;
}

export default function AboutDialog({ isOpen, onClose }: AboutDialogProps) {
    const [appIcon, setAppIcon] = useState<string>('/media/jade.ico');
    const [selectedBuiltin, setSelectedBuiltin] = useState<string | null>('jade');
    const [version, setVersion] = useState<string>('1.0.0');

    useEffect(() => {
        if (isOpen) {
            loadAppIcon();
            loadVersion();
        }
    }, [isOpen]);

    const loadAppIcon = async () => {
        try {
            // Check if a builtin icon is selected
            const builtinName = await invoke<string | null>('get_builtin_icon_name');
            setSelectedBuiltin(builtinName);

            if (builtinName) {
                // Using a builtin icon
                const icon = BUILTIN_ICONS.find(i => i.name === builtinName);
                if (icon) {
                    setAppIcon(icon.path);
                    return;
                }
            }

            // Check for custom icon
            const iconData = await invoke<string | null>('get_custom_icon_data');
            if (iconData) {
                setAppIcon(iconData);
            } else {
                setAppIcon('/media/jade.ico');
                setSelectedBuiltin('jade');
            }
        } catch (error) {
            console.error('Failed to load icon:', error);
        }
    };

    const loadVersion = async () => {
        try {
            const ver = await invoke<string>('get_app_version');
            setVersion(ver);
        } catch (error) {
            console.error('Failed to load version:', error);
        }
    };

    const handleBuiltinIconSelect = async (iconName: string) => {
        try {
            if (iconName === 'jade') {
                // Jade is the default — just clear any custom/builtin override
                await invoke('clear_custom_icon');
                setAppIcon('/media/jade.ico');
                setSelectedBuiltin('jade');
                window.dispatchEvent(new CustomEvent('icon-changed', { detail: null }));
            } else {
                await invoke('set_builtin_icon', { name: iconName });
                const icon = BUILTIN_ICONS.find(i => i.name === iconName);
                if (icon) {
                    setAppIcon(icon.path);
                }
                setSelectedBuiltin(iconName);
                // Get the icon as base64 for the title bar
                const iconData = await invoke<string | null>('get_custom_icon_data');
                window.dispatchEvent(new CustomEvent('icon-changed', { detail: iconData }));
            }
        } catch (error) {
            console.error('Failed to set builtin icon:', error);
        }
    };

    const handleCustomIconClick = async () => {
        try {
            const filePath = await open({
                filters: [{
                    name: 'Icon Files',
                    extensions: ['ico', 'png']
                }],
                multiple: false,
            });

            if (filePath) {
                await invoke('set_custom_icon', { iconPath: filePath });
                const iconData = await invoke<string | null>('get_custom_icon_data');
                if (iconData) {
                    setAppIcon(iconData);
                    setSelectedBuiltin(null);
                    window.dispatchEvent(new CustomEvent('icon-changed', { detail: iconData }));
                }
            }
        } catch (error) {
            console.error('Failed to change icon:', error);
        }
    };

    const handleClearIcon = async () => {
        try {
            await invoke('clear_custom_icon');
            setAppIcon('/media/jade.ico');
            setSelectedBuiltin('jade');
            window.dispatchEvent(new CustomEvent('icon-changed', { detail: null }));
        } catch (error) {
            console.error('Failed to clear icon:', error);
        }
    };

    const handleDocumentationClick = () => {
        invoke('open_url', { url: 'https://github.com/LeagueToolkit/Jade-League-Bin-Editor' });
    };

    const handleReportIssueClick = () => {
        invoke('open_url', { url: 'https://github.com/LeagueToolkit/Jade-League-Bin-Editor/issues/new' });
    };

    const handleDiscordClick = () => {
        invoke('open_url', { url: 'http://discordapp.com/users/464506365402939402' });
    };

    if (!isOpen) return null;

    return (
        <div className="about-overlay" onClick={onClose}>
            <div className="about-dialog" onClick={(e) => e.stopPropagation()}>
                {/* Title Bar */}
                <div className="about-title-bar" data-tauri-drag-region>
                    <div className="about-title-content">
                        <span className="about-title-text">About Jade</span>
                    </div>
                    <button className="about-close-btn" onClick={onClose}>✕</button>
                </div>

                {/* Content */}
                <div className="about-content">
                    {/* Left Column: App Info */}
                    <div className="about-column">
                        <div className="about-app-info">
                            <div className="about-icon-row">
                                {(() => {
                                    // Put the active icon in the center, others on the sides
                                    const activeBuiltin = selectedBuiltin ?? 'jade';
                                    const activeIdx = BUILTIN_ICONS.findIndex(i => i.name === activeBuiltin);
                                    const sideIcons = BUILTIN_ICONS.filter((_, i) => i !== activeIdx);

                                    return (
                                        <>
                                            {sideIcons[0] && (
                                                <button
                                                    className="about-icon-button about-icon-side"
                                                    onClick={() => handleBuiltinIconSelect(sideIcons[0].name)}
                                                    title={sideIcons[0].label}
                                                >
                                                    <img src={sideIcons[0].path} alt={sideIcons[0].label} className="about-app-icon" />
                                                </button>
                                            )}
                                            <div className="about-icon-wrapper">
                                                <button
                                                    className="about-icon-button active"
                                                    onClick={handleCustomIconClick}
                                                    title="Click to change application icon"
                                                >
                                                    <img src={appIcon} alt="Jade" className="about-app-icon" />
                                                    <div className="about-icon-edit-badge">✎</div>
                                                </button>
                                                {selectedBuiltin === null && (
                                                    <button
                                                        className="about-icon-clear-badge"
                                                        onClick={handleClearIcon}
                                                        title="Reset to default icon"
                                                    />
                                                )}
                                            </div>
                                            {sideIcons[1] && (
                                                <button
                                                    className="about-icon-button about-icon-side"
                                                    onClick={() => handleBuiltinIconSelect(sideIcons[1].name)}
                                                    title={sideIcons[1].label}
                                                >
                                                    <img src={sideIcons[1].path} alt={sideIcons[1].label} className="about-app-icon" />
                                                </button>
                                            )}
                                        </>
                                    );
                                })()}
                            </div>
                            <h1 className="about-app-name">Jade</h1>
                            <p className="about-app-subtitle">BIN Editor for League of Legends</p>
                        </div>

                        <div className="about-info-card">
                            <div className="about-info-label">Version</div>
                            <div className="about-info-value">{version}</div>
                        </div>

                        <div className="about-info-card">
                            <div className="about-info-label">Created by</div>
                            <div className="about-info-value">budlibu500</div>
                        </div>
                    </div>

                    {/* Middle Column: Support */}
                    <div className="about-column about-section-card">
                        <h2 className="about-section-title">Support</h2>
                        <p className="about-section-text">
                            Thank you to all the supporters who helped make this project possible!
                        </p>
                        <div className="about-section-label">Special Thanks</div>
                        <div className="about-supporters-list">
                            <div className="about-supporter highlighted">konradosj</div>
                            <div className="about-supporter highlighted">hellgoat2</div>
                        </div>
                    </div>

                    {/* Right Column: Project */}
                    <div className="about-column about-section-card">
                        <h2 className="about-section-title">Project</h2>
                        <button
                            className="about-doc-button"
                            onClick={handleDocumentationClick}
                        >
                            Documentation
                        </button>
                        <div className="about-section-label" style={{ marginTop: '14px' }}>Report an Issue</div>
                        <button
                            className="about-doc-button about-report-button"
                            onClick={handleReportIssueClick}
                        >
                            Open GitHub Issue
                        </button>
                        <button
                            className="about-doc-button about-discord-button"
                            onClick={handleDiscordClick}
                        >
                            DM me on Discord
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
