import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export async function slashCommands(cwd: string): Promise<{ name: string; source: string }[]> {
  const res: { name: string; source: string }[] = [];
  const scan = async (dir: string, source: string, skills: boolean) => {
    try {
      const entries = await fsp.readdir(dir, { withFileTypes: true });
      for (const ent of entries) {
        if (skills && ent.isDirectory()) {
          try {
            await fsp.access(join(dir, ent.name, 'SKILL.md'));
            res.push({ name: ent.name, source });
          } catch { /* kein SKILL.md */ }
        } else if (!skills && ent.isFile() && ent.name.endsWith('.md')) {
          res.push({ name: ent.name.slice(0, -3), source });
        }
      }
    } catch { /* Ordner existiert nicht */ }
  };
  await Promise.all([
    scan(join(homedir(), '.claude', 'commands'), 'Benutzer-Befehl', false),
    scan(join(homedir(), '.claude', 'skills'), 'Benutzer-Skill', true),
    scan(join(cwd, '.claude', 'commands'), 'Projekt-Befehl', false),
    scan(join(cwd, '.claude', 'skills'), 'Projekt-Skill', true),
  ]);
  return res;
}
