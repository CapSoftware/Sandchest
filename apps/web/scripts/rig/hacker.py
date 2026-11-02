"""
The hacker at the desk, baked to `apps/web/public/rig/hacker.glb`.

The figure is Microsoft Rocketbox's Male_Adult_18 (MIT licence,
github.com/microsoft/Microsoft-Rocketbox): a professionally modelled man in
a knit hoodie with the hood up, with its textures. It is posed from the
library's own "sitting at a table" animation, retargeted bone by bone, then
leaned in towards the screen, with the arms solved onto the keyboard, hands
turned palms-down and fingers curled onto the keys. The posed mesh is baked
and exported with its textures; positions come out in the scene's
coordinates (metres; the desk top is y = 0, the laptop at the origin, the
hacker facing -z).

    blender -b --python apps/web/scripts/rig/hacker.py -- /tmp/hacker.glb
    bunx @gltf-transform/cli optimize /tmp/hacker.glb apps/web/public/rig/hacker.glb \
        --compress meshopt --simplify false --texture-compress webp --texture-size 1024

`--preview /tmp/hacker` instead of an output path renders close-ups of the
pose (textured, and plain grey for checking the geometry) next to stand-ins
for the desk, laptop and chair.

The avatar's files are downloaded on first run into ~/.cache/sandchest-rig.
"""

import math
import os
import sys
import urllib.request

import bpy
from mathutils import Matrix, Vector

ARGS = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
PREVIEW = ARGS[1] if ARGS[:1] == ["--preview"] else None
EXPORT = None if PREVIEW else (ARGS[0] if ARGS else "/tmp/hacker.glb")

REPO = "https://raw.githubusercontent.com/microsoft/Microsoft-Rocketbox/master/Assets"
AVATAR = "Male_Adult_18"
FILES = {
    f"{AVATAR}.fbx": f"{REPO}/Avatars/Adults/{AVATAR}/Export/{AVATAR}.fbx",
    **{f"m023_{t}.tga": f"{REPO}/Avatars/Adults/{AVATAR}/Textures/m023_{t}.tga" for t in ("body_color", "body_normal", "body_specular", "head_color", "head_normal", "head_specular")},
    "sit.fbx": f"{REPO}/Animations/all_animations_max_motextr_static/m_sit_table_breathe_01.max.fbx",
}
CACHE = os.path.expanduser("~/.cache/sandchest-rig")

SEAT = (0, -0.12, 0.6)  # where the pelvis sits, in the scene
LEAN = [("Bip01 Spine", 0.08), ("Bip01 Spine1", 0.1), ("Bip01 Spine2", 0.08), ("Bip01 Neck", 0.08), ("Bip01 Head", 0.12)]
HAND = (0.105, 0.052, 0.1)  # the wrists, on the laptop's palm rest (x mirrored)
ELBOW = (0.4, -0.5, 0.4)  # which way the elbows point: out and down (x mirrored)
CURL = 0.38  # radians per finger joint: arched, not clawed
FAN = 0.35  # how much the fingers spread from the hand's own line (0 parallel, 1 fully fanned)
SLOPE = 0.0  # how far the back of the hand falls towards the knuckles
KEYS = 0.019  # the key tops' height


def scene(x, y, z):
    """Scene coordinates (y up, the hacker faces -z) to Blender's (z up)."""
    return Vector((x, -z, y))


def fetch():
    os.makedirs(CACHE, exist_ok=True)
    for name, url in FILES.items():
        path = os.path.join(CACHE, name)
        if not os.path.exists(path):
            print("fetching", url)
            urllib.request.urlretrieve(url, path)
    return {name: os.path.join(CACHE, name) for name in FILES}


files = fetch()
bpy.ops.wm.read_factory_settings(use_empty=True)

# ---- The avatar, sitting -------------------------------------------------------------------

bpy.ops.import_scene.fbx(filepath=files[f"{AVATAR}.fbx"])
rig = next(o for o in bpy.context.scene.objects if o.type == "ARMATURE")
body = next(o for o in bpy.context.scene.objects if o.type == "MESH")
# The avatar file carries its own take, which would re-pose it on every frame change.
if rig.animation_data:
    rig.animation_data_clear()

before = set(bpy.data.objects)
bpy.ops.import_scene.fbx(filepath=files["sit.fbx"])
imported = [o for o in bpy.data.objects if o not in before]
source = next(o for o in imported if o.type == "ARMATURE")
bpy.context.scene.frame_set(int(source.animation_data.action.frame_range[0]))

