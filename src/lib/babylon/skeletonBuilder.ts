/**
 * Convert a parsed SKL DTO into a single Babylon `LinesMesh` that draws
 * one line per parent→child bone link.
 *
 * Why a single LinesMesh instead of one per bone:
 *   - Cheaper draw calls — every bone goes in one indexed line buffer.
 *   - `setEnabled(true/false)` toggles the entire skeleton in one call,
 *     which is exactly what the visibility checkbox wants.
 *   - We don't need per-bone picking yet. If/when we do (e.g. clicking
 *     a bone to inspect it), we can add a parallel pickable spheres
 *     mesh without rewriting the line system.
 *
 * Coordinate-system note (mirrors `meshBuilder.ts`):
 *   League SKL is left-handed Y-up. Babylon's default is also LH Y-up,
 *   so positions pass through unchanged. If we ever discover a mirrored
 *   skeleton we can flip X here in one place.
 */

import { CreateLineSystem } from '@babylonjs/core/Meshes/Builders/linesBuilder';
import { CreateSphere } from '@babylonjs/core/Meshes/Builders/sphereBuilder';
import type { LinesMesh } from '@babylonjs/core/Meshes/linesMesh';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3, Color3, Color4, Matrix, Quaternion } from '@babylonjs/core/Maths/math';
import type { Scene } from '@babylonjs/core/scene';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';

// Allocated once at module load — Babylon's Quat constructor isn't
// free and we'd otherwise call it per joint. Reused across every
// `buildSkeletonJoints` invocation since it's read-only.
const _IDENTITY_QUAT = Quaternion.Identity();

export interface SklJointDTO {
    name: string;
    id: number;
    parent_id: number;
    /** ELF hash of the lowercased bone name. Matches `joint_hash` on
     *  ANM tracks, so the animation player can look up "which bone is
     *  this track for" in O(1) without going through the name. */
    name_hash: number;
    radius: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];
    local_scale: [number, number, number];
    world_position: [number, number, number];
}

export interface SklSkeletonDTO {
    name: string;
    asset_name: string;
    flags: number;
    joints: SklJointDTO[];
    influences: number[];
}

