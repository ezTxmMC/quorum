/** Incrementally decode lines, including the final line without a newline. */
export async function* responseLines(response: Response): AsyncGenerator<string> {
  if (!response.body) throw new Error('Leere Serverantwort.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let split: number;
      while ((split = buffer.indexOf('\n')) >= 0) { yield buffer.slice(0, split).replace(/\r$/, ''); buffer = buffer.slice(split + 1); }
      if (done) break;
    }
    if (buffer) yield buffer.replace(/\r$/, '');
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function responseError(response: Response): Promise<Error> {
  let message = `HTTP ${response.status}`;
  try { const body = await response.json() as { error?: string | { message?: string } }; message = typeof body.error === 'string' ? body.error : body.error?.message ?? message; } catch { /* keep status */ }
  return new Error(message);
}
