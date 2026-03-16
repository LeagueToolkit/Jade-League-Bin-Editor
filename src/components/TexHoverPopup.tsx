import { useEffect, useRef } from 'react';
import './TexHoverPopup.css';

export interface TexHoverPopupProps {
  /** Pixel Y where the popup anchors (line top or bottom edge) */
  top: number;
  /** Pixel X for the popup (line start) */
  left: number;
  /** If true, popup opens above the line instead of below */
  above: boolean;
  /** Raw path string extracted from the editor */
  rawPath: string;
  /** Resolved absolute path, null while resolving */
  resolvedPath: string | null;
  /** PNG data URL from decoded .tex, null while loading */
  imageDataUrl: string | null;
  /** Decoded texture dimensions */
  texWidth: number;
  texHeight: number;
  /** Human-readable format name */
  formatName: string;
  /** Error message if loading failed */
  error: string | null;
  onOpenFull: () => void;
  onEditImage: () => void;
  /** Called when the mouse leaves the popup area */
  onDismiss: () => void;
  /** Called when the mouse enters the popup area (to cancel pending dismissal) */
  onMouseEnter?: () => void;
}

export default function TexHoverPopup({
  top, left, above,
  rawPath,
  resolvedPath,
  imageDataUrl,
  texWidth,
  texHeight,
  formatName,
  error,
  onOpenFull,
  onEditImage,
  onDismiss,
  onMouseEnter,
}: TexHoverPopupProps) {
  const popupRef = useRef<HTMLDivElement>(null);

  // Position: anchored below or above the line, clamped to viewport
  const POPUP_W = 260;
  const GAP = 4;
  const vw = window.innerWidth;

  let finalLeft = left;
  if (finalLeft + POPUP_W > vw - 8) finalLeft = vw - POPUP_W - 8;
  if (finalLeft < 8) finalLeft = 8;

  const style: React.CSSProperties = {
    left: finalLeft,
    ...(above
      ? { bottom: window.innerHeight - top + GAP }
      : { top: top + GAP }),
  };

  const fileName = rawPath.replace(/\\/g, '/').split('/').pop() || rawPath;

  // Draw decoded image onto canvas when imageDataUrl arrives
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!imageDataUrl || !canvasRef.current) return;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const img = new Image();
    img.onload = () => {
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);
    };
    img.src = imageDataUrl;
  }, [imageDataUrl]);

  return (
    <div
      ref={popupRef}
      className="tex-hover-popup"
      style={style}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onDismiss}
    >
      <div className="tex-hover-popup__header">
        <span className="tex-hover-popup__filename" title={resolvedPath || rawPath}>
          {fileName}
        </span>
      </div>

      <div className="tex-hover-popup__preview">
        {error ? (
          <div className="tex-hover-popup__error">
            <span className="tex-hover-popup__error-icon">⚠</span>
            <span>{error}</span>
          </div>
        ) : imageDataUrl ? (
          <canvas
            ref={canvasRef}
            className="tex-hover-popup__canvas"
            title={`${texWidth} × ${texHeight} · ${formatName}`}
          />
        ) : (
          <div className="tex-hover-popup__loading">
            <div className="tex-hover-popup__spinner" />
            <span>Loading texture…</span>
          </div>
        )}
      </div>

      {!error && imageDataUrl && (
        <div className="tex-hover-popup__meta">
          {texWidth} × {texHeight} · {formatName}
        </div>
      )}

      <div className="tex-hover-popup__actions">
        <button
          className="tex-hover-popup__btn tex-hover-popup__btn--primary"
          onClick={onOpenFull}
          disabled={!imageDataUrl && !error}
          title="Open full-size preview in a new tab"
        >
          Open Full
        </button>
        <button
          className="tex-hover-popup__btn tex-hover-popup__btn--secondary"
          onClick={onEditImage}
          disabled={!resolvedPath}
          title="Open in Paint.NET"
        >
          Edit Image
        </button>
      </div>
    </div>
  );
}