export interface BuiltSkeleton {
    /** Single line system covering every parent→child bone link. */
    lines: LinesMesh;
    /** AABB of joint world positions. Used by the standalone-SKL camera
     *  to frame the bones when no mesh is in the scene. */
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Build the bone-link line mesh. Returns `null` for empty skeletons —
 * caller can decide whether that's an error or just nothing to show.
 */
export function buildSkeletonLines(
    skl: SklSkeletonDTO,
    scene: Scene,
    options?: {
        /** Line color. Defaults to a desaturated cyan that reads well
         *  over both light and dark theme backgrounds. */
        color?: Color3;
        name?: string;
    },
): BuiltSkeleton | null {
    const joints = skl.joints;
    if (joints.length === 0) return null;

    // One line segment per non-root joint: parent.world_position →
    // joint.world_position. Roots (parent_id < 0) are visible only
    // through their children.
    const lines: Vector3[][] = [];
    const colors: Color4[][] = [];
    const baseColor = options?.color ?? new Color3(0.55, 0.85, 1.0);
    const segColor = new Color4(baseColor.r, baseColor.g, baseColor.b, 1.0);

    for (const joint of joints) {
        if (joint.parent_id < 0) continue;
        const parent = joints[joint.parent_id];
        if (!parent) continue;
        lines.push([
            new Vector3(...parent.world_position),
            new Vector3(...joint.world_position),
        ]);
        // Per-line colors keep us future-proof for per-bone tinting
        // (e.g. selection highlight). For now every segment is the
        // same color but we still emit two endpoints because Babylon's
        // CreateLineSystem requires color arrays to mirror line shape.
        colors.push([segColor, segColor]);
    }

    // Babylon's `useVertexAlpha = false` skips the per-vertex alpha
    // channel — we don't need transparency on the line itself, and
    // disabling vertex alpha lets the lines render slightly faster
    // and more crisply against transparent backbuffers.
    const linesMesh = CreateLineSystem(
        options?.name ?? 'skeleton',
        { lines, colors, useVertexAlpha: false, updatable: false },
        scene,
    );

    // Always render bones on top of the mesh. `renderingGroupId = 1`
    // pushes them to a separate render queue Babylon clears the depth
    // buffer for, which is the canonical way to do "draw lines through
    // geometry" overlays without z-fighting.
    linesMesh.renderingGroupId = 1;
    // Disable depth testing so faraway bones (e.g. inside a leg) are
    // still visible — this is the standard "wireframe overlay" look.
    linesMesh.isPickable = false;

    // AABB from the joint cloud, finiteness-guarded. Same defensive
    // shape we use in MeshPreview — guards against a malformed skeleton
    // poisoning the camera framing math with NaN/Infinity.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const j of joints) {
        const [x, y, z] = j.world_position;
        if (Number.isFinite(x)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
        }
        if (Number.isFinite(y)) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        if (Number.isFinite(z)) {
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }
    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    return {
        lines: linesMesh,
        bbox: {
            min: [finite(minX), finite(minY), finite(minZ)],
            max: [finite(maxX), finite(maxY), finite(maxZ)],
        },
    };
}

export interface BuiltOctaSkeleton {
    /** Single batched mesh containing every bone's octahedron. */
    mesh: Mesh;
    /** Same AABB as the line variant — covers joint cloud only. */
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Build the Blender-style octahedral bone variant: each parent→child
 * link becomes a 6-vertex stretched octahedron oriented along the bone
 * axis. All bones live in one batched `Mesh` so the whole skeleton
 * draws in a single draw call and toggles in a single `setEnabled`.
 *
 * Geometry per bone (in bone-local space, +Y from head to tail):
 *
 * ```text
 *      v0  ← head apex (parent position)
 *     /│\
 *    / │ \
 *   v1─┼──v2     ring at y = ringHeight, on a square cross-section
 *    \ │ /          v1 = (+r, h, 0), v2 = (0, h, +r),
 *     v│v           v3 = (-r, h, 0), v4 = (0, h, -r)
 *     ...
 *      │            (long taper from ring down to tail)
 *      v5  ← tail apex (child position)
 * ```
 *
 * `r = h = 0.1 × bone_length` matches Blender's default proportions.
 * 8 triangles per bone (4 head fan + 4 tail fan). Normals are
 * recomputed by Babylon from face geometry — way more reliable than
 * trying to hand-author them and matches what we do for SKN meshes.
 *
 * Material is StandardMaterial (not PBR): bones don't need physically-
 * accurate shading, the lit hemispheric light is enough to read shape,
 * and StandardMaterial costs less than PBR for thousands of polys we
 * don't care about. Two-sided so the user can orbit underneath the
 * skeleton without bones disappearing.
 */
export function buildSkeletonOctahedrons(
    skl: SklSkeletonDTO,
    scene: Scene,
    options?: { color?: Color3; name?: string },
): BuiltOctaSkeleton | null {
    const joints = skl.joints;
    if (joints.length === 0) return null;

    // 8 triangles × 3 indices = 24 indices per bone; 6 verts per bone.
    // Pre-allocate so we don't realloc as we walk the joint list.
    const positions: number[] = [];
    const indices: number[] = [];

    // Bone-local octahedron template, before scale + orientation. The
    // last entry on each line is the index in the per-bone vertex list
    // (head=0, ring=1..4, tail=5) — used for the index template below.
    const TRIS: ReadonlyArray<readonly [number, number, number]> = [
        // Head fan — winding picked so outward normal of each face
        // points away from the ring axis when viewed from outside.
        [0, 2, 1],
        [0, 3, 2],
        [0, 4, 3],
        [0, 1, 4],
        // Tail fan
        [5, 1, 2],
        [5, 2, 3],
        [5, 3, 4],
        [5, 4, 1],
    ];

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const head = new Vector3();
    const tail = new Vector3();
    const dir = new Vector3();
    const right = new Vector3();
    const up = new Vector3();
    const upRef = new Vector3();
    const upRefAlt = new Vector3();

    for (const joint of joints) {
        if (joint.parent_id < 0) continue;
        const parent = joints[joint.parent_id];
        if (!parent) continue;

        head.set(...parent.world_position);
        tail.set(...joint.world_position);
        dir.copyFrom(tail).subtractInPlace(head);
        const length = dir.length();
        // Skip degenerate bones (parent == child position) — they'd
        // produce zero-length vectors and NaN normals. Visually
        // they'd contribute nothing anyway.
        if (length < 1e-6) continue;
        dir.scaleInPlace(1 / length);

        // Build a stable orthonormal basis around the bone direction.
        // Pick the world up vector farthest from the bone axis as the
        // "up reference"; cross-product against it for `right`. Without
        // this fallback, near-vertical bones (running along ±Y) would
        // get a near-zero `right` and produce NaN normals.
        upRef.set(0, 1, 0);
        upRefAlt.set(1, 0, 0);
        const useAlt = Math.abs(Vector3.Dot(dir, upRef)) > 0.9;
        const ref = useAlt ? upRefAlt : upRef;
        Vector3.CrossToRef(ref, dir, right);
        right.normalize();
        Vector3.CrossToRef(dir, right, up);
        up.normalize();

        // Blender's classic octahedron: ring sits 10% along the bone
        // length, with radius matching that height so the cross-
        // section is roughly equilateral against the bone. Looks
        // correct without any user-tunable size param.
        const ringY = length * 0.1;
        const r = length * 0.1;

        // Project each of the 6 local octahedron vertices into world
        // space using the basis. `world = head + dx*right + dy*dir + dz*up`.
        // We push positions in the same head/ring/tail order the
        // index template (TRIS) refers to.
        const baseIndex = positions.length / 3;
        const pushVert = (lx: number, ly: number, lz: number) => {
            const x = head.x + lx * right.x + ly * dir.x + lz * up.x;
            const y = head.y + lx * right.y + ly * dir.y + lz * up.y;
            const z = head.z + lx * right.z + ly * dir.z + lz * up.z;
            positions.push(x, y, z);
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        };

        pushVert(0, 0, 0);            // v0 — head apex
        pushVert(r, ringY, 0);        // v1 — +right ring
        pushVert(0, ringY, r);        // v2 — +up ring
        pushVert(-r, ringY, 0);       // v3 — -right ring
        pushVert(0, ringY, -r);       // v4 — -up ring
        pushVert(0, length, 0);       // v5 — tail apex

        for (const [a, b, c] of TRIS) {
            indices.push(baseIndex + a, baseIndex + b, baseIndex + c);
        }
    }

    if (positions.length === 0) return null;

    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);

