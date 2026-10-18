import { execFile } from 'node:child_process';
import type { GitStatus } from '../shared/types';

export function git(cwd: string, args: string[], timeout = 60000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 16 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ ok: !e, out: String(stdout), err: String(stderr) });
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).out.trim() === 'true';
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  if (!(await isRepo(cwd))) return { isRepo: false, files: [] };
  const [b, s] = await Promise.all([git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), git(cwd, ['status', '--porcelain'])]);
  const files = s.out.split('\n').filter(Boolean).map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3) }));
  return { isRepo: true, branch: b.out.trim(), files };
}

export async function gitDiff(cwd: string, file?: string): Promise<string> {
  const args = ['diff', 'HEAD', '--no-color'];
  if (file) args.push('--', file);
  const r = await git(cwd, args);
  if (r.out.trim()) return r.out;
  if (file) {
    const u = await git(cwd, ['diff', '--no-index', '--no-color', '/dev/null', file]);
    return u.out;
  }
  return r.out;
}

export async function hasCommits(cwd: string): Promise<boolean> {
  return (await git(cwd, ['rev-parse', '--verify', 'HEAD'])).ok;
}

export async function addWorktree(repo: string, dir: string, branch: string): Promise<boolean> {
  return (await git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD'])).ok;
}

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await git(dir, ['add', '-A']);
  const st = await git(dir, ['status', '--porcelain']);
  if (!st.out.trim()) return false;
  return (await git(dir, ['-c', 'user.name=AI Hub', '-c', 'user.email=ai-hub@localhost', 'commit', '-m', message])).ok;
}

export async function mergeBranch(repo: string, branch: string): Promise<{ ok: boolean; conflicts: string[]; message: string }> {
  const r = await git(repo, ['-c', 'user.name=AI Hub', '-c', 'user.email=ai-hub@localhost', 'merge', '--no-ff', '-m', `Merge ${branch}`, branch]);
  if (r.ok) return { ok: true, conflicts: [], message: r.out.trim() };
  const c = await git(repo, ['diff', '--name-only', '--diff-filter=U']);
  return { ok: false, conflicts: c.out.split('\n').filter(Boolean), message: (r.out + r.err).trim() };
}

export async function mergeInProgress(repo: string): Promise<boolean> {
  return (await git(repo, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'])).ok;
}

export async function abortMerge(repo: string): Promise<void> { await git(repo, ['merge', '--abort']); }

export async function removeWorktree(repo: string, dir: string, branch: string): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]);
  await git(repo, ['branch', '-D', branch]);
}
