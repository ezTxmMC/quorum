"""Quorum-Blender-Operationen: feste, geprüfte Schritte für Blender im Hintergrund (blender -b).

Aufruf:  blender -b --factory-startup --python blender_ops.py -- <job.json>

job.json: {"workdir": "...", "ops": [{"op": "...", ...}, ...]}
Jede Operation arbeitet auf der Szene, die die vorige hinterlassen hat. Ergebnisse werden als eine Zeile
`RESULT {...}` auf stdout ausgegeben; Fehler als `ERROR {...}` (der Lauf endet dann).

Erlaubte Operationen (kein freier Code): info, load, decimate, smooth, export, render, bbmodel_to_scene.
Alle Dateipfade müssen innerhalb von workdir liegen.
"""

import json
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
    if fmt in ("glb", "gltf"):
        bpy.ops.export_scene.gltf(filepath=out, export_format="GLB" if fmt == "glb" else "GLTF_SEPARATE")
    elif fmt == "obj":
        bpy.ops.wm.obj_export(filepath=out)
    elif fmt == "fbx":
        bpy.ops.export_scene.fbx(filepath=out)
    else:
        raise OpError(f"Export-Format nicht unterstützt: {fmt}")
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
    scene.render.resolution_x = size
    scene.render.resolution_y = size
    scene.render.filepath = out
    objs = mesh_objects()
    if not objs:
        raise OpError("Nichts zu rendern: Szene ist leer")
    pts = [o.matrix_world @ Vector(v) for o in objs for v in o.bound_box]
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
    """Würfel aus einer .bbmodel-Datei als Blender-Meshes aufbauen (eine Box je Würfel-Element)."""
    path = inside(job["workdir"], step["file"])
    with open(path, "r", encoding="utf-8") as f:
        model = json.load(f)
    elements = [e for e in model.get("elements", []) if e.get("type", "cube") == "cube"]
    if not elements:
        raise OpError("Keine Würfel in der .bbmodel-Datei")
    scale = float(step.get("scale", 1.0 / 16.0))  # Blockbench rechnet in Pixeln (16 je Block)
    for e in elements:
        f_, t_ = e["from"], e["to"]
        x0, y0, z0 = f_
        x1, y1, z1 = t_
        verts = [
            (x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
            (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1),
        ]
        verts = [(x * scale, y * scale, z * scale) for x, y, z in verts]
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4), (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        mesh = bpy.data.meshes.new(e.get("name", "cube"))
        mesh.from_pydata(verts, [], faces)
        mesh.update()
        obj = bpy.data.objects.new(e.get("name", "cube"), mesh)
        bpy.context.scene.collection.objects.link(obj)
    return info()


OPS = {
    "load": op_load,
    "info": lambda job, step: info(),
    "decimate": op_decimate,
    "smooth": op_smooth,
    "export": op_export,
    "render": op_render,
    "bbmodel_to_scene": op_bbmodel_to_scene,
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
