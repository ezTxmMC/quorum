// Execute with Electron after npm run build. Uses an isolated profile and temporary workspace.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const project = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'quorum-ide-ui-'));
fs.writeFileSync(path.join(root, 'sample.ts'), 'const value = 1;\n');
process.env.QUORUM_DATA_DIR = path.join(root, 'data');
fs.mkdirSync(process.env.QUORUM_DATA_DIR);
fs.writeFileSync(path.join(process.env.QUORUM_DATA_DIR, 'hub.json'), JSON.stringify({ settings: { autoCheckUpdate: false, autoImport: false, quickHotkey: '' } }));
app.setPath('userData', process.env.QUORUM_DATA_DIR);
let tested = false;
const timeout = setTimeout(() => { console.error('Editor smoke test timed out'); app.exit(1); }, 30000);
app.on('browser-window-created', (_event, window) => {
  window.webContents.once('did-finish-load', async () => {
    if (tested) { return; }
    tested = true;
    try {
      await window.webContents.executeJavaScript(`(async () => {
        const definition = { objective: 'Inspect editor', requirements: [], constraints: [], assumptions: [], outOfScope: [], phases: [{ id: 'phase', title: 'Build', order: 0 }], tasks: [{ id: 'task', phaseId: 'phase', order: 0, title: 'Edit sample', description: 'Inspect editor integration', dependencies: [], priority: 'normal', complexity: 'simple', instructions: [], acceptanceCriteria: [{ id: 'c', description: 'Tests pass', verification: 'manual' }], expectedFiles: ['sample.ts'], expectedArtifacts: [], requiresApproval: true, maxAttempts: 1 }], modelAssignments: [] };
        await window.hub.planSave({ workspaceRoot: ${JSON.stringify(root)}, title: 'Editor Smoke Plan', definition });
        location.hash = '#/plan';
        const wait = async predicate => {
          for (let attempt = 0; attempt < 100; attempt++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
          throw new Error('Editor UI element missing');
        };
        const button = text => [...document.querySelectorAll('button')].find(element => element.textContent.includes(text));
        await wait(() => button('Editor Smoke Plan'));
        button('Editor Smoke Plan').click();
        await wait(() => button('sample.ts'));
        button('sample.ts').click();
        await wait(() => document.querySelector('.monaco-editor textarea'));
        document.querySelector('.monaco-editor textarea').focus();
      })()`);
      const modifiers = [process.platform === 'darwin' ? 'meta' : 'control'];
      window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers });
      window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
      await window.webContents.insertText('const value = 2;\n');
      await new Promise((resolve) => setTimeout(resolve, 200));
      await window.webContents.executeJavaScript(`(() => {
        const save = [...document.querySelectorAll('button')].find(element => element.textContent === 'Speichern');
        if (!save || save.disabled) throw new Error('Save action disabled after editing');
        save.click();
      })()`);
      for (let attempt = 0; attempt < 30; attempt++) {
        if (fs.readFileSync(path.join(root, 'sample.ts'), 'utf8') === 'const value = 2;\n') { break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.equal(fs.readFileSync(path.join(root, 'sample.ts'), 'utf8'), 'const value = 2;\n');
      await window.webContents.executeJavaScript(`(() => {
        const find = [...document.querySelectorAll('button')].find(element => element.textContent === 'Suchen / Ersetzen');
        find.click();
        if (!document.querySelector('.find-widget')) throw new Error('Monaco find widget missing');
      })()`);
      const screenshot = await window.webContents.capturePage();
      fs.writeFileSync(path.join(require('node:os').tmpdir(), 'quorum-ide-smoke.png'), screenshot.toPNG());
      console.log('Electron editor: plan IPC, lazy route, task/file navigation, Monaco editing, save and find passed.');
      clearTimeout(timeout);
      app.quit();
    } catch (error) { console.error(error); clearTimeout(timeout); app.exit(1); }
  });
});
app.on('will-quit', () => fs.rmSync(root, { recursive: true, force: true }));
import(pathToFileURL(path.join(project, 'dist-electron/main.js')).href).catch((error) => { console.error(error); app.exit(1); });
