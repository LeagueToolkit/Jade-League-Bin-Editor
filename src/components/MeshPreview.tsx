/**
 * 3D mesh preview component — renders an SKN file into a Babylon scene
 * with an orbit camera, basic lighting, and a ground grid.
 *
 * Phase 1: static-only. We render the SKN's bind-pose geometry as if
 * it were a rigid mesh — no skeleton, no animation, no textures. The
 * goal is to validate the parser + coordinate system + camera framing
 * end-to-end before layering SKL/skinning on top.
 *
 * The Babylon `Engine` is a singleton shared across all previews; this
 * component owns its own `Scene` and disposes it on unmount.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

// Side-effect import. Babylon registers its shader-include modules
// (helperFunctions, bonesDeclaration, lightFragment, …) lazily by
// importing them from each material's main module. With Vite + tree-
// shaken modular imports this chain sometimes loses entries, leaving
// the GLSL compiler to choke on unresolved `#include<…>` directives
// ("VERTEX SHADER ERROR: 0:46: '<' : syntax error"). Importing the
// umbrella once forces every ShadersInclude module to register, fully
// populating the ShaderStore for the whole app's lifetime. The cost
// is ~400KB of extra bundle — acceptable for a desktop Tauri app and
// far simpler than chasing the exact subset of includes we need.
import '@babylonjs/core';
import '@babylonjs/materials';

import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { Material } from '@babylonjs/core/Materials/material';
import { PBRMaterial } from '@babylonjs/core/Materials/PBR/pbrMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { RawTexture } from '@babylonjs/core/Materials/Textures/rawTexture';
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder';
import { GridMaterial } from '@babylonjs/materials/grid/gridMaterial';

import { createEngine } from '../lib/babylon/engine';
import { buildSknMeshes, type SknDTO } from '../lib/babylon/meshBuilder';

interface MeshPreviewProps {
    /** Disk path or `wad://<mountId>/<pathHashHex>` source identifier. */
    source:
        | { kind: 'disk'; path: string }
        | { kind: 'wad'; mountId: number; pathHashHex: string };
    /** Optional caption shown in the corner. Useful while debugging. */
    label?: string;
}

type ShadingMode = 'flat' | 'lit';
type MissingStyle = 'material-color' | 'pattern';

/// Per-submesh display state — kept in a ref (not React state) because
/// the render loop reads from it every frame and we don't want to
/// trigger a React re-render every time a texture lands.
interface SubmeshSlot {
    mat: PBRMaterial;
    /// Per-submesh hue color used for the placeholder "material color"
    /// look (and as the visible fallback while textures are still
    /// fetching).
    hue: Color3;
    /// Chunk hash hex of the texture currently slotted onto this
    /// material, or `null` if nothing's resolved yet.
    chunkHash: string | null;
}