    const vd = new VertexData();
    vd.positions = positions;
    vd.indices = indices;
    vd.normals = normals;

    const mesh = new Mesh(options?.name ?? 'skeleton-octa', scene);
    vd.applyToMesh(mesh);
    mesh.isPickable = false;

    // StandardMaterial gives us simple lit shading without paying for
    // PBR's full BRDF stack. The hemispheric light in MeshPreview is
    // enough to make octahedron faces read clearly. Slight emissive
    // baseline so the skeleton doesn't go nearly-black when the
    // camera tilts toward the light's "shadow" hemisphere.
    const baseColor = options?.color ?? new Color3(0.85, 0.85, 0.9);
    const mat = new StandardMaterial(`${options?.name ?? 'skeleton-octa'}-mat`, scene);
    mat.diffuseColor = baseColor;
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = baseColor.scale(0.25);
    mat.backFaceCulling = false;
    mat.twoSidedLighting = true;
    mesh.material = mat;

    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    return {
        mesh,
        bbox: {
            min: [finite(minX), finite(minY), finite(minZ)],
            max: [finite(maxX), finite(maxY), finite(maxZ)],
        },
    };
}

export interface BuiltJointMarkers {
    /** Single sphere mesh, drawn once per joint via thin-instances. */
    mesh: Mesh;
    /** Same AABB shape as the other variants — for camera framing. */
    bbox: { min: [number, number, number]; max: [number, number, number] };
}

/**
 * Build the Maya-style joint markers: a small sphere at every joint
 * world position, drawn through Babylon's thin-instance API so the
 * whole batch is one draw call regardless of joint count. Pairs with
 * `buildSkeletonLines` to give the classic Maya look — visible joint
 * pivots with thin connectors between them.
 *
 * Sphere radius scales with the skeleton's bbox diagonal (default
 * 0.6%) so the markers read at roughly the same visual weight whether
 * the model is 200 units tall or 2 units tall. Caller can override via
 * `options.radius` for a fixed-world-units sphere.
 */
export function buildSkeletonJoints(
    skl: SklSkeletonDTO,
    scene: Scene,
    options?: { color?: Color3; name?: string; radius?: number },
): BuiltJointMarkers | null {
    const joints = skl.joints;
    if (joints.length === 0) return null;

    // Pre-compute the joint cloud bbox so we can both report it AND
    // size the sphere relative to the skeleton's overall extent.
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (const j of joints) {
        const [x, y, z] = j.world_position;
        if (Number.isFinite(x)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
        }
        if (Number.isFinite(y)) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
        }
        if (Number.isFinite(z)) {
            if (z < minZ) minZ = z;
            if (z > maxZ) maxZ = z;
        }
    }
    const finite = (n: number) => (Number.isFinite(n) ? n : 0);
    const bboxMin: [number, number, number] = [finite(minX), finite(minY), finite(minZ)];
    const bboxMax: [number, number, number] = [finite(maxX), finite(maxY), finite(maxZ)];

