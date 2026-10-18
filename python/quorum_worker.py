"""Quorum-Worker: lädt ein Transformers- oder Diffusers-Modell und beantwortet Anfragen über JSON-Zeilen.

Protokoll (eine JSON-Zeile je Nachricht, stdin → Anfrage, stdout ← Antwort):
  Anfrage:  {"id": "...", "op": "load" | "chat" | "image" | "unload" | "status" | "shutdown", ...}
  Antwort:  {"id": "...", "event": "text" | "image" | "status" | "error" | "done", ...}

Nur das Protokoll geht über stdout. Alle Logs und Fehlertexte von Bibliotheken landen auf stderr.
Gestartet wird dieser Worker mit `python -I` (isolierter Modus), damit keine lokalen Module ihn überschatten.
"""

import json
import os
import sys
import threading
import traceback

_out_lock = threading.Lock()


def send(obj):
    with _out_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def reply(req_id, **fields):
    fields["id"] = req_id
    send(fields)


def vram():
    try:
        import torch

        if not torch.cuda.is_available():
            return None
        free, total = torch.cuda.mem_get_info()
        return {"free": int(free), "total": int(total), "allocated": int(torch.cuda.memory_allocated())}
    except Exception:
        return None


class State:
    kind = None  # "transformers" | "diffusers"
    model = None
    tokenizer = None
    device = "cpu"


state = State()


def free_model():
    state.model = None
    state.tokenizer = None
    state.kind = None
    try:
        import gc
        import torch

        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def load(req):
    import torch

    kind = req["kind"]
    path = req["path"]
    trust = bool(req.get("trustRemoteCode", False))
    device = req.get("device", "cuda" if torch.cuda.is_available() else "cpu")
    dtype = torch.float16 if device == "cuda" else torch.float32
    free_model()
    if kind == "transformers":
        from transformers import AutoModelForCausalLM, AutoTokenizer

        tok = AutoTokenizer.from_pretrained(path, trust_remote_code=trust)
        model = AutoModelForCausalLM.from_pretrained(path, torch_dtype=dtype, trust_remote_code=trust).to(device)
        model.eval()
        state.tokenizer = tok
        state.model = model
    elif kind == "diffusers":
        from diffusers import DiffusionPipeline

        pipe = DiffusionPipeline.from_pretrained(path, torch_dtype=dtype, variant=req.get("variant") or None, trust_remote_code=trust)
        offload = req.get("offload", "none")
        if offload == "model" and device == "cuda":
            pipe.enable_model_cpu_offload()
        else:
            pipe = pipe.to(device)
        state.model = pipe
    else:
        raise ValueError(f"Unbekannte Art: {kind}")
    state.kind = kind
    state.device = device


def chat(req):
    import torch
    from transformers import TextIteratorStreamer

    if state.kind != "transformers":
        raise RuntimeError("Kein Sprachmodell geladen")
    tok, model = state.tokenizer, state.model
    messages = req["messages"]
    if getattr(tok, "chat_template", None):
        text = tok.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    else:
        text = "\n".join(f"{m['role']}: {m['content']}" for m in messages) + "\nassistant:"
    inputs = tok(text, return_tensors="pt").to(state.device)
    streamer = TextIteratorStreamer(tok, skip_prompt=True, skip_special_tokens=True)
    kwargs = dict(
        **inputs,
        max_new_tokens=int(req.get("maxNewTokens", 512)),
        do_sample=float(req.get("temperature", 0)) > 0,
        streamer=streamer,
    )
    if kwargs["do_sample"]:
        kwargs["temperature"] = float(req["temperature"])
    errors = []

    def run():
        try:
            with torch.inference_mode():
                model.generate(**kwargs)
        except Exception as e:  # wird unten gemeldet
            errors.append(e)

    t = threading.Thread(target=run, daemon=True)
    t.start()
    for piece in streamer:
        if piece:
            reply(req["id"], event="text", delta=piece)
    t.join()
    if errors:
        raise errors[0]


def image(req):
    import torch

    if state.kind != "diffusers":
        raise RuntimeError("Kein Bildmodell geladen")
    seed = req.get("seed")
    gen = torch.Generator(device=state.device).manual_seed(int(seed)) if seed is not None else None
    kwargs = dict(
        prompt=req["prompt"],
        num_inference_steps=int(req.get("steps", 20)),
        guidance_scale=float(req.get("guidance", 7.0)),
        width=int(req.get("width", 512)),
        height=int(req.get("height", 512)),
        generator=gen,
    )
    if req.get("negative"):
        kwargs["negative_prompt"] = req["negative"]
    with torch.inference_mode():
        result = state.model(**kwargs)
    img = result.images[0]
    out = req["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    img.save(out)
    reply(req["id"], event="image", path=out)


def handle(req):
    op = req.get("op")
    rid = req.get("id")
    if op == "load":
        load(req)
        reply(rid, event="status", ok=True, kind=state.kind, vram=vram())
    elif op == "chat":
        chat(req)
    elif op == "image":
        image(req)
    elif op == "unload":
        free_model()
        reply(rid, event="status", ok=True, kind=None, vram=vram())
    elif op == "status":
        reply(rid, event="status", ok=True, kind=state.kind, vram=vram())
    elif op == "shutdown":
        free_model()
        return False
    else:
        raise ValueError(f"Unbekannte Anfrage: {op}")
    return True


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req = json.loads(line)
        rid = req.get("id")
        try:
            keep_going = handle(req)
            reply(rid, event="done", ok=True)
            if not keep_going:
                break
        except MemoryError as e:
            reply(rid, event="error", code="oom", message=str(e) or "Speicher reicht nicht")
            reply(rid, event="done", ok=False)
        except Exception as e:
            text = str(e)
            code = "oom" if "out of memory" in text.lower() else "error"
            traceback.print_exc(file=sys.stderr)
            reply(rid, event="error", code=code, message=text or type(e).__name__)
            reply(rid, event="done", ok=False)


if __name__ == "__main__":
    main()
