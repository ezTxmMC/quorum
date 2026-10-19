import { useEffect, useState } from 'react';
import type { BbModel } from '@shared/bbmodel';
import type { AnimationPreview } from '@shared/threed';
import { t } from '@/lib/i18n';
import { Icon } from '@/lib/icons';
import { imageUrl } from './MessageView';

export function ModelTextures({ model }: { model: BbModel }) {
  const textures = model.textures.filter((texture) => texture.source?.startsWith('data:image/png;base64,'));
  return <div className="space-y-3">
    {!textures.length && <p className="text-[12px] text-subtle">{t('Noch keine Texturen. Beschreibe Farben und Muster im Auftrag.')}</p>}
    <div className="flex flex-wrap gap-4">{textures.map((texture) => <figure key={texture.uuid} className="space-y-2">
      <img src={texture.source} alt={texture.name} className="size-40 rounded-lumen border border-edge bg-bg object-contain [image-rendering:pixelated]" />
      <figcaption className="text-[11.5px] text-muted">{texture.name} · {texture.width} × {texture.height}</figcaption>
    </figure>)}</div>
    <p className="text-[11.5px] text-subtle">{t('Texturen und Materialien werden im Modell und im GLB gespeichert.')}</p>
  </div>;
}

export function ModelAnimations({ model, previews }: { model: BbModel; previews: AnimationPreview[] }) {
  const [selected, setSelected] = useState('');
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);
  const animations = model.animations ?? [];
  const animation = animations.find((a) => a.uuid === selected) ?? animations[0];
  const preview = previews.find((p) => p.name === animation?.name);
  const frames = preview?.frames ?? [];
  useEffect(() => { setFrame(0); setPlaying(false); }, [animation?.uuid, preview]);
  useEffect(() => {
    if (!playing || frames.length < 2 || !animation) return;
    const timer = setTimeout(() => {
      if (frame >= frames.length - 1) {
        if (animation.loop === 'loop') setFrame(0);
        else setPlaying(false);
      } else setFrame(frame + 1);
    }, animation.length * 1000 / (frames.length - 1));
    return () => clearTimeout(timer);
  }, [playing, animation, frames, frame]);
  if (!animation) return <p className="text-[12px] text-subtle">{t('Noch keine Animationen. Beschreibe die gewünschte Bewegung im Auftrag.')}</p>;
  const keyframes = Object.values(animation.animators).reduce((count, animator) => count + animator.keyframes.length, 0);
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label={t('Animation')} className="field !w-auto" value={animation.uuid} onChange={(event) => setSelected(event.target.value)}>
        {animations.map((a) => <option key={a.uuid} value={a.uuid}>{a.name}</option>)}
      </select>
      <span className="text-[12px] text-muted">{animation.length} s · {keyframes} {t('Keyframes')} · {animation.loop === 'loop' ? t('Schleife') : animation.loop === 'hold' ? t('Endpose halten') : t('Einmal')}</span>
      <button className="btn" disabled={frames.length < 2} onClick={() => { if (!playing && frame >= frames.length - 1) setFrame(0); setPlaying(!playing); }}><Icon name={playing ? 'lucide:pause' : 'lucide:play'} size={14} />{playing ? t('Pause') : t('Abspielen')}</button>
    </div>
    {frames.length > 0 ? <div className="max-w-sm space-y-2">
      <img src={imageUrl(frames[Math.min(frame, frames.length - 1)])} alt={animation.name} className="aspect-square w-full rounded-lumen border border-edge object-contain" />
      <input aria-label={t('Animationszeit')} className="w-full accent-accent" type="range" min="0" max={frames.length - 1} value={Math.min(frame, frames.length - 1)} onChange={(event) => { setPlaying(false); setFrame(Number(event.target.value)); }} />
    </div> : <p className="text-[12px] text-subtle">{t('Die Animationsvorschau entsteht beim nächsten Modellierungslauf.')}</p>}
    <p className="text-[11.5px] text-subtle">{t('Animationen bleiben in Blockbench bearbeitbar und werden als GLB-Clips exportiert.')}</p>
  </div>;
}