    // 0.48% of the bbox diagonal lands on a Maya-ish marker size for
    // typical League skeletons that doesn't visually overpower the
    // mesh. Floor at 0.04 so bbox-zero degenerate cases still produce
    // a visible sphere rather than a singular zero-scale instance.
    const dx = bboxMax[0] - bboxMin[0];
    const dy = bboxMax[1] - bboxMin[1];
    const dz = bboxMax[2] - bboxMin[2];
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const radius = options?.radius ?? Math.max(0.04, diagonal * 0.0048);

    // Source sphere — kept low-poly because joint markers don't need
    // smooth silhouettes at typical viewer zoom and high segment counts
    // multiply by `joints.length` in vertex memory after instancing
    // expands them on the GPU.
    const sphere = CreateSphere(
        options?.name ?? 'skeleton-joints',
        { diameter: 2, segments: 8 },
        scene,
    );
    sphere.isPickable = false;

    // Thin instance buffer — 16 floats per joint (one 4x4 matrix).
    // Each instance is a translation to the joint's world position
    // composed with a uniform scale to the sphere radius. Rotation is
    // identity since spheres are symmetric.
    const matrices = new Float32Array(joints.length * 16);
    const tmp = Matrix.Identity();
    const scaleVec = new Vector3(radius, radius, radius);
    const posVec = new Vector3();
    for (let i = 0; i < joints.length; i++) {
        posVec.set(...joints[i].world_position);
        Matrix.ComposeToRef(scaleVec, _IDENTITY_QUAT, posVec, tmp);
        tmp.copyToArray(matrices, i * 16);
    }
    sphere.thinInstanceSetBuffer('matrix', matrices, 16);

    // Same emissive-baseline shading trick as the octahedron variant —
    // keeps spheres readable from every camera angle without paying
    // for PBR. Default color matches the lines color so joints visually
    // belong to the same skeleton when both are visible.
    const baseColor = options?.color ?? new Color3(0.55, 0.85, 1.0);
    const mat = new StandardMaterial(`${options?.name ?? 'skeleton-joints'}-mat`, scene);
    mat.diffuseColor = baseColor;
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = baseColor.scale(0.4);
    mat.backFaceCulling = false;
    sphere.material = mat;

    return {
        mesh: sphere,
        bbox: { min: bboxMin, max: bboxMax },
    };
}

// ── Babylon Skeleton (for skinning + animation) ────────────────────

