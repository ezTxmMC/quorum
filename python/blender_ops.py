"""Quorum-Blender-Operationen: feste, geprüfte Schritte für Blender im Hintergrund (blender -b).

Aufruf:  blender -b --factory-startup --python blender_ops.py -- <job.json>

job.json: {"workdir": "...", "ops": [{"op": "...", ...}, ...]}
Jede Operation arbeitet auf der Szene, die die vorige hinterlassen hat. Ergebnisse werden als eine Zeile
`RESULT {...}` auf stdout ausgegeben; Fehler als `ERROR {...}` (der Lauf endet dann).

Erlaubte Operationen (kein freier Code): info, load, decimate, smooth, export, render, pose, bbmodel_to_scene.
Alle Dateipfade müssen innerhalb von workdir liegen.
"""

import json
import base64
import math
import os
import sys

import bpy
from mathutils import Vector


def emit(prefix, obj):
    sys.stdout.write(prefix + " " + json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class OpError(Exception):
    pass


def inside(workdir, path):
    real = os.path.realpath(path)
    root = os.path.realpath(workdir)
    if not (real == root or real.startswith(root + os.sep)):
        raise OpError(f"Pfad liegt außerhalb des Arbeitsordners: {path}")
    return real


def mesh_objects():
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def info():
    objs = mesh_objects()
    verts = sum(len(o.data.vertices) for o in objs)
    faces = sum(len(o.data.polygons) for o in objs)
    mins = [math.inf] * 3
    maxs = [-math.inf] * 3
    for o in objs:
        for v in o.bound_box:
            world = o.matrix_world @ Vector(v)
            for i in range(3):
                mins[i] = min(mins[i], world[i])
                maxs[i] = max(maxs[i], world[i])
    bbox = None if not objs else {"min": mins, "max": maxs}
    return {
        "objects": [o.name for o in objs],
        "vertices": verts,
        "faces": faces,
        "materials": sorted({m.name for o in objs for m in o.data.materials if m}),
        "bbox": bbox,
    }


def op_load(job, step):
    path = inside(job["workdir"], step["file"])
    ext = os.path.splitext(path)[1].lower()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    if ext == ".blend":
        bpy.ops.wm.open_mainfile(filepath=path)
    elif ext in (".glb", ".gltf"):
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".fbx":
        bpy.ops.import_scene.fbx(filepath=path)
    else:
        raise OpError(f"Format nicht unterstützt: {ext}")
    return info()


def op_decimate(job, step):
    ratio = float(step.get("ratio", 0.5))
    if not 0.01 <= ratio <= 1.0:
        raise OpError("ratio muss zwischen 0.01 und 1.0 liegen")
    for o in mesh_objects():
        mod = o.modifiers.new("quorum_decimate", "DECIMATE")
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return info()


def op_smooth(job, step):
    iterations = int(step.get("iterations", 1))
    if not 1 <= iterations <= 10:
        raise OpError("iterations muss zwischen 1 und 10 liegen")
    for o in mesh_objects():
        mod = o.modifiers.new("quorum_smooth", "SMOOTH")
        mod.iterations = iterations
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier=mod.name)
    return info()


def op_export(job, step):
    fmt = step.get("format", "glb")
    out = inside(job["workdir"], step["file"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    for obj in bpy.context.scene.objects:
        if obj.animation_data:
            for track in obj.animation_data.nla_tracks:
                track.mute = False
    if fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE",
                                  export_animations=True, export_animation_mode="NLA_TRACKS", export_extras=True)
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=out)
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=out)
    else:
        raise OpError(f"Export-Format nicht unterstützt: {fmt}")
    return {"file": out, "bytes": os.path.getsize(out)}


def op_save_blend(job, step):
    out = inside(job["workdir"], step["file"])
    os.makedirs(os.path.dirname(out), exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=out)
    return {"file": out, "bytes": os.path.getsize(out)}


VIEWS = {
    "iso": (1.0, -1.0, 0.8),
    "front": (0.0, -1.0, 0.0),
    "back": (0.0, 1.0, 0.0),
    "left": (-1.0, 0.0, 0.0),
    "right": (1.0, 0.0, 0.0),
    "top": (0.0, -0.01, 1.0),
}


