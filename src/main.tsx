import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { installTauri } from './lib/tauri';
import './styles/index.css';

async function start() {
  if (window.__TAURI__) await installTauri(window.__TAURI__);
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
}
void start().catch((error) => {
  document.getElementById('root')!.textContent = 'Quorum konnte nicht starten. ' + String(error);
});
