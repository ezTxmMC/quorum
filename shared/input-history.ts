export interface InputRecall { index: number; text: string; draft: string }

export function recallInput(history: string[], current: InputRecall, direction: 1 | -1, start: number, end: number): InputRecall | undefined {
  if (start !== end || !history.length) { return; }
  const boundary = direction > 0 ? !current.text.slice(0, start).includes('\n') : !current.text.slice(end).includes('\n');
  if (!boundary || (current.index < 0 && current.text.trim()) || (current.index < 0 && direction < 0)) { return; }
  const draft = current.index < 0 ? current.text : current.draft;
  const index = Math.max(-1, Math.min(history.length - 1, current.index + direction));
  return { index, draft, text: index < 0 ? draft : history[index] };
}
