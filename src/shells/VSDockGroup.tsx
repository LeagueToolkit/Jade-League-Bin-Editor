import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

interface VSDockGroupProps {
    /** Cardinal side this group is anchored to. Determines which
     *  dimension is the "outer" (resizable against the editor) and
     *  which is the "inner" (split between the two sub-panes). */
    side: 'right' | 'left' | 'top' | 'bottom';
    /** Initial outer pixel size — width for left/right, height for top/bottom. */
    defaultSize: number;
    /** Min outer size. */
    minSize?: number;
    /** Max outer size — defaults to half the viewport on the relevant axis. */
    maxSize?: number;
    /** Persistence key for the outer size in `localStorage`. */
    storageKey?: string;
    /** Persistence key for the split fraction (0–1). When two children
     *  are present the inner space is split by this ratio along the
     *  perpendicular axis. */
    splitStorageKey?: string;
    /** One or two children. Each child should be a `<VSDockPane fill>`. */
    children: ReactNode | [ReactNode, ReactNode];
}

/**
 * Hosts one or two `<VSDockPane fill>` elements docked to the same
 * side. The wrapper owns the **outer** resize handle (against the
 * editor) so the child panes don't fight over the same dimension.
 * When two children are present, an inner split divider stacks them
 * along the perpendicular axis with a stored fraction.
 *
 * For left/right docks the inner stacking is vertical (`column`); for
 * top/bottom docks it's horizontal (`row`).
 */
export default function VSDockGroup({
    side,
    defaultSize,
    minSize = 160,
    maxSize,
    storageKey,
    splitStorageKey,
    children,
}: VSDockGroupProps) {
    const horizontal = side === 'left' || side === 'right';
    const computedMax = maxSize ?? (horizontal ? Math.floor(window.innerWidth / 2) : Math.floor(window.innerHeight / 2));

    // ── Outer resize (same logic as the old VSDockPane). ──
    const [size, setSize] = useState<number>(() => {
        if (typeof window !== 'undefined' && storageKey) {
            const raw = window.localStorage.getItem(storageKey);
            const n = raw ? parseInt(raw, 10) : NaN;
            if (Number.isFinite(n) && n >= minSize && n <= computedMax) return n;
        }
        return defaultSize;
    });

    const draggingRef = useRef(false);
    const startPosRef = useRef(0);
    const startSizeRef = useRef(0);

    useEffect(() => {
        if (storageKey) {
            try { window.localStorage.setItem(storageKey, String(size)); } catch { /* quota / private mode */ }
        }
    }, [size, storageKey]);

    const onOuterPointerDown = useCallback((e: React.PointerEvent) => {
        draggingRef.current = true;
        startPosRef.current = horizontal ? e.clientX : e.clientY;
        startSizeRef.current = size;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
        document.body.style.userSelect = 'none';
    }, [horizontal, size]);

    const onOuterPointerMove = useCallback((e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        const cur = horizontal ? e.clientX : e.clientY;
        let delta = cur - startPosRef.current;
        if (side === 'right' || side === 'bottom') delta = -delta;
        const next = Math.max(minSize, Math.min(computedMax, startSizeRef.current + delta));
        setSize(next);
    }, [horizontal, side, minSize, computedMax]);

    const stopOuterDrag = useCallback((e: React.PointerEvent) => {
        if (!draggingRef.current) return;
        draggingRef.current = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);

    // ── Inner split (only when 2 children). ──
    const [splitFrac, setSplitFrac] = useState<number>(() => {
        if (typeof window !== 'undefined' && splitStorageKey) {
            const raw = window.localStorage.getItem(splitStorageKey);
            const n = raw ? parseFloat(raw) : NaN;
            if (Number.isFinite(n) && n > 0.05 && n < 0.95) return n;
        }
        return 0.5;
    });

    useEffect(() => {
        if (splitStorageKey) {
            try { window.localStorage.setItem(splitStorageKey, splitFrac.toFixed(4)); } catch { /* quota */ }
        }
    }, [splitFrac, splitStorageKey]);

    const innerRef = useRef<HTMLDivElement | null>(null);
    const splitDraggingRef = useRef(false);

    const onSplitPointerDown = useCallback((e: React.PointerEvent) => {
        splitDraggingRef.current = true;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
        document.body.style.userSelect = 'none';
    }, [horizontal]);

    const onSplitPointerMove = useCallback((e: React.PointerEvent) => {
        if (!splitDraggingRef.current) return;
        const el = innerRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        // Inner stacking axis is perpendicular to the side: vertical for
        // left/right docks (use clientY), horizontal for top/bottom (use clientX).
        const totalPx = horizontal ? rect.height : rect.width;
        if (totalPx <= 0) return;
        const localPx = horizontal ? (e.clientY - rect.top) : (e.clientX - rect.left);
        const next = Math.max(0.1, Math.min(0.9, localPx / totalPx));
        setSplitFrac(next);
    }, [horizontal]);

    const stopSplitDrag = useCallback((e: React.PointerEvent) => {
        if (!splitDraggingRef.current) return;
        splitDraggingRef.current = false;
        try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
    }, []);

    const childArray = Array.isArray(children) ? children : [children];
    const groupStyle: React.CSSProperties = horizontal
        ? { width: `${size}px` }
        : { height: `${size}px` };

    return (
        <div className={`vs-dock-group vs-dock-group-${side}`} style={groupStyle}>
            {/* Outer resize handle — same edge the old single VSDockPane used. */}
            {(side === 'right' || side === 'bottom') && (
                <div
                    className={`vs-dock-handle vs-dock-handle-${horizontal ? 'h' : 'v'}`}
                    onPointerDown={onOuterPointerDown}
                    onPointerMove={onOuterPointerMove}
                    onPointerUp={stopOuterDrag}
                    onPointerCancel={stopOuterDrag}
                />
            )}
            {(side === 'left') && (
                <div
                    className="vs-dock-handle vs-dock-handle-h vs-dock-handle-right"
                    onPointerDown={onOuterPointerDown}
                    onPointerMove={onOuterPointerMove}
                    onPointerUp={stopOuterDrag}
                    onPointerCancel={stopOuterDrag}
                />
            )}
            {(side === 'top') && (
                <div
                    className="vs-dock-handle vs-dock-handle-v vs-dock-handle-bottom"
                    onPointerDown={onOuterPointerDown}
                    onPointerMove={onOuterPointerMove}
                    onPointerUp={stopOuterDrag}
                    onPointerCancel={stopOuterDrag}
                />
            )}

            <div
                ref={innerRef}
                className={`vs-dock-group-inner${horizontal ? ' stack-vertical' : ' stack-horizontal'}`}
            >
                {childArray.length === 1 ? (
                    childArray[0]
                ) : (
                    <>
                        <div
                            className="vs-dock-group-slot"
                            style={horizontal
                                ? { flexBasis: `${splitFrac * 100}%` }
                                : { flexBasis: `${splitFrac * 100}%` }}
                        >
                            {childArray[0]}
                        </div>
                        <div
                            className={`vs-dock-split-handle vs-dock-split-handle-${horizontal ? 'v' : 'h'}`}
                            onPointerDown={onSplitPointerDown}
                            onPointerMove={onSplitPointerMove}
                            onPointerUp={stopSplitDrag}
                            onPointerCancel={stopSplitDrag}
                        />
                        <div
                            className="vs-dock-group-slot"
                            style={horizontal
                                ? { flexBasis: `${(1 - splitFrac) * 100}%` }
                                : { flexBasis: `${(1 - splitFrac) * 100}%` }}
                        >
                            {childArray[1]}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
