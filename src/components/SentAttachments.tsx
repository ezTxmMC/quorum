import { useEffect, useState } from 'react';
import type { Message, MessageFile } from '@shared/types';
import { hub } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { Modal } from './ui';

export function SentImage({ path, source, name }: { path?: string; source?: string; name: string }) {
  const [url, setUrl] = useState(source);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!path || source) { return; }
    let alive = true;
    void hub.previewImage(path).then((value) => { if (alive) { setUrl(value); } }).catch(() => { if (alive) { setError('Bild nicht mehr verfügbar'); } });
    return () => { alive = false; };
  }, [path, source]);
  return <>
    <button className="max-w-full overflow-hidden rounded-lg border border-edge bg-active p-1 text-left" onClick={() => setOpen(true)} title={name}>
      {url && <img src={url} alt={name} className="max-h-40 max-w-60 rounded object-contain" />}
      <span className="block max-w-60 truncate px-1 text-xs">{error || name}</span>
    </button>
    {open && <Modal title={name} wide onClose={() => setOpen(false)}>
      {url && <img src={url} alt={name} className="max-h-[70vh] w-full object-contain" />}
      {error && <p role="alert">{error}</p>}
      <div className="mt-3 flex gap-2">
        {url && <a className="btn" href={url} download={name}>Bild speichern</a>}
        {path && <button className="btn" onClick={() => void hub.revealPath(path)}>Im Ordner zeigen</button>}
      </div>
    </Modal>}
  </>;
}

function SentFile({ file }: { file: MessageFile }) {
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const save = () => {
    const url = URL.createObjectURL(new Blob([file.text ?? ''], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = file.name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const openFile = async () => {
    if (!file.path) { return; }
    try { setError(await hub.openPath(file.path)); }
    catch (reason) { setError(String(reason)); }
  };
  return <>
    <button className="btn max-w-full" onClick={() => setOpen(true)}><Icon name="lucide:file" size={14} /><span className="truncate">{file.name}</span></button>
    {open && <Modal title={file.name} wide onClose={() => setOpen(false)}>
      {file.text !== undefined && <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap text-sm">{file.text}</pre>}
      {file.text === undefined && <p className="text-sm text-muted">Diese Datei kannst du mit der zugehörigen Anwendung öffnen.</p>}
      <div className="mt-3 flex gap-2">
        {file.text !== undefined && <button className="btn" onClick={save}>Datei speichern</button>}
        {file.path && <><button className="btn" onClick={() => void openFile()}>Datei öffnen</button><button className="btn" onClick={() => void hub.revealPath(file.path!)}>Im Ordner zeigen</button></>}
      </div>
      {error && <p role="alert" className="mt-2 text-bad">{error}</p>}
    </Modal>}
  </>;
}

export function SentAttachments({ message }: { message: Message }) {
  return <div className="mb-2 flex flex-wrap gap-2">
    {message.images?.map((path) => /\.(png|jpe?g|gif|webp|bmp|ico)$/i.test(path)
      ? <SentImage key={path} path={path} name={path.split(/[\\/]/).pop() ?? path} />
      : <SentFile key={path} file={{ name: path.split(/[\\/]/).pop() ?? path, path: /[\\/]/.test(path) ? path : undefined }} />)}
    {message.attachments?.map((attachment) => <SentImage key={attachment.id} source={`data:${attachment.mime};base64,${attachment.data}`} name={attachment.name} />)}
    {message.files?.map((file, index) => <SentFile key={index} file={file} />)}
  </div>;
}
