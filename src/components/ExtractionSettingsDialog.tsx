import React, { useState } from 'react';
import './SettingsDialog.css';

/** Mirrors the main SettingsDialog's chrome (sidebar + content panes) so
 *  Extraction settings have somewhere to grow. Only one section today —
 *  "General" — but the layout is built to slot more in (Performance,
 *  Output naming, etc.) without restructuring. */
interface ExtractionSettingsDialogProps {
    isOpen: boolean;
    onClose: () => void;
    useRenamePattern: boolean;
    onUseRenamePatternChange: (next: boolean) => void;
}

type NavSection = 'general';

const NAV_ITEMS: { id: NavSection; label: string; icon: React.ReactNode }[] = [
    {
        id: 'general',
        label: 'General',
        icon: (
            <svg
                width={15}
                height={15}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
            >
                <path d="M21 15a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
        ),
    },
];

const ExtractionSettingsDialog: React.FC<ExtractionSettingsDialogProps> = ({
    isOpen,
    onClose,
    useRenamePattern,
    onUseRenamePatternChange,
}) => {
    const [activeSection, setActiveSection] = useState<NavSection>('general');

    if (!isOpen) return null;

    const renderGeneral = () => (
        <>
            <h2 className="settings-section-title">Extraction</h2>
            <p className="settings-section-subtitle">
                How Jade writes extracted files to disk.
            </p>

            <ToggleRow
                label="Fast overwrite"
                description={
                    <>
                        Writes each chunk to a temp file (<code>.jdtmp</code>) then atomically
                        renames it over the target. Re-extracts into a populated folder finish in
                        roughly the same time as a fresh extract. Disable for a classic in-place
                        overwrite (slower on NTFS, but never leaves <code>.jdtmp</code> files
                        behind on cancel).
                    </>
                }
                checked={useRenamePattern}
                onChange={onUseRenamePatternChange}
            />
        </>
    );

    const sectionContent: Record<NavSection, () => React.ReactNode> = {
        general: renderGeneral,
    };

    return (
        <div className="settings-overlay" onClick={onClose}>
            <div
                className="settings-modal"
                onClick={e => e.stopPropagation()}
            >
                <div className="settings-header">
                    <div className="settings-header-left">
                        <h2>Extraction Settings</h2>
                        <p>Tweaks specific to the WAD extraction flow</p>
                    </div>
                    <button className="settings-close-btn" onClick={onClose}>&times;</button>
                </div>

                <div className="settings-body">
                    <nav className="settings-sidebar">
                        {NAV_ITEMS.map(item => (
                            <div
                                key={item.id}
                                className={`settings-nav-item${activeSection === item.id ? ' active' : ''}`}
                                onClick={() => setActiveSection(item.id)}
                            >
                                <span className="settings-nav-icon">{item.icon}</span>
                                {item.label}
                            </div>
                        ))}
                    </nav>

                    <div className="settings-content">
                        {sectionContent[activeSection]()}
                    </div>
                </div>

                <div className="settings-footer">
                    <button className="action-button gray" onClick={onClose}>Close</button>
                </div>
            </div>
        </div>
    );
};

/** Local copy of the same toggle component the main SettingsDialog uses
 *  — keeping it inline here so Extraction settings can ship without
 *  depending on the main dialog's internals. Uses the shared CSS classes. */
function ToggleRow({
    label, description, checked, disabled, onChange,
}: {
    label: string;
    description?: React.ReactNode;
    checked: boolean;
    disabled?: boolean;
    onChange: (v: boolean) => void;
}) {
    return (
        <div className="settings-row">
            <div className="settings-row-header">
                <span className="settings-row-title">{label}</span>
                <label className="settings-toggle">
                    <input
                        type="checkbox"
                        checked={checked}
                        disabled={disabled}
                        onChange={e => onChange(e.target.checked)}
                    />
                    <span className="settings-toggle-track" />
                </label>
            </div>
            {description && <p className="settings-row-desc">{description}</p>}
        </div>
    );
}

export default ExtractionSettingsDialog;
