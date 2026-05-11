/**
 * Per-frame ANM playback driver. Doesn't use Babylon's `Animation`
 * keyframe system — we own the time loop and write to each bone's
 * local TRS directly each tick.
 *
 * Why not `bone.updateMatrix(matrix)`:
 *   That call ALSO refreshes `_bindMatrix` and re-derives
 *   `_absoluteInverseBindMatrix` from it (Bone source line 374-398).
 *   The skinning shader uses `absoluteInverseBindMatrix * finalMatrix`,
 *   so overwriting bind every frame zeroes out the skinning math —
 *   `inverse(currentPose) * currentPose ≈ identity`. Result: bones move
 *   correctly but vertices stay at rest, model is stuck in T-pose
 *   regardless of how the bones are posed.
 *
 * Right approach: write to `bone.position`, `bone.rotationQuaternion`,
 * `bone.scaling`. Those are property setters that mutate
 * `_localPosition / _localRotation / _localScaling` and mark the bone
 * dirty for compose; the bind matrix is never touched. Babylon's
 * `_computeTransformMatrices` reads `getLocalMatrix()` per frame
 * (which composes from the TRS components) and combines it with the
 * pristine bind for skinning.
 */

import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math';
import type { Bone } from '@babylonjs/core/Bones/bone';
import type { SklJointDTO } from './skeletonBuilder';

export interface AnmFrameDTO {
    translation: [number, number, number];
    rotation: [number, number, number, number]; // xyzw
    scale: [number, number, number];
}

export interface AnmTrackDTO {
    joint_hash: number;
    frames: AnmFrameDTO[];
}

export interface BakedAnimationDTO {
    duration: number;
    fps: number;
    frame_count: number;
    tracks: AnmTrackDTO[];
}

/**
 * Owns one playing animation. Created when the user picks a clip,
 * disposed when they pick another or the preview unmounts.
 */
export class AnimationPlayer {
    private animation: BakedAnimationDTO;
    /// Tracks resolved to bone refs once at construction; the per-
    /// frame loop just iterates this array, no map lookups.
    private resolved: Array<{ bone: Bone; track: AnmTrackDTO }>;

    /** Current time in seconds. Mutated by `tick()`. */
    public time: number = 0;
    /** When true, stops the time advance — but `tick()` still applies
     *  the current frame so a paused player keeps the model posed. */
    public paused: boolean = false;
    /** When true, time wraps to 0 on reaching `duration`. */
    public loop: boolean = true;
    /** Playback speed multiplier. 1.0 = real-time. Scales `dt` inside
     *  `tick`. Negative values would play backwards but the picker
     *  doesn't expose them yet, so we don't special-case here. */
    public speed: number = 1;

    // Scratch allocations reused every tick — avoids GC pressure when
    // 200 bones × 60fps × 3 component setters = 36k allocations/sec.
    private _t = new Vector3();
    private _r = new Quaternion();
    private _s = new Vector3();
    private _ta = new Vector3();
    private _tb = new Vector3();
    private _ra = new Quaternion();
    private _rb = new Quaternion();
    private _sa = new Vector3();
    private _sb = new Vector3();

    constructor(
        animation: BakedAnimationDTO,
        boneIndexByHash: Map<number, number>,
        bones: Bone[],
        joints: SklJointDTO[],
    ) {
        this.animation = animation;
        this.resolved = [];
        for (const track of animation.tracks) {
            const idx = boneIndexByHash.get(track.joint_hash);
            if (idx === undefined) continue;
            const bone = bones[idx];
            if (!bone) continue;
            this.resolved.push({ bone, track });
        }

        // One-shot reset to rest pose — covers two cases:
        //   1. New player switching clips: bones may carry the old
        //      clip's last-frame pose; reset puts everything at rest
        //      so untracked bones don't visibly snap from the
        //      previous animation's leftover state.
        //   2. First play: the bone constructor already set local
        //      matrices to rest, so setting them here is redundant
        //      but harmless and keeps the invariant simple.
        resetSkeletonToRestPose(bones, joints);
    }

    /** Number of bones the active clip is actually driving. Useful as
     *  a sanity-check log line for "did we match any tracks?" */
    public get matchedTrackCount(): number {
        return this.resolved.length;
    }

    public get duration(): number {
        return this.animation.duration;
    }