pb = rig.pose.bones


def depth(bone):
    return 0 if bone.parent is None else 1 + depth(bone.parent)


def keep_pose():
    """Freeze whatever the constraints did into the pose itself, and drop the constraints."""
    bpy.context.view_layer.update()
    posed = {bone.name: bone.matrix.copy() for bone in pb}
    for bone in pb:
        while bone.constraints:
            bone.constraints.remove(bone.constraints[0])
    for bone in sorted(pb, key=depth):
        bone.matrix = posed[bone.name]
        bpy.context.view_layer.update()


# The animation's bones are oriented differently from the avatar's, so copy each bone's
# rotation in world space (and the pelvis's position).
for bone in pb:
    if bone.name in source.pose.bones:
        c = bone.constraints.new("COPY_ROTATION")
        c.target, c.subtarget, c.target_space, c.owner_space = source, bone.name, "WORLD", "WORLD"
        if bone.name == "Bip01 Pelvis":
            c = bone.constraints.new("COPY_LOCATION")
            c.target, c.subtarget, c.target_space, c.owner_space = source, bone.name, "WORLD", "WORLD"
keep_pose()
for obj in imported:
    bpy.data.objects.remove(obj, do_unlink=True)


def world(point):
    return rig.matrix_world @ point


def head_of(name):
    return world(pb[name].head)


def rotate(name, axis, angle):
    """Turn a pose bone about a world-space axis through its head."""
    bone = pb[name]
    bpy.context.view_layer.update()
    pivot = world(bone.head)
    turn = Matrix.Translation(pivot) @ Matrix.Rotation(angle, 4, Vector(axis)) @ Matrix.Translation(-pivot)
    bone.matrix = rig.matrix_world.inverted() @ turn @ rig.matrix_world @ bone.matrix
    bpy.context.view_layer.update()


# Face the laptop (Blender +y is the scene's -z) and sit on the chair.
rig.rotation_euler.z += math.pi
bpy.context.view_layer.update()
rig.location += scene(*SEAT) - head_of("Bip01 Pelvis")
bpy.context.view_layer.update()

# Lean in towards the screen.
for name, angle in LEAN:
    rotate(name, (1, 0, 0), -angle)

# Arms: a two-bone solve from the shoulder to the wrist on the palm rest, elbows out and down.
# Bone tails in an imported FBX point anywhere, so this works only with joint positions.
def turn(name, frm, to):
    """Turn a bone about its head so the direction `frm` becomes `to` (world space)."""
    axis, angle = frm.rotation_difference(to).to_axis_angle()
    if angle > 1e-6:
        rotate(name, axis, angle)


for side, sx in (("L", -1), ("R", 1)):
    upper, fore, hand = f"Bip01 {side} UpperArm", f"Bip01 {side} Forearm", f"Bip01 {side} Hand"
    shoulder, elbow, wrist = head_of(upper), head_of(fore), head_of(hand)
    a, b = (elbow - shoulder).length, (wrist - elbow).length
    target = scene(HAND[0] * sx, HAND[1], HAND[2])
    pole = scene(ELBOW[0] * sx, ELBOW[1], ELBOW[2])
    reach = target - shoulder
    d = min(reach.length, (a + b) * 0.999)
    n = reach.normalized()
    out = (pole - shoulder) - n * (pole - shoulder).dot(n)
    out.normalize()
    cos = (a * a + d * d - b * b) / (2 * a * d)
    want_elbow = shoulder + n * a * cos + out * a * math.sqrt(max(0.0, 1 - cos * cos))
    turn(upper, elbow - shoulder, want_elbow - shoulder)
    elbow, wrist = head_of(fore), head_of(hand)
    turn(fore, wrist - elbow, shoulder + n * d - elbow)