export function MeshPreview({ source, label }: MeshPreviewProps) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const sceneRef = useRef<Scene | null>(null);
    const meshesRef = useRef<Mesh[]>([]);

    /// Per-submesh material slots keyed by index. Materials, hue
    /// colors, and currently-applied chunk hash all live here.
    const slotsRef = useRef<SubmeshSlot[]>([]);
    /// Loaded GPU textures, keyed by chunk hash. Shared across slots
    /// when multiple submeshes use the same texture chunk.
    const loadedTexturesRef = useRef<Map<string, { tex: RawTexture; hasAlpha: boolean }>>(
        new Map(),
    );
    /// Lazy-built 2×2 magenta/black checkerboard for the missing-
    /// texture look. Constructed on first need, reused thereafter.
    const placeholderTexRef = useRef<RawTexture | null>(null);
    /// `true` when the active mesh is a static format (SCB/SCO) —
    /// they're frequently flat particle quads / single-sided
    /// geometry that needs to render from both sides regardless of
    /// winding. SKN meshes keep normal back-face culling. Updated
    /// once per fetchAndBuild and read by `refreshMaterials`.
    const doubleSidedRef = useRef(false);

    const [error, setError] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    /** Per-submesh visibility list, in the same order as `built.meshes`.
     *  Driven by the visibility panel's checkboxes; toggling sets the
     *  corresponding Babylon mesh's `setEnabled(visible)`. */
    const [submeshes, setSubmeshes] = useState<{ name: string; visible: boolean }[]>([]);
    const [panelOpen, setPanelOpen] = useState(false);
    const [shadingMode, setShadingMode] = useState<ShadingMode>('flat');
    // Default to the magenta/black checkerboard for missing textures —
    // it's the universally-recognized "missing texture" indicator and
    // makes failed BIN lookups visually obvious. Users who prefer the
    // distinct per-submesh hue palette can flip the toggle.
    const [missingStyle, setMissingStyle] = useState<MissingStyle>('pattern');
    const [guessing, setGuessing] = useState(false);

    /// Apply the current settings (shading + missing-texture style)
    /// across every submesh material. Idempotent — safe to call after
    /// each texture lands, after a settings toggle, or after a guess.
    const refreshMaterials = useCallback(() => {
        const scene = sceneRef.current;
        const slots = slotsRef.current;
        const loaded = loadedTexturesRef.current;
        if (!scene) return;
        const placeholder =
            missingStyle === 'pattern'
                ? (placeholderTexRef.current ??= buildPlaceholderTexture(scene))
                : null;
        const doubleSided = doubleSidedRef.current;
        for (const slot of slots) {
            const real = slot.chunkHash ? loaded.get(slot.chunkHash) : undefined;
            if (real) {
                applyTexturedMaterial(slot.mat, real.tex, real.hasAlpha);
            } else if (placeholder) {
                applyTexturedMaterial(slot.mat, placeholder, false);
            } else {
                applyHueMaterial(slot.mat, slot.hue);
            }
            slot.mat.unlit = shadingMode === 'flat';
            // Static meshes are usually flat / particle / single-
            // sided geometry — disable culling so users can see
            // them from any angle. SKN meshes are closed solids
            // and keep culling on.
            if (doubleSided) {
                slot.mat.backFaceCulling = false;
            }
        }
    }, [missingStyle, shadingMode]);

    // Re-apply when toggles change. Texture/binding refs are unchanged
    // by the toggle itself, so we just rebuild the visual state.
    useEffect(() => {
        refreshMaterials();
    }, [refreshMaterials]);

    const toggleSubmesh = useCallback((index: number) => {
        setSubmeshes((prev) => {
            const next = prev.slice();
            const cur = next[index];
            if (!cur) return prev;
            const visible = !cur.visible;
            next[index] = { ...cur, visible };
            const mesh = meshesRef.current[index];
            if (mesh) mesh.setEnabled(visible);
            return next;
        });
    }, []);

    const setAllSubmeshes = useCallback((visible: boolean) => {
        setSubmeshes((prev) => {
            const next = prev.map((s) => ({ ...s, visible }));
            for (let i = 0; i < meshesRef.current.length; i++) {
                meshesRef.current[i]?.setEnabled(visible);
            }
            return next;
        });
    }, []);

    /// "Guess" — for SKNs where the BIN didn't resolve textures (or
    /// the user wants different ones), scan the mount for `.tex`/`.dds`
    /// chunks under `/skin{N}/` and assign them by name-matching
    /// against submesh names. The Rust side picks a "main" texture as
    /// the fallback for whatever doesn't match by name. Disk-source
    /// SKNs aren't supported yet (no mount → nothing to scan).
    const onGuessTextures = useCallback(async () => {
        if (source.kind !== 'wad') return;
        const scene = sceneRef.current;
        if (!scene) return;
        if (guessing) return;
        setGuessing(true);
        try {
            const submeshNames = meshesRef.current.map((m) => m.name);
            const sknBasename = (label || '')
                .replace(/\.skn$/i, '')
                .toLowerCase() || null;
            let bindings: TextureBinding[];
            try {
                bindings = await invoke<TextureBinding[]>('wad_guess_textures', {
                    id: source.mountId,
                    sknPathHashHex: source.pathHashHex,
                    submeshNames,
                    sknBasename,
                });
            } catch (e) {
                console.warn('[MeshPreview] guess failed:', e);
                return;
            }

            // Re-point each slot at the guessed chunk hash. `null`
            // entries reset the slot back to placeholder (material-color
            // or pattern, depending on the active toggle).
            const slots = slotsRef.current;
            for (let i = 0; i < bindings.length && i < slots.length; i++) {
                slots[i].chunkHash = bindings[i].chunk_hash_hex;
            }

            // Fetch any newly-needed textures we haven't decoded yet.
            const loaded = loadedTexturesRef.current;
            const newHashes = Array.from(
                new Set(
                    bindings
                        .map((b) => b.chunk_hash_hex)
                        .filter((h): h is string => !!h && !loaded.has(h)),
                ),
            );
            await Promise.allSettled(
                newHashes.map(async (hash) => {
                    const decoded = await loadTextureFromHash(source.mountId, hash, scene);
                    if (decoded) loaded.set(hash, decoded);
                }),
            );

            refreshMaterials();
            const matched = bindings.filter((b) => b.chunk_hash_hex).length;
            console.log(
                `[MeshPreview] guess: ${matched}/${bindings.length} submeshes matched`,
            );
        } finally {
            setGuessing(false);
        }
    }, [source, label, guessing, refreshMaterials]);

    // Stable JSON key so the effect only re-runs when the source actually
    // changes — avoids a render-tear on every parent rerender.
    const sourceKey =
        source.kind === 'disk'
            ? `disk:${source.path}`
            : `wad:${source.mountId}:${source.pathHashHex}`;

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        let cancelled = false;
        setLoading(true);
        setError(null);

        // One engine per preview — see lib/babylon/engine.ts for why we
        // dropped the singleton-engine pattern.
        const engine = createEngine(canvas);
        const scene = new Scene(engine);
        // Transparent clear so the parent div's CSS background (themed
        // via --editor-bg) is what the user sees behind the model. No
        // hardcoded color = automatic theme tracking.
        scene.clearColor = new Color4(0, 0, 0, 0);
        sceneRef.current = scene;

        // Orbit camera. ArcRotateCamera angle convention (Babylon LH Y-up):
        //   alpha = +π/2 sits the camera on the +Z side. League meshes
        //   are authored facing +Z, so the +Z viewpoint reads as the
        //   front (confirmed empirically — the -Z viewpoint shows the
        //   character's back). Users can orbit freely from here.
        //   beta = π/2 is dead-level horizontal so the model isn't
        //   tilted in the initial frame.
        // Radius/target are placeholders; both are updated below once
        // the mesh has loaded and we know its real bounds.
        const camera = new ArcRotateCamera(
            'cam',
            Math.PI / 2,
            Math.PI / 2,
            5,
            Vector3.Zero(),
            scene
        );
        camera.attachControl(canvas, true);
        camera.lowerRadiusLimit = 0.5;
        camera.upperRadiusLimit = 1000;
        camera.wheelDeltaPercentage = 0.05;
        camera.panningSensibility = 100;
        // Babylon defaults to clamping vertical angle at 0.01 / π-0.01;
        // we widen it so the user can orbit underneath.
        camera.lowerBetaLimit = 0.01;
        camera.upperBetaLimit = Math.PI - 0.01;

        // Single hemispheric kept around for GridMaterial — character
        // meshes themselves are unlit (League look) so they ignore
        // scene lights entirely. No directional/key light, no per-
        // frame observer needed.
        const hemi = new HemisphericLight('hemi', new Vector3(0, 1, 0), scene);
        hemi.intensity = 1.0;

        // Ground grid — uses Babylon's GridMaterial which draws a
        // checkerboard of fine + major lines. Keeps the model anchored
        // visually so the user can tell when it's at origin vs floating.
        const ground = CreateGround('ground', { width: 200, height: 200, subdivisions: 1 }, scene);
        const gridMat = new GridMaterial('grid', scene);
        gridMat.gridRatio = 5;
        gridMat.majorUnitFrequency = 10;
        gridMat.minorUnitVisibility = 0.35;
        gridMat.lineColor = new Color3(0.4, 0.45, 0.55);
        gridMat.mainColor = new Color3(0.06, 0.07, 0.09);
        gridMat.opacity = 0.9;
        ground.material = gridMat;

        const startRender = () => {
            engine.runRenderLoop(() => {
                if (sceneRef.current) sceneRef.current.render();
            });
        };

        const fetchAndBuild = async () => {
            try {
                const skn = await loadMeshAsSknDto(source, label);
                if (cancelled) return;
                // Static meshes (SCB/SCO) often contain flat
                // single-sided geometry — particle quads, decals,
                // hair cards. Disabling backface culling for those
                // makes both sides visible, matching how they're
                // rendered in-engine. SKNs keep normal culling.
                doubleSidedRef.current = detectFormat(source, label) !== 'skn';


                const built = buildSknMeshes(skn, scene);
                meshesRef.current = built.meshes;
                // Seed the visibility panel — mirrors `built.meshes`
                // order so toggle indices line up 1:1 with the ref.
                setSubmeshes(
                    built.meshes.map((m, i) => ({
                        name: m.name || `submesh ${i}`,
                        visible: true,
                    })),
                );

                // One PBRMaterial per submesh, each seeded with a
                // distinct hue. The hue is the placeholder shown
                // before any texture arrives, and remains the
                // fallback in "material color" missing-texture mode
                // for submeshes the BIN doesn't resolve. Settings
                // toggles flow through `refreshMaterials` later, so
                // initial setup just needs to put materials + slots
                // in place.
                const golden = 0.618033988749895;
                const slots: SubmeshSlot[] = [];
                for (let i = 0; i < built.meshes.length; i++) {
                    const m = built.meshes[i];
                    const mat = new PBRMaterial(`skn_mat_${i}`, scene);
                    const hue = Color3.FromHSV(((i * golden) % 1) * 360, 0.5, 0.85);
                    mat.unlit = true; // initial — refreshMaterials updates per the toggle
                    applyHueMaterial(mat, hue);
                    m.material = mat;
                    slots.push({ mat, hue, chunkHash: null });
                }
                slotsRef.current = slots;
                loadedTexturesRef.current = new Map();
                refreshMaterials();

                // Texture pipeline (WAD-source only — disk meshes
                // don't have an associated mount to fetch BIN/textures
                // from). Branches on format because static meshes
                // (SCB/SCO) aren't wired through skinMeshProperties:
                //   - SKN → walks materialOverride list keyed by
                //     submesh names
                //   - SCB/SCO → walks the BIN tree for any object
                //     that references the mesh's path string and
                //     pulls a sibling texture
                if (source.kind === 'wad') {
                    const fmt = detectFormat(source, label);
                    if (fmt === 'skn') {
                        void applyTextures(
                            source.mountId,
                            source.pathHashHex,
                            skn,
                            slots,
                            loadedTexturesRef.current,
                            scene,
                            () => cancelled,
                            refreshMaterials,
                        );
                    } else {
                        void applyStaticMeshTexture(
                            source.mountId,
                            source.pathHashHex,
                            slots,
                            loadedTexturesRef.current,
                            scene,
                            () => cancelled,
                            refreshMaterials,
                        );
                    }
                }

                // Compute the AABB from Babylon's per-mesh bounding info,
                // not the SKN file's stored AABB. Some v4 SKNs ship a
                // junk/zero AABB and trusting it leaves the camera tiny
                // and pointed at origin while the actual verts are 100s
                // of units away. We use *local-space* min/max here
                // (.minimum / .maximum) — minimumWorld depends on the
                // mesh's world matrix being current, which it isn't
                // reliably right after applyToMesh.
                let minX = Infinity, minY = Infinity, minZ = Infinity;
                let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
                for (const m of built.meshes) {
                    m.computeWorldMatrix(true);
                    m.refreshBoundingInfo();
                    const bb = m.getBoundingInfo().boundingBox;
                    const lo = bb.minimum;
                    const hi = bb.maximum;
                    if (lo.x < minX) minX = lo.x;
                    if (lo.y < minY) minY = lo.y;
                    if (lo.z < minZ) minZ = lo.z;
                    if (hi.x > maxX) maxX = hi.x;
                    if (hi.y > maxY) maxY = hi.y;
                    if (hi.z > maxZ) maxZ = hi.z;
                }

                // Guard against NaN/Infinity sneaking in if a vertex
                // came back malformed. Without this, Math.max would
                // poison radius and we'd fall back to the placeholder
                // 5-unit value while the model is 100s of units across.
                const finite = (n: number) => Number.isFinite(n) ? n : 0;
                minX = finite(minX); minY = finite(minY); minZ = finite(minZ);
                maxX = finite(maxX); maxY = finite(maxY); maxZ = finite(maxZ);

                const sizeX = maxX - minX;
                const sizeY = maxY - minY;
                const sizeZ = maxZ - minZ;

                // Lift the model so feet sit on the ground grid. Some
                // skins are authored with feet below y=0; the shift
                // keeps the grid visually anchored under the model.
                const yShift = minY < 0 ? -minY : 0;
                if (yShift !== 0) {
                    for (const m of built.meshes) m.position.y = yShift;
                }

                // Camera target: visual center after y-shift.
                const target = new Vector3(
                    (minX + maxX) / 2,
                    (minY + maxY) / 2 + yShift,
                    (minZ + maxZ) / 2
                );
                // Frame the model with breathing room. We weight Y a
                // little more heavily than X/Z because our camera is
                // alpha=π/2, beta=π/2 — looking horizontally — so the
                // height of the model maps to the *vertical* extent
                // of the frame, while X/Z share the horizontal. A flat
                // max() over all three can leave way too much vertical
                // padding for tall+winged characters (Aatrox is 297
                // tall but 384 wide because of the wings).
                const radius = Math.max(sizeY * 1.4, sizeX, sizeZ) || 5;

                // setTarget on ArcRotateCamera *also* calls
                // rebuildAnglesAndRadius, which recomputes alpha/beta/
                // radius from the camera's CURRENT position. At this
                // point the camera is still at the placeholder
                // (0, 0, 5), so rebuild puts it nearly straight under
                // the new target — beta near π, model viewed from
                // below. Re-assert alpha/beta/radius AFTER setTarget
                // to override the rebuilt values.
                //
                // Angle pick: 3/4 view, Blender-default-ish. Rotate
                // ~22.5° toward the model's left side (so the user
                // looks at the model's right cheek/shoulder — the
                // standard hero-portrait angle) and lift ~22.5° above
                // horizontal so the silhouette reads with depth.
                camera.setTarget(target);
                camera.alpha = Math.PI / 2 + Math.PI / 8;
                camera.beta = Math.PI / 2 - Math.PI / 8;
                camera.radius = radius;
                camera.lowerRadiusLimit = radius * 0.1;
                camera.upperRadiusLimit = radius * 8;


                if (cancelled) {
                    for (const m of built.meshes) m.dispose();
                    return;
                }

                setLoading(false);
                startRender();
            } catch (e) {
                if (cancelled) return;
                const msg = e instanceof Error ? e.message : String(e);
                setError(msg);
                setLoading(false);
            }
        };

        // Resize handling — Babylon needs an explicit resize() call when
        // the canvas's CSS box changes. ResizeObserver fires on layout
        // changes (window resize, splitter drag, panel show/hide).
        const ro = new ResizeObserver(() => engine.resize());
        ro.observe(canvas);

        fetchAndBuild();

        return () => {
            cancelled = true;
            ro.disconnect();
            sceneRef.current = null;
            meshesRef.current = [];
            slotsRef.current = [];
            // Babylon disposes textures together with their owning
            // scene, so we just drop the references — no per-texture
            // cleanup needed.
            loadedTexturesRef.current = new Map();
            placeholderTexRef.current = null;
            setSubmeshes([]);
            setPanelOpen(false);
            engine.stopRenderLoop();
            scene.dispose();
            engine.dispose();
        };
    }, [sourceKey]);

    return (
        <div style={{ position: 'relative', width: '100%', height: '100%', minHeight: 360 }}>
            <canvas
                ref={canvasRef}
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'block',
                    outline: 'none',
                    touchAction: 'none',
                }}
                tabIndex={0}
            />
            {loading && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        pointerEvents: 'none',
                        color: 'var(--text-secondary, #9DA5B4)',
                        fontSize: 12,
                    }}
                >
                    Loading mesh…
                </div>
            )}
            {error && (
                <div
                    style={{
                        position: 'absolute',
                        inset: 0,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexDirection: 'column',
                        gap: 6,
                        padding: 12,
                        textAlign: 'center',
                        color: '#E06C75',
                        fontSize: 12,
                    }}
                >
                    <div>Mesh preview failed</div>
                    <div style={{ color: 'var(--text-secondary, #9DA5B4)', maxWidth: 360 }}>
                        {error}
                    </div>
                </div>
            )}
            {label && !loading && !error && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 8,
                        left: 10,
                        fontSize: 10,
                        color: 'var(--text-secondary, #9DA5B4)',
                        background: 'rgba(0, 0, 0, 0.35)',
                        padding: '2px 6px',
                        borderRadius: 3,
                        pointerEvents: 'none',
                    }}
                >
                    {label}
                </div>
            )}

            {/* Submesh visibility panel — bottom-right corner. Button
                always visible after the mesh loads; expands on click
                to a checklist of submeshes the user can toggle. */}
            {!loading && !error && submeshes.length > 0 && (
                <div
                    style={{
                        position: 'absolute',
                        bottom: 8,
                        right: 8,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-end',
                        gap: 6,
                        fontSize: 11,
                        color: 'var(--text-primary, #d4d4d4)',
                    }}
                >
                    {panelOpen && (
                        <div
                            style={{
                                background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                                border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                                borderRadius: 4,
                                padding: '8px 10px',
                                minWidth: 180,
                                maxHeight: 320,
                                overflowY: 'auto',
                                boxShadow: '0 4px 14px rgba(0, 0, 0, 0.45)',
                            }}
                        >
                            <SettingsSection
                                shadingMode={shadingMode}
                                onShadingChange={setShadingMode}
                                missingStyle={missingStyle}
                                onMissingStyleChange={setMissingStyle}
                                onGuess={onGuessTextures}
                                guessAvailable={source.kind === 'wad'}
                                guessing={guessing}
                            />
                            <div
                                style={{
                                    display: 'flex',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    marginBottom: 6,
                                    paddingBottom: 4,
                                    borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 50%, transparent)',
                                    fontSize: 10,
                                    color: 'var(--text-secondary, #9DA5B4)',
                                }}
                            >
                                <span>Submeshes ({submeshes.length})</span>
                                <span style={{ display: 'flex', gap: 4 }}>
                                    <button
                                        type="button"
                                        onClick={() => setAllSubmeshes(true)}
                                        style={miniButtonStyle}
                                        title="Show all"
                                    >
                                        All
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => setAllSubmeshes(false)}
                                        style={miniButtonStyle}
                                        title="Hide all"
                                    >
                                        None
                                    </button>
                                </span>
                            </div>
                            {submeshes.map((s, i) => (
                                <label
                                    key={`${i}-${s.name}`}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 6,
                                        padding: '3px 0',
                                        cursor: 'pointer',
                                        opacity: s.visible ? 1 : 0.55,
                                    }}
                                    title={s.name}
                                >
                                    <input
                                        type="checkbox"
                                        checked={s.visible}
                                        onChange={() => toggleSubmesh(i)}
                                        style={{ margin: 0, cursor: 'pointer' }}
                                    />
                                    <span
                                        style={{
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                            maxWidth: 180,
                                        }}
                                    >
                                        {s.name}
                                    </span>
                                </label>
                            ))}
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={() => setPanelOpen((p) => !p)}
                        style={{
                            background: 'color-mix(in srgb, var(--editor-bg, #1e1e1e) 88%, transparent)',
                            border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                            color: 'var(--text-primary, #d4d4d4)',
                            padding: '4px 10px',
                            borderRadius: 4,
                            cursor: 'pointer',
                            fontSize: 11,
                        }}
                        title={panelOpen ? 'Hide submesh list' : 'Show submesh list'}
                    >
                        Submeshes ({submeshes.filter((s) => s.visible).length}/{submeshes.length})
                    </button>
                </div>
            )}
        </div>
    );
}