    /**
     * Advance `time` by `dt` (seconds), interpolate every track at
     * the new time, and write the resulting TRS to each matched
     * bone's local components. Untracked bones aren't touched per
     * tick — they keep their constructor-time rest pose. Switching
     * clips re-runs the rest-pose write in the new player's
     * constructor, so a previously-driven-now-untracked bone
     * snaps back cleanly.
     */
    public tick(dt: number): void {
        // Clamp dt — Babylon's `getDeltaTime` can spike to whole
        // seconds when the tab is backgrounded then resumed, when
        // an IPC stalls the main thread, or after a GC pause. Loop-
        // mode would wrap modulo `duration` so we can't run away,
        // but the visible result is the bones snapping forward by a
        // big chunk in one frame. Cap to 50ms (≈20fps min) so any
        // single tick can only nudge the pose by a small amount.
        const clampedDt = Math.min(Math.max(dt, 0), 0.05);
        if (!this.paused) {
            // Scale dt by `speed` so 2x runs the clock twice as fast,
            // 0.5x half as fast. The interpolation loop downstream
            // doesn't care — it just samples at the new time.
            this.time += clampedDt * this.speed;
            const dur = this.animation.duration;
            if (dur > 0) {
                if (this.loop) {
                    this.time = ((this.time % dur) + dur) % dur;
                } else if (this.time > dur) {
                    this.time = dur;
                    this.paused = true;
                }
            } else {
                this.time = 0;
            }
        }

        const fc = this.animation.frame_count;
        if (fc === 0) return;
        const frameF = this.time * this.animation.fps;
        const frameA = Math.min(Math.floor(frameF), fc - 1);
        const frameB = Math.min(frameA + 1, fc - 1);
        const t = frameF - frameA;

        for (const { bone, track } of this.resolved) {
            const fa = track.frames[frameA];
            const fb = track.frames[frameB];
            this._ta.set(fa.translation[0], fa.translation[1], fa.translation[2]);
            this._tb.set(fb.translation[0], fb.translation[1], fb.translation[2]);
            Vector3.LerpToRef(this._ta, this._tb, t, this._t);

            this._sa.set(fa.scale[0], fa.scale[1], fa.scale[2]);
            this._sb.set(fb.scale[0], fb.scale[1], fb.scale[2]);
            Vector3.LerpToRef(this._sa, this._sb, t, this._s);

            this._ra.set(fa.rotation[0], fa.rotation[1], fa.rotation[2], fa.rotation[3]);
            this._rb.set(fb.rotation[0], fb.rotation[1], fb.rotation[2], fb.rotation[3]);
            Quaternion.SlerpToRef(this._ra, this._rb, t, this._r);

            // Property setters mutate `_localPosition` /
            // `_localRotation` / `_localScaling` and mark the bone
            // dirty for compose. The bind matrix isn't touched, so
            // skinning's `inverseBindMatrix * finalMatrix` math
            // still references the rest pose's inverse-bind.
            bone.position = this._t;
            bone.rotationQuaternion = this._r;
            bone.scaling = this._s;
        }
    }

    /** Rewind to the start. Useful for "play from beginning" buttons. */
    public reset(): void {
        this.time = 0;
        this.paused = false;
    }
}

/**
 * Snap every bone in `bones` back to its SKL bind-pose local TRS.
 * Used by `AnimationPlayer`'s constructor (when switching clips) and
 * by the "unload animation" path in `MeshPreview` (so the model
 * returns to its T-pose visually).
 *
 * Uses the property setters — NEVER `updateMatrix` — to avoid
 * stomping `_bindMatrix`. See file header for why.
 */
export function resetSkeletonToRestPose(bones: Bone[], joints: SklJointDTO[]): void {
    const restT = new Vector3();
    const restR = new Quaternion();
    const restS = new Vector3();
    for (let i = 0; i < bones.length; i++) {
        const j = joints[i];
        const b = bones[i];
        if (!j || !b) continue;
        restT.set(j.local_translation[0], j.local_translation[1], j.local_translation[2]);
        restR.set(
            j.local_rotation[0],
            j.local_rotation[1],
            j.local_rotation[2],
            j.local_rotation[3],
        );
        restS.set(j.local_scale[0], j.local_scale[1], j.local_scale[2]);
        b.position = restT;
        b.rotationQuaternion = restR;
        b.scaling = restS;
    }
}
