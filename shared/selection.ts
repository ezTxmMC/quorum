// Vorauswahl der Dateien eines Hugging-Face-Repos. Reine Funktion – wird im Main-Prozess (Download) und in der Oberfläche genutzt.

/** Alternative Formate und Medien, die nicht zum Laden gebraucht werden. */
const SKIP_FILE = /\.(bin|onnx|msgpack|h5|ckpt|pt|pth|md|png|jpe?g|gif|webp|mp4|ot|tflite)$|^\.gitattributes$/i;

/**
 * Ohne alternative Formate (.bin, .onnx …) und ohne doppelte Gewichte.
 * Gibt es fp16-Gewichte, werden nur diese genommen (sonst lädt man Gewichte doppelt, z. B. fp32 + fp16).
 */
export function defaultSelection(files: { path: string }[]): string[] {
  const usable = files.filter((f) => !SKIP_FILE.test(f.path));
  const weights = usable.filter((f) => f.path.endsWith('.safetensors'));
  const hasFp16 = weights.some((f) => /\.fp16\./.test(f.path));
  return usable
    .filter((f) => !f.path.endsWith('.safetensors') || !hasFp16 || /\.fp16\./.test(f.path))
    .map((f) => f.path);
}

/** Geteilte GGUF-Datei: `<name>-00002-of-00003.gguf` → Name, Teilnummer, Gesamtzahl. */
export function shardOf(path: string): { stem: string; index: number; total: number } | undefined {
  const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/.exec(path);
  if (!m) return undefined;
  return { stem: m[1], index: Number(m[2]), total: Number(m[3]) };
}

/** Wer einen Teil einer geteilten GGUF wählt, bekommt alle Teile derselben Modellgruppe. */
export function expandShards(files: { path: string }[], picked: string[]): string[] {
  const stems = new Set(picked.map((p) => shardOf(p)?.stem).filter((s): s is string => !!s));
  if (stems.size === 0) return picked;
  const extra = files.map((f) => f.path).filter((p) => { const s = shardOf(p); return !!s && stems.has(s.stem); });
  return [...new Set([...picked, ...extra])];
}

/** Der erste Teil ist die Datei, die llama.cpp laden muss; die übrigen findet es im selben Ordner. */
export function loadablePath(path: string): string {
  const s = shardOf(path);
  if (!s || s.index === 1) return path;
  return path.replace(/-\d{5}-of-(\d{5})\.gguf$/, `-00001-of-$1.gguf`);
}