const miniButtonStyle: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
    color: 'var(--text-secondary, #9DA5B4)',
    padding: '1px 6px',
    borderRadius: 3,
    cursor: 'pointer',
    fontSize: 10,
};

// ── Settings UI ──────────────────────────────────────────────────────

interface SettingsSectionProps {
    shadingMode: ShadingMode;
    onShadingChange: (m: ShadingMode) => void;
    missingStyle: MissingStyle;
    onMissingStyleChange: (s: MissingStyle) => void;
    onGuess: () => void;
    /// `false` for disk-source previews — there's no mount to scan.
    guessAvailable: boolean;
    guessing: boolean;
}

function SettingsSection({
    shadingMode,
    onShadingChange,
    missingStyle,
    onMissingStyleChange,
    onGuess,
    guessAvailable,
    guessing,
}: SettingsSectionProps) {
    return (
        <div
            style={{
                marginBottom: 8,
                paddingBottom: 8,
                borderBottom: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 50%, transparent)',
                display: 'flex',
                flexDirection: 'column',
                gap: 6,
            }}
        >
            <SegmentedToggle<ShadingMode>
                label="Shading"
                value={shadingMode}
                onChange={onShadingChange}
                options={[
                    { value: 'flat', label: 'Flat' },
                    { value: 'lit', label: 'Lit' },
                ]}
            />
            <SegmentedToggle<MissingStyle>
                label="Missing"
                value={missingStyle}
                onChange={onMissingStyleChange}
                options={[
                    { value: 'material-color', label: 'Color' },
                    { value: 'pattern', label: 'Pattern' },
                ]}
            />
            {guessAvailable && (
                <button
                    type="button"
                    onClick={onGuess}
                    disabled={guessing}
                    style={{
                        ...miniButtonStyle,
                        padding: '4px 8px',
                        fontSize: 11,
                        cursor: guessing ? 'wait' : 'pointer',
                        opacity: guessing ? 0.6 : 1,
                    }}
                    title="Scan the WAD for matching textures and apply them by name"
                >
                    {guessing ? 'Guessing…' : 'Guess textures'}
                </button>
            )}
        </div>
    );
}

