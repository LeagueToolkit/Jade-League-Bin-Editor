import type { DockSide } from './useToolLayout';

export type DropTarget = { kind: 'dock'; side: DockSide };

interface DockGuidesProps {
    /** Bounding box (in viewport coordinates) of the area that hosts the
     *  guides — usually the `.vs-shell-body`. The outer guides are drawn
     *  centered against each edge of this rect; the center cluster is in
     *  the middle. */
    container: { left: number; top: number; right: number; bottom: number } | null;
    /** Cursor position during the drag, or null when not over the area. */
    cursor: { x: number; y: number } | null;
    /** True while a drag is in flight; the overlay is invisible otherwise. */
    visible: boolean;
}

const GUIDE_SIZE = 44;
const GUIDE_HIT_PAD = 6;
const CENTER_GAP = 2;

interface Guide {
    side: DockSide;
    cx: number;
    cy: number;
    icon: 'left' | 'right' | 'top' | 'bottom' | 'center';
    /** Visual category — controls only styling, not the drop target.
     *  `outer` = workspace-edge-style square,
     *  `mid`   = outer-lane shortcut inside the cluster,
     *  `inner` = inner-lane arrow inside the cluster,
     *  `center` = the bullseye square. */
    role: 'outer' | 'mid' | 'inner' | 'center';
}

/**
 * Build every guide widget the user can target during a drag. Outer
 * guides sit at the midpoint of each edge of the container; an inner
 * cross of five squares lives at the center of the editor for quick
 * docks (left / right / top / bottom + a pure-center "tab into editor"
 * target — currently maps to the same destination as the bottom dock,
 * placeholder until split-pane lands).
 */
function buildGuides(rect: { left: number; top: number; right: number; bottom: number }): Guide[] {
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const edgeOffset = 12;
    // Two concentric rings inside the cluster. The inner ring sits
    // closer to center and targets the inner lane (between outer dock
    // and the editor). The mid ring is further out and targets the
    // outer lane (workspace edge).
    const innerOffset = GUIDE_SIZE + CENTER_GAP;             // close to center → inner lane
    const midOffset   = (GUIDE_SIZE * 2) + (CENTER_GAP * 2); // further out → outer lane

    return [
        // Workspace-edge guides — same outer-lane target as the cluster's
        // mid ring, but anchored at the body edges so the user can also
        // throw a tool there with a quick wide gesture.
        { side: 'outer-left',   role: 'outer', cx: rect.left + edgeOffset + GUIDE_SIZE / 2,    cy,                                                  icon: 'left' },
        { side: 'outer-right',  role: 'outer', cx: rect.right - edgeOffset - GUIDE_SIZE / 2,   cy,                                                  icon: 'right' },
        { side: 'outer-top',    role: 'outer', cx,                                              cy: rect.top + edgeOffset + GUIDE_SIZE / 2,         icon: 'top' },
        { side: 'outer-bottom', role: 'outer', cx,                                              cy: rect.bottom - edgeOffset - GUIDE_SIZE / 2,      icon: 'bottom' },

        // Cluster MID ring — same purpose as the workspace-edge guides
        // (drops into the outer lane). Easier to reach when the user is
        // already hovering the editor center.
        { side: 'outer-left',   role: 'mid', cx: cx - midOffset, cy,                  icon: 'left' },
        { side: 'outer-right',  role: 'mid', cx: cx + midOffset, cy,                  icon: 'right' },
        { side: 'outer-top',    role: 'mid', cx,                 cy: cy - midOffset,  icon: 'top' },
        { side: 'outer-bottom', role: 'mid', cx,                 cy: cy + midOffset,  icon: 'bottom' },

        // Cluster INNER ring — inner-lane targets (between outer dock
        // and the editor).
        { side: 'inner-left',   role: 'inner', cx: cx - innerOffset, cy,                  icon: 'left' },
        { side: 'inner-right',  role: 'inner', cx: cx + innerOffset, cy,                  icon: 'right' },
        { side: 'inner-top',    role: 'inner', cx,                   cy: cy - innerOffset, icon: 'top' },
        { side: 'inner-bottom', role: 'inner', cx,                   cy: cy + innerOffset, icon: 'bottom' },

        // Bullseye — placeholder for "tab into editor"; folds back into
        // inner-bottom until split panes ship.
        { side: 'inner-bottom', role: 'center', cx, cy, icon: 'center' },
    ];
}

/**
 * Hit test a cursor position against the guide widgets and return the
 * matching drop target, or null when the cursor is over the editor area
 * (which means "let go to float").
 */