def op_render(job, step):
    """Ein Vorschaubild aus einer festen Perspektive (view: iso, front, back, left, right, top)."""
    out = inside(job["workdir"], step["file"])
    size = int(step.get("size", 512))
    view = step.get("view", "iso")
    if not 64 <= size <= 2048:
        raise OpError("size muss zwischen 64 und 2048 liegen")
    if view not in VIEWS:
        raise OpError(f"Unbekannte Ansicht: {view}")
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"  # ohne GPU-Sitzung, reproduzierbar
    scene.display.shading.color_type = "TEXTURE"
    scene.render.resolution_percentage = 100
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    os.makedirs(os.path.dirname(out), exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = out
    objs = mesh_objects()
    if not objs:
        raise OpError("Nichts zu rendern: Szene ist leer")
    pts = [o.matrix_world @ Vector(v) for o in objs for v in o.bound_box]
    if "quorum_bounds_min" in scene:
        lower, upper = Vector(scene["quorum_bounds_min"]), Vector(scene["quorum_bounds_max"])
        center = (lower + upper) / 2
        radius = max((upper - lower).length / 2, 0.1)
    else:
        center = Vector([sum(p[i] for p in pts) / len(pts) for i in range(3)])
        radius = max((p - center).length for p in pts) or 1.0
    # Vorhandene Kamera ersetzen: jede Ansicht wird frisch aufgebaut.
    for o in list(scene.objects):
        if o.type in ("CAMERA", "LIGHT"):
            bpy.data.objects.remove(o, do_unlink=True)
    d = Vector(VIEWS[view]).normalized()
    loc = center + d * radius * 3.2
    bpy.ops.object.camera_add(location=loc)
    cam = bpy.context.active_object
    cam.rotation_euler = (center - loc).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = 50
    scene.camera = cam
    bpy.ops.object.light_add(type="SUN", location=center + Vector((2, -2, 4)) * radius)
    bpy.ops.render.render(write_still=True)
    return {"file": out, "view": view}


def op_bbmodel_to_scene(job, step):
    """Import Blockbench cubes, UV atlas, materials, hierarchy and animation clips."""
    path = inside(job["workdir"], step["file"])
    with open(path, "r", encoding="utf-8") as f:
        model = json.load(f)
    elements = [e for e in model.get("elements", []) if e.get("type", "cube") == "cube"]
    if not elements:
        raise OpError("Keine Würfel in der .bbmodel-Datei")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scale = float(step.get("scale", 1.0 / 16.0))
    scene = bpy.context.scene
    scene.render.fps = 24
    root = bpy.data.objects.new("Quorum", None)
    scene.collection.objects.link(root)
    # Blockbench: Y up. Blender: Z up. Keep local axes intact under one root.
    root.rotation_euler = (math.pi / 2, 0, 0)
    groups = {}

    def group_nodes(nodes, parent, parent_origin):
        for node in nodes:
            if isinstance(node, str):
                continue
            origin = Vector(node.get("origin", [0, 0, 0]))
            obj = bpy.data.objects.new(node["name"], None)
            scene.collection.objects.link(obj)
            obj.parent = parent
            obj.location = (origin - parent_origin) * scale
            obj.rotation_mode = "ZYX"
            obj.rotation_euler = [math.radians(v) for v in node.get("rotation", [0, 0, 0])]
            obj["quorum_rest_location"] = list(obj.location)
            obj["quorum_rest_rotation"] = list(obj.rotation_euler)
            groups[node["uuid"]] = (obj, origin)
            group_nodes(node.get("children", []), obj, origin)
    group_nodes(model.get("outliner", []), root, Vector((0, 0, 0)))
    parents = {}

    def cube_parents(nodes, parent, origin):
        for node in nodes:
            if isinstance(node, str):
                parents[node] = (parent, origin)
            else:
                obj, point = groups[node["uuid"]]
                cube_parents(node.get("children", []), obj, point)
    cube_parents(model.get("outliner", []), root, Vector((0, 0, 0)))
    images = []
    for i, texture in enumerate(model.get("textures", [])):
        source = texture.get("source", "")
        if not source.startswith("data:image/png;base64,"):
            raise OpError("Textur muss als PNG im Modell eingebettet sein")
        png = inside(job["workdir"], os.path.join(job["workdir"], f"texture-{i}.png"))
        with open(png, "wb") as f:
            f.write(base64.b64decode(source.split(",", 1)[1], validate=True))
        image = bpy.data.images.load(png, check_existing=False)
        image.pack()
        images.append(image)
    width = model.get("resolution", {}).get("width", 16)
    height = model.get("resolution", {}).get("height", 16)
    material_cache = {}

    def material(texture, settings):
        roughness = float(settings.get("roughness", 0.8))
        metalness = float(settings.get("metalness", 0))
        key = (texture, roughness, metalness)
        if key in material_cache:
            return material_cache[key]
        mat = bpy.data.materials.new(f"Quorum material {len(material_cache)}")
        mat.use_nodes = True
        shader = mat.node_tree.nodes.get("Principled BSDF")
        shader.inputs["Roughness"].default_value = roughness
        shader.inputs["Metallic"].default_value = metalness
        if texture is not None and 0 <= texture < len(images):
            node = mat.node_tree.nodes.new("ShaderNodeTexImage")
            node.image = images[texture]
            node.interpolation = "Closest"
            mat.node_tree.links.new(node.outputs["Color"], shader.inputs["Base Color"])
            mat.node_tree.nodes.active = node
        material_cache[key] = mat
        return mat

    # Face winding and UV coordinates use the same corner order as Blockbench.
    faces = [(1, 0, 3, 2), (4, 5, 6, 7), (0, 1, 5, 4), (5, 1, 2, 6), (3, 7, 6, 2), (0, 4, 7, 3)]
    names = ["north", "south", "down", "east", "up", "west"]
    for e in elements:
        x0, y0, z0 = e["from"]
        x1, y1, z1 = e["to"]
        pivot = Vector(e.get("origin", [0, 0, 0]))
        verts = [(x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                 (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)]
        mesh = bpy.data.meshes.new(e.get("name", "cube"))
        mesh.from_pydata([(Vector(v) - pivot) * scale for v in verts], [], faces)
        mesh.update()
        obj = bpy.data.objects.new(e.get("name", "cube"), mesh)
        scene.collection.objects.link(obj)
        parent, origin = parents.get(e["uuid"], (root, Vector((0, 0, 0))))
        obj.parent = parent
        obj.location = (pivot - origin) * scale
        obj.rotation_mode = "ZYX"
        obj.rotation_euler = [math.radians(v) for v in e.get("rotation", [0, 0, 0])]
        uv = mesh.uv_layers.new(name="UVMap")
        for polygon, name in zip(mesh.polygons, names):
            data = e.get("faces", {}).get(name, {})
            tex = data.get("texture")
            mat = material(int(tex) if tex is not None else None, e.get("material", {}))
            if mat.name not in obj.data.materials:
                obj.data.materials.append(mat)
            polygon.material_index = obj.data.materials.find(mat.name)
            u0, v0, u1, v1 = data.get("uv", [0, 0, width, height])
            corners = [(u0 / width, 1 - v1 / height), (u1 / width, 1 - v1 / height),
                       (u1 / width, 1 - v0 / height), (u0 / width, 1 - v0 / height)]
            for index, corner in zip(polygon.loop_indices, corners):
                uv.data[index].uv = corner

    clips = model.get("animations", [])
    # Blockbench 5 flips these legacy animation axes when reading pre-5.0 files.
    legacy_animation = tuple(int(part) for part in model.get("meta", {}).get("format_version", "4.10").split(".")[:2]) < (5, 0)
    root["quorum_animation_loops"] = json.dumps({clip["name"]: clip.get("loop", "once") for clip in clips})
    for clip in clips:
        for bone_id, animator in clip.get("animators", {}).items():
            if bone_id not in groups:
                raise OpError(f"Animation verweist auf fehlende Gruppe: {bone_id}")
            obj, _ = groups[bone_id]
            obj.animation_data_create()
            rest = (obj.location.copy(), obj.rotation_euler.copy(), obj.scale.copy())
            # Every clip starts from the same rest transform, never the previous clip's last key.
            for frame in (1, 1 + clip["length"] * scene.render.fps):
                for channel in ("location", "rotation_euler", "scale"):
                    obj.keyframe_insert(data_path=channel, frame=frame)
            for key in animator.get("keyframes", []):
                value = key["data_points"][0]
                values = Vector([float(value[axis]) for axis in "xyz"])
                channel = key["channel"]
                if legacy_animation and channel in ("position", "rotation"):
                    values[0] *= -1
                    if channel == "rotation":
                        values[1] *= -1
                if channel == "position":
                    prop = "location"
                    obj.location = rest[0] + values * scale
                elif channel == "rotation":
                    prop = "rotation_euler"
                    obj.rotation_euler = [rest[1][i] + math.radians(values[i]) for i in range(3)]
                else:
                    prop = "scale"
                    obj.scale = values
                obj.keyframe_insert(data_path=prop, frame=1 + key["time"] * scene.render.fps)
            action = obj.animation_data.action
            action.name = f"{clip['name']}:{obj.name}"
            if hasattr(action, "fcurves"):
                curves = action.fcurves
            else:
                curves = [curve for layer in action.layers for strip in layer.strips
                          for bag in strip.channelbags for curve in bag.fcurves]
            for curve in curves:
                for key in curve.keyframe_points:
                    key.interpolation = "LINEAR"
            track = obj.animation_data.nla_tracks.new()
            track.name = clip["name"]
            strip = track.strips.new(clip["name"], 1, action)
            strip.extrapolation = "NOTHING"
            obj.animation_data.action = None
            obj.location, obj.rotation_euler, obj.scale = rest
        scene.frame_end = max(scene.frame_end, math.ceil(1 + clip["length"] * scene.render.fps))
    # Keep camera framing fixed over every clip so translation/jumps stay visible.
    points = []
    for clip in [None] + clips:
        for sample in range(8 if clip else 1):
            op_pose(job, {"animation": clip["name"] if clip else None, "time": clip["length"] * sample / 7 if clip else 0})
            points.extend([obj.matrix_world @ Vector(v) for obj in mesh_objects() for v in obj.bound_box])
    scene["quorum_bounds_min"] = [min(point[i] for point in points) for i in range(3)]
    scene["quorum_bounds_max"] = [max(point[i] for point in points) for i in range(3)]
    op_pose(job, {})
    result = info()
    result["animations"] = [clip["name"] for clip in clips]
    return result


def op_pose(job, step):
    name = step.get("animation")
    for obj in bpy.context.scene.objects:
        if "quorum_rest_location" in obj:
            obj.location = obj["quorum_rest_location"]
            obj.rotation_euler = obj["quorum_rest_rotation"]
            obj.scale = (1, 1, 1)
        if obj.animation_data:
            for track in obj.animation_data.nla_tracks:
                track.mute = name is None or track.name != name
    time = float(step.get("time", 0))
    if not math.isfinite(time) or time < 0:
        raise OpError("Ungültige Animationszeit")
    frame = 1 + time * bpy.context.scene.render.fps
    bpy.context.scene.frame_set(int(frame), subframe=frame % 1)
    bpy.context.view_layer.update()
    return {"animation": name, "time": time}


OPS = {
    "load": op_load,
    "info": lambda job, step: info(),
    "decimate": op_decimate,
    "smooth": op_smooth,
    "export": op_export,
    "render": op_render,
    "pose": op_pose,
    "bbmodel_to_scene": op_bbmodel_to_scene,
    "save_blend": op_save_blend,
}


def main():
    argv = sys.argv
    job_path = argv[argv.index("--") + 1]
    with open(job_path, "r", encoding="utf-8") as f:
        job = json.load(f)
    results = []
    # Standardszene (Würfel, Kamera, Licht) entfernen: jeder Job beginnt leer.
    bpy.ops.wm.read_factory_settings(use_empty=True)
    try:
        for step in job["ops"]:
            name = step.get("op")
            if name not in OPS:
                raise OpError(f"Unbekannte Operation: {name}")
            value = OPS[name](job, step)
            results.append({"op": name, "result": value})
            emit("RESULT", {"op": name, "result": value})
    except OpError as e:
        emit("ERROR", {"message": str(e)})
        sys.exit(2)
    except Exception as e:  # unerwartet: Meldung nach außen, Details auf stderr
        import traceback
        traceback.print_exc(file=sys.stderr)
        emit("ERROR", {"message": f"{type(e).__name__}: {e}"})
        sys.exit(3)
    emit("DONE", {"ops": len(results)})


if __name__ == "__main__":
    main()