interface SegmentedOption<T extends string> {
    value: T;
    label: string;
}

interface SegmentedToggleProps<T extends string> {
    label: string;
    value: T;
    onChange: (v: T) => void;
    options: SegmentedOption<T>[];
}

function SegmentedToggle<T extends string>({
    label,
    value,
    onChange,
    options,
}: SegmentedToggleProps<T>) {
    return (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span
                style={{
                    fontSize: 10,
                    color: 'var(--text-secondary, #9DA5B4)',
                    minWidth: 50,
                }}
            >
                {label}
            </span>
            <div
                style={{
                    display: 'flex',
                    border: '1px solid color-mix(in srgb, var(--border-color, #3e3e42) 70%, transparent)',
                    borderRadius: 3,
                    overflow: 'hidden',
                    flex: 1,
                }}
            >
                {options.map((opt) => {
                    const active = value === opt.value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            onClick={() => onChange(opt.value)}
                            style={{
                                flex: 1,
                                padding: '2px 6px',
                                background: active
                                    ? 'color-mix(in srgb, var(--accent-color, #2196f3) 60%, transparent)'
                                    : 'transparent',
                                border: 'none',
                                color: active
                                    ? 'var(--text-primary, #d4d4d4)'
                                    : 'var(--text-secondary, #9DA5B4)',
                                fontSize: 10,
                                cursor: 'pointer',
                            }}
                        >
                            {opt.label}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

// ── Format detection + DTO conversion ───────────────────────────────
//
// SKN, SCB, and SCO all describe geometry the renderer treats the
// same way (a list of triangles with positions + UVs grouped into
// one or more submeshes). To keep the rendering / texture pipeline
// uniform, the static formats parse server-side into a `StaticMesh`
// DTO and the frontend repackages them as a synthetic single-submesh
// `SknDTO` here. Means `meshBuilder`, `applyTextures`, the visibility
// panel, and the Guess flow all work for static meshes without any
// branching downstream.

interface StaticMeshDTO {
    major: number;
    minor: number;
    material: string;
    indices: number[];
    positions: number[];
    uvs: number[];
    bbox: [[number, number, number], [number, number, number]];
}

type MeshFormat = 'skn' | 'scb' | 'sco';

function detectFormat(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
    label?: string,
): MeshFormat {
    const name = (source.kind === 'disk' ? source.path : label || '').toLowerCase();
    if (name.endsWith('.scb')) return 'scb';
    if (name.endsWith('.sco')) return 'sco';
    return 'skn'; // default — covers all "no extension visible" cases too
}

async function loadMeshAsSknDto(
    source: { kind: 'disk'; path: string } | { kind: 'wad'; mountId: number; pathHashHex: string },
    label?: string,
): Promise<SknDTO> {
    const format = detectFormat(source, label);
    if (format === 'skn') {
        return source.kind === 'disk'
            ? invoke<SknDTO>('read_skn_mesh', { path: source.path })
            : invoke<SknDTO>('wad_read_skn_mesh', {
                  id: source.mountId,
                  pathHashHex: source.pathHashHex,
              });
    }
    const cmdDisk = format === 'scb' ? 'read_scb_mesh' : 'read_sco_mesh';
    const cmdWad = format === 'scb' ? 'wad_read_scb_mesh' : 'wad_read_sco_mesh';
    const sm =
        source.kind === 'disk'
            ? await invoke<StaticMeshDTO>(cmdDisk, { path: source.path })
            : await invoke<StaticMeshDTO>(cmdWad, {
                  id: source.mountId,
                  pathHashHex: source.pathHashHex,
              });
    return staticMeshToSkn(sm);
}

/// Repackage a `StaticMesh` as a `SknDTO` with one synthetic submesh
/// named after the SCB/SCO's material. The SKN-shaped consumers
/// (mesh builder, texture pipeline, visibility panel) then need no
/// special-cases for static meshes — the single submesh just looks
/// like any other named submesh on a one-piece SKN.
function staticMeshToSkn(s: StaticMeshDTO): SknDTO {
    const vCount = (s.positions.length / 3) | 0;
    const iCount = s.indices.length;
    return {
        major: s.major,
        minor: s.minor,
        submeshes: [
            {
                name: s.material || 'static',
                start_vertex: 0,
                vertex_count: vCount,
                start_index: 0,
                index_count: iCount,
            },
        ],
        indices: s.indices,
        positions: s.positions,
        uvs: s.uvs,
        bone_indices: [],
        bone_weights: [],
        bbox: s.bbox,
    };
}

/// Wire format for `wad_decode_texture` — kept in one place so the
/// initial-load path and the post-guess top-up path stay in sync.
const TEX_HEADER_LEN = 16;
const FLAG_HAS_ALPHA = 1 << 0;

async function loadTextureFromHash(
    mountId: number,
    chunkHashHex: string,
    scene: Scene,
): Promise<{ tex: RawTexture; hasAlpha: boolean } | null> {
    try {
        const buf = await invoke<ArrayBuffer>('wad_decode_texture', {
            id: mountId,
            pathHashHex: chunkHashHex,
        });
        if (buf.byteLength < TEX_HEADER_LEN) {
            console.warn(`[MeshPreview] short payload for ${chunkHashHex}: ${buf.byteLength} bytes`);
            return null;
        }
        const header = new DataView(buf, 0, TEX_HEADER_LEN);
        const width = header.getUint32(0, true);
        const height = header.getUint32(4, true);
        const flags = header.getUint32(8, true);
        const hasAlpha = (flags & FLAG_HAS_ALPHA) !== 0;
        const rgba = new Uint8Array(buf, TEX_HEADER_LEN);
        const tex = RawTexture.CreateRGBATexture(
            rgba,
            width,
            height,
            scene,
            /* generateMipMaps */ true,
            /* invertY */ true,
            Texture.TRILINEAR_SAMPLINGMODE,
        );
        tex.wrapU = Texture.CLAMP_ADDRESSMODE;
        tex.wrapV = Texture.CLAMP_ADDRESSMODE;
        tex.hasAlpha = hasAlpha;
        return { tex, hasAlpha };
    } catch (e) {
        console.warn(`[MeshPreview] texture fetch failed for ${chunkHashHex}:`, e);
        return null;
    }
}

// ── Material helpers ─────────────────────────────────────────────────
//
// Pulled out of the component so the per-submesh setup, texture
// updates, and toggle re-applies all share one configuration source.
// Keeps the PBR transparency / culling / depth-pre-pass settings in a
// single place — easier to evolve without hunting for stragglers.

function applyTexturedMaterial(mat: PBRMaterial, tex: RawTexture, hasAlpha: boolean): void {
    mat.albedoTexture = tex;
    mat.albedoColor = new Color3(1, 1, 1);
    mat.backFaceCulling = true;
    if (hasAlpha) {
        mat.useAlphaFromAlbedoTexture = true;
        mat.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
        mat.alphaCutOff = 0.2;
        mat.needDepthPrePass = true;
    } else {
        mat.useAlphaFromAlbedoTexture = false;
        mat.transparencyMode = Material.MATERIAL_OPAQUE;
        mat.needDepthPrePass = false;
    }
    configurePbr(mat);
}

function applyHueMaterial(mat: PBRMaterial, hue: Color3): void {
    mat.albedoTexture = null;
    mat.albedoColor = hue;
    mat.useAlphaFromAlbedoTexture = false;
    mat.transparencyMode = Material.MATERIAL_OPAQUE;
    mat.needDepthPrePass = false;
    mat.backFaceCulling = true;
    configurePbr(mat);
}

/// Lit-mode PBR settings shared by every material variant. Without
/// these, PBRMaterial defaults to a metal-ish, env-lit look that
/// renders nearly black when there's no environment texture in the
/// scene (indirect specular is zero, ambient is zero, direct
/// hemispheric goes through cos-falloff).
///
/// We force a fully-matte dielectric (metallic=0, roughness=1) so
/// shading is dominated by direct hemispheric + ambient. Also enable
/// `twoSidedLighting` because League's flipped index winding pairs
/// with `ComputeNormals`'s right-hand-rule output to give some faces
/// inward-pointing normals — without two-sided lighting those faces
/// render black instead of receiving the upper-hemisphere
/// contribution.
function configurePbr(mat: PBRMaterial): void {
    mat.metallic = 0;
    mat.roughness = 1;
    mat.environmentIntensity = 0;
    mat.directIntensity = 1.2;
    mat.twoSidedLighting = true;
}

/// Build the magenta/black checkerboard used for the "missing texture"
/// look. 2×2 RGBA tiled with NEAREST filtering + WRAP addressing
/// produces classic Source-style chessboard squares once UVs span
/// more than one tile-width — close to League's missing-texture
/// fallback in mod tooling.
function buildPlaceholderTexture(scene: Scene): RawTexture {
    const data = new Uint8Array([
        0xff, 0x00, 0xff, 0xff, // magenta
        0x00, 0x00, 0x00, 0xff, // black
        0x00, 0x00, 0x00, 0xff, // black
        0xff, 0x00, 0xff, 0xff, // magenta
    ]);
    const tex = RawTexture.CreateRGBATexture(
        data,
        2,
        2,
        scene,
        /* generateMipMaps */ false,
        /* invertY */ false,
        Texture.NEAREST_SAMPLINGMODE,
    );
    tex.wrapU = Texture.WRAP_ADDRESSMODE;
    tex.wrapV = Texture.WRAP_ADDRESSMODE;
    // Tile the 2-pixel pattern across the UV space so users see a
    // grid of squares instead of one big magenta blob. uScale=8
    // gives 8 black + 8 magenta cells across a 0..1 UV range.
    tex.uScale = 8;
    tex.vScale = 8;
    return tex;
}

// ─────────────────────────────────────────────────────────────────────
// Texture pipeline
//
// Flow when an SKN renders from a mounted WAD:
//   1. wad_read_skin_textures resolves the sibling skin BIN, parses
//      its ritobin text, and returns a map of submesh-name →
//      texture-path (+ that texture's chunk hash, when the texture
//      lives in this same WAD).
//   2. For each submesh, look up its material binding. Group texture
//      fetches by chunk-hash so a texture shared across N materials
//      is only downloaded + decoded once.
//   3. For each unique chunk: fetch decompressed bytes via
//      wad_read_chunk_b64, decode (DDS or TEX) into a PNG data URL,
//      build a Babylon Texture and assign it to every submesh
//      material that maps to that chunk.
//
// Each submesh that has no override falls back to the BIN's BASE
// texture (also pre-resolved server-side).
// ─────────────────────────────────────────────────────────────────────

interface TextureBinding {
    material: string;
    texture_path: string;
    chunk_hash_hex: string | null;
}
interface SknTextureBindings {
    bin_path: string;
    bin_path_hash_hex: string;
    default_texture: string | null;
    default_chunk_hash_hex: string | null;
    bindings: TextureBinding[];
}

/// SCB/SCO texture pipeline. Mirrors `applyTextures` for the SKN
/// case but uses the new `wad_find_static_mesh_texture` command,
/// which walks the BIN tree for any object that references the
/// mesh's path string and returns a single best-guess diffuse
/// texture binding.
async function applyStaticMeshTexture(
    mountId: number,
    mesh_path_hash_hex: string,
    slots: SubmeshSlot[],
    loadedTextures: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    scene: Scene,
    isCancelled: () => boolean,
    refresh: () => void,
): Promise<void> {
    const tStart = performance.now();
    let binding: TextureBinding | null;
    try {
        binding = await invoke<TextureBinding | null>('wad_find_static_mesh_texture', {
            id: mountId,
            meshPathHashHex: mesh_path_hash_hex,
        });
    } catch (e) {
        console.warn('[MeshPreview] static-mesh texture lookup failed:', e);
        return;
    }
    if (isCancelled()) return;
    if (!binding) {
        console.log('[MeshPreview] static mesh: no BIN texture reference found');
        return;
    }
    const tBin = performance.now();
    console.log(
        `[MeshPreview] static mesh BIN: ${binding.material}` +
            ` | texture=${binding.texture_path}` +
            ` | hash=${binding.chunk_hash_hex ?? '(unresolved)'}`,
    );

    if (!binding.chunk_hash_hex) {
        return;
    }

    const decoded = await loadTextureFromHash(mountId, binding.chunk_hash_hex, scene);
    if (isCancelled() || !decoded) return;
    loadedTextures.set(binding.chunk_hash_hex, decoded);

    // Static meshes are single-submesh in our DTO, so all slots get
    // the same texture. (In practice there's one slot, but iterating
    // is harmless and future-proofs against multi-submesh static
    // meshes if they ever come up.)
    for (const slot of slots) {
        slot.chunkHash = binding.chunk_hash_hex;
    }
    refresh();

    const tEnd = performance.now();
    console.log(
        `[MeshPreview] static mesh ready: bin=${(tBin - tStart).toFixed(0)}ms, ` +
            `decode+upload=${(tEnd - tBin).toFixed(0)}ms`,
    );
}

async function applyTextures(
    mountId: number,
    skn_path_hash_hex: string,
    skn: SknDTO,
    slots: SubmeshSlot[],
    loadedTextures: Map<string, { tex: RawTexture; hasAlpha: boolean }>,
    scene: Scene,
    isCancelled: () => boolean,
    refresh: () => void,
): Promise<void> {
    const tStart = performance.now();

    let map: SknTextureBindings | null;
    try {
        map = await invoke<SknTextureBindings | null>('wad_read_skin_textures', {
            id: mountId,
            pathHashHex: skn_path_hash_hex,
        });
    } catch (e) {
        console.warn('[MeshPreview] texture map fetch failed:', e);
        return;
    }
    if (isCancelled() || !map) return;
    const tBin = performance.now();

    console.log(
        `[MeshPreview] BIN: ${map.bin_path} | default: ${map.default_texture ?? '(none)'} | bindings: ${map.bindings.length}`
    );

    const bindingByName = new Map<string, TextureBinding>();
    for (const b of map.bindings) {
        bindingByName.set(b.material.toLowerCase(), b);
    }

    const indicesByHash = new Map<string, number[]>();
    for (let i = 0; i < skn.submeshes.length; i++) {
        const name = skn.submeshes[i].name.toLowerCase();
        const b = bindingByName.get(name);
        const hash = b?.chunk_hash_hex ?? map.default_chunk_hash_hex;
        if (!hash) continue;
        const slot = slots[i];
        if (slot) slot.chunkHash = hash;
        const list = indicesByHash.get(hash) ?? [];
        list.push(i);
        indicesByHash.set(hash, list);
    }

    if (indicesByHash.size === 0) {
        console.warn('[MeshPreview] no resolvable textures for any submesh');
        return;
    }

    // One IPC call per texture; Rust returns RGBA bytes directly via
    // tauri::ipc::Response, no JSON / base64 round-trip. See
    // `loadTextureFromHash` for the wire format.
    const totalsRef = { decode: 0, upload: 0 };
    let appliedCount = 0;
    const work = Array.from(indicesByHash.entries()).map(async ([hash, indices]) => {
        const d0 = performance.now();
        const decoded = await loadTextureFromHash(mountId, hash, scene);
        if (isCancelled()) return;
        totalsRef.decode = Math.max(totalsRef.decode, performance.now() - d0);
        if (!decoded) return;

        // Cache and refresh — refresh re-runs the active settings
        // (flat/lit, missing-style) over every slot so we don't have
        // to duplicate the application logic here.
        const u0 = performance.now();
        loadedTextures.set(hash, decoded);
        refresh();
        totalsRef.upload += performance.now() - u0;
        appliedCount += indices.length;
    });

    await Promise.allSettled(work);

    const tEnd = performance.now();
    console.log(
        `[MeshPreview] ${appliedCount}/${indicesByHash.size} texture(s) applied: ` +
            `bin=${(tBin - tStart).toFixed(0)}ms, ` +
            `decode(slowest)=${totalsRef.decode.toFixed(0)}ms, ` +
            `upload(total)=${totalsRef.upload.toFixed(0)}ms, ` +
            `total=${(tEnd - tStart).toFixed(0)}ms`,
    );
}