export function hitTestGuides(
    cursor: { x: number; y: number },
    rect: { left: number; top: number; right: number; bottom: number },
): DropTarget | null {
    const guides = buildGuides(rect);
    const half = GUIDE_SIZE / 2 + GUIDE_HIT_PAD;
    for (const g of guides) {
        if (Math.abs(cursor.x - g.cx) <= half && Math.abs(cursor.y - g.cy) <= half) {
            return { kind: 'dock', side: g.side };
        }
    }
    return null;
}

function previewRect(
    side: DockSide,
    rect: { left: number; top: number; right: number; bottom: number },
) {
    const w = rect.right - rect.left;
    const h = rect.bottom - rect.top;
    const outerSideW = Math.min(360, Math.max(220, w * 0.20));
    const innerSideW = Math.min(360, Math.max(180, w * 0.18));
    const outerBandH = Math.min(280, Math.max(140, h * 0.24));
    const innerBandH = Math.min(280, Math.max(120, h * 0.22));

    switch (side) {
        case 'outer-left':   return { left: rect.left,                              top: rect.top,                              width: outerSideW, height: h };
        case 'inner-left':   return { left: rect.left + outerSideW,                 top: rect.top,                              width: innerSideW, height: h };
        case 'outer-right':  return { left: rect.right - outerSideW,                top: rect.top,                              width: outerSideW, height: h };
        case 'inner-right':  return { left: rect.right - outerSideW - innerSideW,   top: rect.top,                              width: innerSideW, height: h };
        case 'outer-top':    return { left: rect.left,                              top: rect.top,                              width: w,          height: outerBandH };
        case 'inner-top':    return { left: rect.left,                              top: rect.top + outerBandH,                 width: w,          height: innerBandH };
        case 'outer-bottom': return { left: rect.left,                              top: rect.bottom - outerBandH,              width: w,          height: outerBandH };
        case 'inner-bottom': return { left: rect.left,                              top: rect.bottom - outerBandH - innerBandH, width: w,          height: innerBandH };
    }
}

/**
 * Pane-preview icon for each guide. Both lanes on the same side share
 * the same base panel preview — that way the user reads "this is the
 * X-side dock target" from a glance. The outer-lane (mid) variant
 * adds a small chevron pointing further toward the workspace edge,
 * marking it as the *farther-out* of the two same-side guides.
 *
 * Stroke uses `currentColor` so the parent guide controls idle vs
 * active. The accent fill uses `--jade-accent` so themes recolor it.
 *
 * Hand-drawn from `<rect>` and `<polyline>` primitives — no
 * third-party icon path data.
 */
function GuideIcon({
    icon,
    lane,
}: {
    icon: 'left' | 'right' | 'top' | 'bottom' | 'center';
    /** 'edge'   = workspace-edge or outer-lane cluster guide (gets a
     *             chevron arrow pointing further out),
     *  'inner'  = inner-lane cluster guide (no chevron),
     *  'center' = bullseye. */
    lane: 'edge' | 'inner' | 'center';
}) {
    const accent = 'var(--jade-accent, #007acc)';
    // Workspace fills almost the full icon, leaving 0.6px on each side
    // for the outline stroke. Both lanes share the same base; the
    // edge lane additionally draws a bigger directional triangle in
    // the empty half of the workspace.
    const wsX = 0.6, wsY = 0.6, wsW = 14.8, wsH = 14.8;
    return (
        <svg width="30" height="30" viewBox="0 0 16 16" aria-hidden="true" className="vs-guide-glyph">
            {/* Workspace outline. */}
            <rect x={wsX} y={wsY} width={wsW} height={wsH} rx="1.2" fill="none" stroke="currentColor" strokeWidth="1" />

            {/* Filled panel — same shape for inner and outer lanes
                so the two same-side guides share an immediate visual
                identity. */}
            {icon !== 'center' && (() => {
                const inset = 0.6;
                const stripT = 4.2;
                if (icon === 'left')   return <rect x={wsX + inset}                  y={wsY + inset}                  width={stripT}        height={wsH - inset * 2} rx="0.5" fill={accent} />;
                if (icon === 'right')  return <rect x={wsX + wsW - inset - stripT}   y={wsY + inset}                  width={stripT}        height={wsH - inset * 2} rx="0.5" fill={accent} />;
                if (icon === 'top')    return <rect x={wsX + inset}                  y={wsY + inset}                  width={wsW - inset * 2} height={stripT}         rx="0.5" fill={accent} />;
                if (icon === 'bottom') return <rect x={wsX + inset}                  y={wsY + wsH - inset - stripT}   width={wsW - inset * 2} height={stripT}         rx="0.5" fill={accent} />;
                return null;
            })()}

            {/* Outer-lane directional triangle — sits in the empty
                half of the workspace and points toward the dock
                direction. Sized to be a clear "play button" hint. */}
            {lane === 'edge' && (() => {
                if (icon === 'left')   return <polygon points="11,3.5 11,12.5 6.5,8" fill={accent} />;
                if (icon === 'right')  return <polygon points="5,3.5 5,12.5 9.5,8" fill={accent} />;
                if (icon === 'top')    return <polygon points="3.5,11 12.5,11 8,6.5" fill={accent} />;
                if (icon === 'bottom') return <polygon points="3.5,5 12.5,5 8,9.5" fill={accent} />;
                return null;
            })()}

            {/* Bullseye. */}
            {lane === 'center' && <rect x="4.5" y="4.5" width="7" height="7" rx="0.6" fill={accent} />}
        </svg>
    );
}

