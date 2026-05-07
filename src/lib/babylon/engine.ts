/**
 * Tiny Babylon `Engine` factory.
 *
 * Originally tried a singleton-engine + many-views pattern, but Babylon's
 * multi-view extension (`engine.registerView`) needs a side-effect import
 * to graft itself onto the prototype, and the underlying WebGL context
 * still has to be bound to a real, visible canvas at construction time.
 * Trying to host one engine on a hidden 1×1 canvas and `registerView`
 * the visible canvases blew up with "registerView is not a function" on
 * Babylon 9.5.
 *
 * The simpler design: each preview component owns its own Engine + Scene,
 * attached to its visible canvas. Browsers cap active WebGL contexts at
 * ~16, but we only ever have 1-2 previews mounted at once (the main
 * preview pane + occasionally a hover preview), so the cap is moot.
 * Engine + scene get disposed on unmount.
 *
 * If we ever need cross-preview resource sharing (shader caches, texture
 * pools), revisit — likely via Babylon's `EngineFactory` + a true
 * registerView setup. Until then, simple wins.
 */

import { Engine } from '@babylonjs/core/Engines/engine';

export function createEngine(canvas: HTMLCanvasElement): Engine {
    return new Engine(canvas, true, {
        preserveDrawingBuffer: false,
        stencil: false,
        antialias: true,
        adaptToDeviceRatio: true,
        // Transparent backbuffer so the parent div's CSS background
        // (themed via --editor-bg) shows through. Avoids re-reading
        // and parsing CSS variables on every theme switch — the
        // rendering surface just becomes see-through and lets the
        // page handle background painting.
        alpha: true,
        premultipliedAlpha: false,
    });
}
