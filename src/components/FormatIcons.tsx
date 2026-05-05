/**
 * Format-specific file icons — Word-style "page silhouette + coloured
 * label bar" badges. Each registered extension gets its own colour and
 * 2-4 character label so a user can tell .bin from .tex from .png at a
 * glance in the welcome screen / file explorer. Folders and unknown
 * formats fall back to neutral outlines.
 *
 * The 3D-asset family + .bin use pictograms imported directly from
 * `lucide-react` so we get the canonical, up-to-date paths instead of
 * hand-transcribed `<path d="...">` strings (which is fragile to do by
 * recall and went badly during initial development — see git history).
 */

import {
    Bone,
    Box,
    Boxes,
    Clapperboard,
    FileText,
    type LucideIcon,
} from 'lucide-react';

/** Lookup table from glyph identifier → lucide-react component. Keep
 *  the keys in sync with the `glyph` union on `FormatConfig` below. */
const LUCIDE_GLYPHS: Record<'bone' | 'box' | 'boxes' | 'clapperboard' | 'file-text', LucideIcon> = {
    'bone': Bone,
    'box': Box,
    'boxes': Boxes,
    'clapperboard': Clapperboard,
    'file-text': FileText,
};

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
    /** Optional pictographic glyph rendered in place of the page +
     *  label badge. All glyph paths are pulled verbatim from Lucide
     *  (lucide.dev) so the line-weight + corner radius stay
     *  consistent with whatever else the app pulls from the same set.
     *  Drawn in `currentColor` so they sit alongside the existing
     *  outline icons cleanly without a clashing accent palette. */
    glyph?: 'bone' | 'box' | 'boxes' | 'clapperboard' | 'file-text';
}

const FORMAT_CONFIGS: Record<string, FormatConfig> = {
    // League BIN file — the app's primary format. Lucide `file-text`
    // glyph rather than the page+badge label since BIN files are by
    // far the most common entry in any list.
    bin: { label: 'BIN', color: 'currentColor', glyph: 'file-text' },
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

    // 3D asset family — rendered as pictograms instead of label badges
    // so the user can scan a folder of mesh-related files at a glance.
    // Drawn in currentColor (the row's text color) rather than a saturated
    // accent so they sit alongside the page-style icons cleanly.
    skl: { label: 'SKL', color: 'currentColor', glyph: 'bone' }, // skeleton (rig)
    skn: { label: 'SKN', color: 'currentColor', glyph: 'boxes'        }, // skinned mesh
    scb: { label: 'SCB', color: 'currentColor', glyph: 'box'          }, // static binary mesh
    sco: { label: 'SCO', color: 'currentColor', glyph: 'box'          }, // static text mesh
    anm: { label: 'ANM', color: 'currentColor', glyph: 'clapperboard' }, // animation

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

    // Pictographic variant — used by the 3D-asset family + .bin.
    // Each glyph is a `lucide-react` component, rendered at the same
    // size as the standard page icon so list rows stay aligned. We
    // pass `currentColor` through so the icon picks up whatever colour
    // the row text is using — no clashing accent palette.
    if (cfg.glyph) {
        const Glyph = LUCIDE_GLYPHS[cfg.glyph];
        return (
            <Glyph
                width={w}
                height={h}
                strokeWidth={1.8}
                className={className}
                aria-hidden="true"
            />
        );
    }

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