/**
 * A single backdrop drawn behind the cluster guides (mid + inner ring
 * + center). Shape = the union of a plus (the cross arms) and a
 * diamond rotated 45° at the center, so the inner corners between
 * arms get diagonal cut-outs instead of sharp inward notches. Reads
 * as one VS-style docking widget instead of nine floating boxes.
 */
function ClusterBackdrop({ cx, cy }: { cx: number; cy: number }) {
    // Arm half-width — kept tight so the cross reads as slim arms
    // rather than a chubby plus. Just enough to wrap a guide square
    // plus a hair of breathing room.
    const armW = GUIDE_SIZE / 2 + 4;
    // Arm half-length — matches the midOffset in `buildGuides()` so
    // the mid-ring guides sit at the very tip of each arm with just
    // enough overhang for the cross outline.
    const midOffset = (GUIDE_SIZE * 2) + (CENTER_GAP * 2);
    const armL = midOffset + GUIDE_SIZE / 2 + 4;
    // Diagonal cut depth — the diamond pokes out by this many pixels
    // beyond the plus's inner corners.
    const D = 12;

    // 16-vertex polygon: plus arms with diagonally chamfered inner
    // corners. Going clockwise from the top arm's top-left.
    const pts = [
        [-armW, -armL], [armW, -armL],
        [armW, -armW - D], [armW + D, -armW],
        [armL, -armW], [armL, armW],
        [armW + D, armW], [armW, armW + D],
        [armW, armL], [-armW, armL],
        [-armW, armW + D], [-armW - D, armW],
        [-armL, armW], [-armL, -armW],
        [-armW - D, -armW], [-armW, -armW - D],
    ].map(p => p.join(',')).join(' ');

    const half = armL + D + 4; // padding so the stroke isn't clipped
    return (
        <svg
            className="vs-guide-cross-bg"
            aria-hidden="true"
            style={{
                position: 'absolute',
                left: cx - half,
                top: cy - half,
                width: half * 2,
                height: half * 2,
                pointerEvents: 'none',
            }}
            viewBox={`${-half} ${-half} ${half * 2} ${half * 2}`}
        >
            <polygon points={pts} />
        </svg>
    );
}

export default function DockGuides({ container, cursor, visible }: DockGuidesProps) {
    if (!visible || !container) return null;
    const guides = buildGuides(container);
    const active = cursor ? hitTestGuides(cursor, container) : null;
    const preview = active ? previewRect(active.side, container) : null;
    const cx = (container.left + container.right) / 2;
    const cy = (container.top + container.bottom) / 2;

    return (
        <div className="vs-dock-guides" aria-hidden>
            <ClusterBackdrop cx={cx} cy={cy} />
            {guides.map((g, i) => {
                const isActive = active?.side === g.side;
                // Lane drives the glyph shape (outer/edge vs inner) so
                // adjacent same-direction guides don't share an icon.
                const lane: 'edge' | 'inner' | 'center' =
                    g.role === 'center' ? 'center'
                    : g.role === 'inner' ? 'inner'
                    : 'edge';
                return (
                    <div
                        key={i}
                        className={`vs-guide vs-guide-${g.icon} vs-guide-${g.role}${isActive ? ' active' : ''}`}
                        style={{
                            left: g.cx - GUIDE_SIZE / 2,
                            top: g.cy - GUIDE_SIZE / 2,
                            width: GUIDE_SIZE,
                            height: GUIDE_SIZE,
                        }}
                    >
                        <GuideIcon icon={g.icon} lane={lane} />
                    </div>
                );
            })}
            {preview && (
                <div
                    className="vs-guide-preview"
                    style={preview}
                />
            )}
        </div>
    );
}
