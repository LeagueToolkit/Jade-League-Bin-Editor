import { useEffect, useRef } from 'react';
import './JamesOverlay.css';

interface JamesOverlayProps {
    active: boolean;
}

/** Bake the wind-wisp pattern into an offscreen canvas once on mount.
 *  Drawing radial gradients to a stable bitmap means the GPU keeps the
 *  result as a cached texture and only needs to composite the
 *  CSS-driven translateX every frame — no per-frame rasterization of
 *  CSS gradients, no recomputation. Big win in James mode at high
 *  refresh rates. */
function paintWindCanvas(canvas: HTMLCanvasElement) {
    // 2:1 aspect — second half mirrors the first so the loop's -50%
    // translation lands the duplicates where the originals started.
    canvas.width = 2400;
    canvas.height = 1200;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    type Wisp = { x: number; y: number; rx: number; ry: number; rgb: string; alpha: number };
    const wisps: Wisp[] = [
        { x: 0.06, y: 0.30, rx: 0.11, ry: 0.14, rgb: '200,210,205', alpha: 0.22 },
        { x: 0.19, y: 0.55, rx: 0.14, ry: 0.12, rgb: '190,200,195', alpha: 0.20 },
        { x: 0.31, y: 0.38, rx: 0.12, ry: 0.18, rgb: '180,195,195', alpha: 0.24 },
        { x: 0.43, y: 0.62, rx: 0.15, ry: 0.14, rgb: '200,210,205', alpha: 0.20 },
    ];

    const drawWisp = (cx: number, cy: number, rx: number, ry: number, rgb: string, alpha: number) => {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.scale(rx, ry);
        const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
        grad.addColorStop(0, `rgba(${rgb}, ${alpha})`);
        grad.addColorStop(0.75, `rgba(${rgb}, 0)`);
        grad.addColorStop(1, `rgba(${rgb}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(-1, -1, 2, 2);
        ctx.restore();
    };

    // Draw each wisp twice — once in the first half, once mirrored
    // into the second half at +50% offset.
    for (const w of wisps) {
        const cx1 = w.x * canvas.width;
        const cx2 = (w.x + 0.5) * canvas.width;
        const cy = w.y * canvas.height;
        const rx = w.rx * canvas.width;
        const ry = w.ry * canvas.height;
        drawWisp(cx1, cy, rx, ry, w.rgb, w.alpha);
        drawWisp(cx2, cy, rx, ry, w.rgb, w.alpha);
    }
}

/**
 * "James Mode" — Silent Hill 2 opening-forest atmosphere overlay.
 * Foggy parallaxing trees behind a centred James-Sunderland silhouette,
 * with the editor + chrome washed back so the scene reads through.
 *
 * Toggle via the Themes dialog. Adds `.james-active` to `<html>` while
 * mounted so theme-aware overrides in JamesOverlay.css can knock back
 * the editor + chrome surfaces.
 */
export default function JamesOverlay({ active }: JamesOverlayProps) {
    const windCanvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        if (!active) return;
        document.documentElement.classList.add('james-active');
        return () => document.documentElement.classList.remove('james-active');
    }, [active]);

    useEffect(() => {
        if (!active || !windCanvasRef.current) return;
        paintWindCanvas(windCanvasRef.current);
    }, [active]);

    if (!active) return null;
    return (
        <div className="james-overlay" aria-hidden="true">
            <div className="james-bg" />
            <div className="james-trees-back" />
            <div className="james-trees-front" />
            <canvas ref={windCanvasRef} className="james-fog-wind-canvas" />
            <div className="james-fog" />
            <img
                className="james-figure"
                src="/media/james.png"
                alt=""
                draggable={false}
            />
            <div className="james-vignette" />
        </div>
    );
}