# Palms down: turn each hand about the forearm's axis until the knuckles lie level and the
# fingers point at the screen, thumb on the inside.
for side, sx in (("L", -1), ("R", 1)):
    hand = pb[f"Bip01 {side} Hand"]
    fore = pb[f"Bip01 {side} Forearm"]
    axis = (head_of(hand.name) - head_of(fore.name)).normalized()
    start = hand.matrix.copy()
    best = None
    for step in range(72):
        hand.matrix = start
        rotate(hand.name, axis, step * math.tau / 72)
        knuckles = head_of(f"Bip01 {side} Finger1") - head_of(f"Bip01 {side} Finger4")
        thumb_in = -sx * (head_of(f"Bip01 {side} Finger0").x - head_of(f"Bip01 {side} Finger4").x) > 0
        score = abs(knuckles.normalized().z) - (0.5 if thumb_in else 0)
        if best is None or score < best[0]:
            best = (score, step * math.tau / 72)
    hand.matrix = start
    rotate(hand.name, axis, best[1])
    # Point the hand at the keys, mostly forward and turned in a little, not across at the other hand.
    reach = head_of(f"Bip01 {side} Finger2") - head_of(hand.name)
    want = Vector((-sx * math.sin(math.radians(14)), math.cos(math.radians(14)), 0))
    have = Vector((reach.x, reach.y, 0)).normalized()
    rotate(hand.name, (0, 0, 1), math.atan2(have.cross(want).z, have.dot(want)))
    # Then flatten the wrist: tip the hand about the knuckle line until the fingers run level.
    across = (head_of(f"Bip01 {side} Finger1") - head_of(f"Bip01 {side} Finger4")).normalized()
    best = None
    start = hand.matrix.copy()
    for step in range(-30, 31):
        hand.matrix = start
        rotate(hand.name, across, step * 0.04)
        reach = (head_of(f"Bip01 {side} Finger2") - head_of(hand.name)).normalized()
        if best is None or abs(reach.z + SLOPE) < best[0]:
            best = (abs(reach.z + SLOPE), step * 0.04)
    hand.matrix = start
    rotate(hand.name, across, best[1])

# Fingers: aimed one segment at a time, since neither the sitting take (hands clasped) nor
# the rest pose leaves them open. Each finger points mostly where the hand points, fanned a
# little, and arches down onto the keys: every joint bends by the same amount, and the
# knuckle's angle is chosen so the fingertip just touches the keys. The last segment has no
# bone after it to aim at, so it keeps the rest pose's line from the one before; its length
# is guessed from the middle one.
def bend(vector, across, angle):
    """`vector` turned about `across` by `angle`; positive angles lower it."""
    lower = (Matrix.Rotation(0.1, 3, across) @ vector).z < vector.z
    return Matrix.Rotation(angle if lower else -angle, 3, across) @ vector


def straighten(name):
    bone = pb[name]
    bone.rotation_mode = "QUATERNION"
    bone.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.view_layer.update()


for side in ("L", "R"):
    wrist = head_of(f"Bip01 {side} Hand")
    across = (head_of(f"Bip01 {side} Finger1") - head_of(f"Bip01 {side} Finger4")).normalized()
    forward = (head_of(f"Bip01 {side} Finger2") - wrist).normalized()
    for f in range(1, 5):
        root, middle, tip = (f"Bip01 {side} Finger{f}{suffix}" for suffix in ("", "1", "2"))
        straighten(tip)
        line = ((head_of(root) - wrist).normalized() * FAN + forward * (1 - FAN)).normalized()
        lengths = ((head_of(middle) - head_of(root)).length, (head_of(tip) - head_of(middle)).length)
        lengths += (lengths[1] * 0.85,)
        knuckle = head_of(root)
        best = None
        for step in range(0, 40):
            base = step * 0.025
            point = knuckle.copy()
            for k, length in enumerate(lengths):
                point = point + bend(line, across, base + CURL * k) * length
            miss = abs(point.z - scene(0, KEYS, 0).z)
            if best is None or miss < best[0]:
                best = (miss, base)
        for k, (segment, child) in enumerate(((root, middle), (middle, tip))):
            turn(segment, head_of(child) - head_of(segment), bend(line, across, best[1] + CURL * k))

# The thumbs rest on the space bar's end: down and in from the base of the index finger.
for side, sx in (("L", -1), ("R", 1)):
    base, middle, tip = (f"Bip01 {side} Finger0{suffix}" for suffix in ("", "1", "2"))
    straighten(middle)
    straighten(tip)
    rest = scene(sx * 0.055, KEYS + 0.004, -0.005)
    turn(base, head_of(middle) - head_of(base), (rest - head_of(base)).normalized())

