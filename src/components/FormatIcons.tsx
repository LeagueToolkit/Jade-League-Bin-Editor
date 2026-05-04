/**
 * Format-specific file icons — Word-style "page silhouette + coloured
 * label bar" badges. Each registered extension gets its own colour and
 * 2-4 character label so a user can tell .bin from .tex from .png at a
 * glance in the welcome screen / file explorer. Folders and unknown
 * formats fall back to neutral outlines.
 */

interface FormatIconProps {
    /** File extension without the leading dot, lowercased. */
    extension?: string;
    /** Set to true to render a folder icon instead of a file. */
    isFolder?: boolean;
    /** Pixel width — height auto-derives at the icon's natural aspect. */
    size?: number;
    className?: string;
}

interface FormatConfig {
    label: string;
    /** Bottom-bar fill colour. Light enough that white text reads on top. */
    color: string;
}

const FORMAT_CONFIGS: Record<string, FormatConfig> = {
    // League BIN file — the app's primary format.
    bin: { label: 'BIN', color: '#8B5CF6' },
    py:  { label: 'PY',  color: '#3776AB' },

    // Textures
    tex: { label: 'TEX', color: '#C678DD' },
    dds: { label: 'DDS', color: '#A45EE5' },

    // Images
    png:  { label: 'PNG',  color: '#98C379' },
    jpg:  { label: 'JPG',  color: '#98C379' },
    jpeg: { label: 'JPG',  color: '#98C379' },
    gif:  { label: 'GIF',  color: '#7FB55B' },
    webp: { label: 'WEBP', color: '#7FB55B' },

    // Text / markup
    md:   { label: 'MD',   color: '#61AFEF' },
    txt:  { label: 'TXT',  color: '#9DA5B4' },
    json: { label: 'JSON', color: '#E5C07B' },
    xml:  { label: 'XML',  color: '#E5A07B' },
    yml:  { label: 'YML',  color: '#E5A07B' },
    yaml: { label: 'YML',  color: '#E5A07B' },

    // Containers / archives the app surfaces
    wad:    { label: 'WAD', color: '#D19A66' },
    zip:    { label: 'ZIP', color: '#9DA5B4' },
    fantome: { label: 'FNT', color: '#D19A66' },

    // Office docs (rare in this app but match Word's palette so the
    // welcome list reads consistently when a user has opened one).
    docx: { label: 'W',   color: '#2B579A' },
    doc:  { label: 'W',   color: '#2B579A' },
    pdf:  { label: 'PDF', color: '#B30B00' },
};

const DEFAULT_CONFIG: FormatConfig = { label: '', color: '#7A8290' };

export function getFormatConfig(extension?: string): FormatConfig {
    if (!extension) return DEFAULT_CONFIG;
    return FORMAT_CONFIGS[extension.toLowerCase()] ?? DEFAULT_CONFIG;
}

/** Extract the extension (lowercase, no dot) from a file path or name.
 *  Returns '' for paths with no extension. */
export function extractExtension(filePath: string): string {
    const name = filePath.replace(/\\/g, '/').split('/').pop() ?? '';
    const idx = name.lastIndexOf('.');
    if (idx <= 0) return '';
    return name.slice(idx + 1).toLowerCase();
}

export function FormatIcon({ extension, isFolder, size = 28, className = '' }: FormatIconProps) {
    if (isFolder) {
        return (
            <svg
                width={size}
                height={Math.round(size * 0.85)}
                viewBox="0 0 24 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={className}
            >
                <path d="M2 4a1 1 0 0 1 1-1h6l2 2h10a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
            </svg>
        );
    }

    const cfg = getFormatConfig(extension);
    const w = size;
    const h = size;
    const labelLen = cfg.label.length;
    // Outlined page silhouette + a coloured-border badge that overhangs
    // both sides of the sheet, with white bold text inside — same look
    // as the user's reference PDF icon. The badge background is dark
    // (transparent) so the format colour reads as the *border*, not a
    // filled tile. Font size is consistent across short labels so MD,
    // BIN, PDF all look the same; longer labels (JSON / WEBP) shrink
    // just enough to still fit between the badge edges.
    const fontSize = labelLen >= 4 ? 6.5 : 8;
    return (
        <svg
            width={w}
            height={h}
            viewBox="0 0 24 24"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            {/* Page silhouette — outline only, no fill. Thinner stroke
                so the icon doesn't look bolded next to the file name. */}
            <path
                d="M5 3.5h10.5L19 7v13.5H5z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
            />
            {/* Folded corner — two strokes meeting at the corner. */}
            <path
                d="M15.5 3.5v3.5H19"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.1"
                strokeLinejoin="round"
            />
            {/* Format badge — filled with the editor background so it
                always blends with the page surface no matter what's
                drawn behind. Slightly narrower than the page edges and
                a thinner stroke for a cleaner, less-bolded look. */}
            {cfg.label && (
                <>
                    <rect
                        x="2"
                        y="9.5"
                        width="20"
                        height="9"
                        rx="1.4"
                        fill="var(--editor-bg, #1e1e1e)"
                        stroke={cfg.color}
                        strokeWidth="1.2"
                    />
                    <text
                        x="12"
                        y="14"
                        textAnchor="middle"
                        dominantBaseline="central"
                        fill="currentColor"
                        fontSize={fontSize}
                        fontWeight="700"
                        fontFamily="'Segoe UI', system-ui, sans-serif"
                        letterSpacing="0.6"
                    >
                        {cfg.label}
                    </text>
                </>
            )}
        </svg>
    );
}