export interface BuiltBabylonSkeleton {
    /** The Skeleton object — attach to meshes via `mesh.skeleton`. */
    skeleton: Skeleton;
    /** Parallel arrays — `bones[i]` is the Babylon Bone for SKL joint
     *  `i`, and `joints[i]` is the SKL DTO entry. The animation
     *  player walks both in lockstep when applying tracks. */
    bones: Bone[];
    joints: SklJointDTO[];
    /** Map from SKL joint name_hash to bone index. ANM tracks key on
     *  the same hash so the player resolves a track to its bone in a
     *  single Map lookup. */
    boneIndexByHash: Map<number, number>;
}

/**
 * Build a Babylon `Skeleton` from a parsed SKL DTO.
 *
 * Each bone gets a `localMatrix` composed from the SKL joint's local
 * TRS — that becomes the bone's rest pose. Babylon's `Bone`
 * constructor computes `_absoluteTransform` and its inverse from
 * `parent._absoluteTransform * localMatrix`. That inverse is the
 * inverse-bind matrix the skinning shader uses — so the parent has
 * to exist with a correct absolute transform AT THE MOMENT the bone
 * is constructed.
 *
 * SKL joint order isn't guaranteed parent-before-child (custom rigs
 * append bones whose parent index points later in the list), so we
 * resolve order recursively-with-memoisation: each `ensure(i)` walks
 * up to the root, creating parents first, then constructs joint `i`
 * with the right parent reference. Cycle bound = joint count, same
 * defensive shape we use in the SKL world-position composer.
 */
export function buildBabylonSkeleton(
    skl: SklSkeletonDTO,
    scene: Scene,
    name: string = 'skeleton',
): BuiltBabylonSkeleton {
    // Skeleton id needs to be unique across the scene — collisions
    // break shared-skeleton lookups when multiple previews mount at
    // once.
    const skeleton = new Skeleton(name, `${name}-${Date.now()}`, scene);

    const bones: Array<Bone | null> = new Array(skl.joints.length).fill(null);
    const boneIndexByHash = new Map<number, number>();

    const ensure = (i: number, depth: number): Bone | null => {
        if (bones[i]) return bones[i];
        if (depth > skl.joints.length) {
            console.warn(
                `[skeleton] cyclic parent chain at joint ${i} — orphaning bone`,
            );
            return null;
        }
        const j = skl.joints[i];
        const parent =
            j.parent_id >= 0 && j.parent_id < skl.joints.length
                ? ensure(j.parent_id, depth + 1)
                : null;
        const localMatrix = composeTrsMatrix(
            j.local_translation,
            j.local_rotation,
            j.local_scale,
        );
        // 7th constructor arg is `index`. Babylon writes each bone's
        // final-matrix into `targetMatrix[index * 16]` during
        // skinning prep, and SKN `matricesIndices` values reference
        // that same slot. We pin `index = i` (SKL joint position) so
        // SKN bone references resolve to the right GPU matrix slot
        // regardless of construction order — `skeleton.bones` ends
        // up in topological order, but the underlying GPU array is
        // SKL-ordered.
        const bone = new Bone(
            j.name,
            skeleton,
            parent,
            localMatrix,
            /* restPose */ undefined,
            /* baseMatrix */ undefined,
            /* index */ i,
        );
        bones[i] = bone;
        boneIndexByHash.set(j.name_hash, i);
        return bone;
    };
    for (let i = 0; i < skl.joints.length; i++) {
        ensure(i, 0);
    }

    return {
        skeleton,
        bones: bones as Bone[],
        joints: skl.joints,
        boneIndexByHash,
    };
}

/**
 * Compose a 4×4 matrix from translation + rotation (xyzw) + scale,
 * matching what Babylon's Bone wants for `localMatrix`. Pulled out so
 * the animation player can reuse it when applying per-frame TRS.
 */
export function composeTrsMatrix(
    translation: [number, number, number],
    rotationXyzw: [number, number, number, number],
    scale: [number, number, number],
): Matrix {
    return Matrix.Compose(
        new Vector3(scale[0], scale[1], scale[2]),
        new Quaternion(rotationXyzw[0], rotationXyzw[1], rotationXyzw[2], rotationXyzw[3]),
        new Vector3(translation[0], translation[1], translation[2]),
    );
}