# The face's frame, for the visor the scene puts over it (FACE in src/components/rig/figure.tsx).
eyes = (head_of("Bip01 LEye") + head_of("Bip01 REye")) / 2
right = (head_of("Bip01 REye") - head_of("Bip01 LEye")).normalized()
up = eyes - head_of("Bip01 MJaw")
up = (up - right * up.dot(right)).normalized()
forward = up.cross(right).normalized()
if forward.dot(head_of("Bip01 MNose") - eyes) < 0:
    forward = -forward
def out(v):
    return [round(c, 4) for c in (v.x, v.z, -v.y)]
print("FACE eyes", out(eyes), "forward", out(forward), "up", out(up), "eye gap", round((head_of("Bip01 REye") - head_of("Bip01 LEye")).length, 4),
      "jaw", out(head_of("Bip01 MJaw")), "nose", out(head_of("Bip01 MNose")))
for name in ("Bip01 Head", "Bip01 L Hand", "Bip01 R Hand", "Bip01 L Finger2", "Bip01 R Finger2"):
    h = head_of(name)
    print("BONE", name, [round(v, 3) for v in (h.x, h.z, -h.y)])

# ---- Export ----------------------------------------------------------------------------------

if EXPORT:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(body.evaluated_get(depsgraph), depsgraph=depsgraph)
    mesh.transform(body.matrix_world)
    mesh.name = "hacker"
    baked = bpy.data.objects.new("hacker", mesh)
    bpy.context.scene.collection.objects.link(baked)
    for obj in bpy.context.scene.objects:
        obj.select_set(obj == baked)
    bpy.ops.export_scene.gltf(filepath=EXPORT, export_format="GLB", use_selection=True, export_apply=True, export_materials="EXPORT",
                              export_texcoords=True, export_normals=True, export_yup=True, export_animations=False, export_skins=False,
                              export_morph=False)
    print("EXPORTED", EXPORT, len(mesh.polygons), "faces")
    raise SystemExit(0)

# ---- Preview ---------------------------------------------------------------------------------


def stand_in(centre, size, tilt=0.0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=scene(*centre))
    obj = bpy.context.object
    obj.scale = (size[0], size[2], size[1])
    obj.rotation_euler = (tilt, 0, 0)


stand_in((0, -0.0225, -0.12), (1.9, 0.045, 1.02))  # desk
stand_in((0, 0.007, 0), (0.31, 0.014, 0.215))  # laptop
stand_in((0, 0.1, -0.14), (0.31, 0.205, 0.0055), math.radians(17))  # lid
stand_in((0, -0.3, 0.6), (0.5, 0.07, 0.46))  # seat
stand_in((0, -0.04, 0.77), (0.46, 0.46, 0.06))  # chair back

s = bpy.context.scene
s.render.resolution_x, s.render.resolution_y = 900, 600
sky = bpy.data.worlds.new("sky")
sky.color = (0.35, 0.35, 0.35)
s.world = sky
sun = bpy.data.objects.new("sun", bpy.data.lights.new("sun", "SUN"))
sun.data.energy = 3
sun.rotation_euler = (0.7, 0.3, 0.9)
s.collection.objects.link(sun)
views = {
    "resting": ((1.55, 0.55, 1.15), (-0.08, 0.2, 0.12), 30),
    "front": ((0.26, 0.3, -0.76), (0, 0.33, 0.42), 32),
    "side": ((1.6, 0.2, 0.4), (0, 0.0, 0.4), 45),
    "back": ((0, 0.6, 1.35), (0, 0.32, 0.55), 32),
    "wrist": ((0.55, 0.12, 0.18), (0.1, 0.05, 0.2), 30),
    "hands": ((0.35, 0.45, -0.15), (0, 0.03, 0.12), 40),
}
for look in ("textured", "grey"):
    if look == "textured":
        s.render.engine = "BLENDER_EEVEE"
    else:
        s.render.engine = "BLENDER_WORKBENCH"
        s.display.shading.light = "STUDIO"
        s.display.shading.color_type = "SINGLE"
        s.display.shading.show_cavity = True
    for name, (position, target, fov) in views.items():
        camera = bpy.data.objects.new(name, bpy.data.cameras.new(name))
        s.collection.objects.link(camera)
        camera.location = scene(*position)
        camera.rotation_euler = (scene(*target) - scene(*position)).to_track_quat("-Z", "Y").to_euler()
        camera.data.sensor_fit = "VERTICAL"
        camera.data.angle = math.radians(fov)
        s.camera = camera
        s.render.filepath = f"{PREVIEW}-{look}-{name}.png"
        bpy.ops.render.render(write_still=True)
