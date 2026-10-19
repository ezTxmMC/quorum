import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { newModel, bakeTexture, removeGroup, validate, summarize } from '../shared/bbmodel.ts';
import { parsePlan, applyActions } from '../shared/modeling-actions.ts';
import { encodePng, toBase64 } from '../shared/png.ts';
import { runModelingLoop } from '../electron/3d/loop.ts';

const model = newModel('Textured animated fixture');
const actions = [
  { action: 'add_group', name: 'body', origin: [0, 8, 0] },
  { action: 'add_group', name: 'arm', origin: [4, 12, 0], parent: 'body' },
  { action: 'add_cube', name: 'torso', from: [-4, 0, -3], to: [4, 16, 3], group: 'body' },
  { action: 'add_cube', name: 'hand', from: [4, 4, -2], to: [8, 12, 2], group: 'arm' },
  { action: 'paint', name: 'body', color: '#dd6633', pattern: 'checker', detailColor: '#224488' },
  { action: 'paint', name: 'hand', face: 'up', color: '#55dd66' },
  { action: 'material', name: 'body', roughness: 0.35, metalness: 0.6 },
  { action: 'rotate', name: 'torso', rotation: [0, 10, 0], origin: [0, 8, 0] },
  { action: 'add_animation', name: 'wave', length: 1, loop: 'loop' },
  ...[0, 0.5, 1].map((time) => ({ action: 'add_keyframe', name: 'wave', group: 'arm', channel: 'rotation', time, value: [0, 0, time === 0.5 ? 60 : 0] })),
  ...[0, 0.5, 1].map((time) => ({ action: 'add_keyframe', name: 'wave', group: 'body', channel: 'position', time, value: [0, time === 0.5 ? 1 : 0, 0] })),
  { action: 'add_animation', name: 'jump', length: 1, loop: 'once' },
  ...[0, 0.5, 1].map((time) => ({ action: 'add_keyframe', name: 'jump', group: 'body', channel: 'position', time, value: [0, time === 0.5 ? 6 : 0, 0] })),
];
const plan = parsePlan(JSON.stringify({ actions, done: true }));
assert.deepEqual(plan.errors, []);
assert.deepEqual(applyActions(model, plan.actions).errors, []);
assert.deepEqual(validate(model).filter((i) => i.level === 'error'), []);
bakeTexture(model, (w, h, rgba) => toBase64(encodePng(w, h, rgba)));
assert.equal(model.textures.length, 1);
assert.equal(model.meta.box_uv, false);
const png = Buffer.from(model.textures[0].source.split(',')[1], 'base64');
assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
const payload = [];
for (let i = 8; i < png.length;) {
  const length = png.readUInt32BE(i);
  if (png.toString('ascii', i + 4, i + 8) === 'IDAT') payload.push(png.subarray(i + 8, i + 8 + length));
  i += length + 12;
}
assert.equal(inflateSync(Buffer.concat(payload)).length, (model.resolution.width * 4 + 1) * model.resolution.height);
assert.notDeepEqual(model.elements[1].faces.up.uv, model.elements[1].faces.north.uv);
assert.equal(summarize(model).animations.length, 2);
const invalid = parsePlan(JSON.stringify({ actions: [{ action: 'material', name: 'body', roughness: 2, metalness: 0 }, { action: 'add_animation', name: 'bad', length: 1e309 }] }));
assert.equal(invalid.actions.length, 0);
assert.equal(applyActions(model, [{ action: 'add_keyframe', name: 'wave', group: 'arm', channel: 'rotation', time: 2, value: [0, 0, 0] }]).errors.length, 1);
const deleted = structuredClone(model);
removeGroup(deleted, 'body');
assert.equal(deleted.elements.length, 0);
assert.equal(Object.keys(deleted.animations[0].animators).length, 0);
const loop = await runModelingLoop(newModel('loop'), 'textured animated model', {
  chat: async (messages) => { assert(messages[0].content.includes('add_keyframe')); return JSON.stringify({ actions, done: true }); },
  render: async (result) => { assert.equal(result.animations.length, 2); return { ok: true }; }, emit: () => {},
});
assert.equal(loop.ok, true);
const failed = await runModelingLoop(model, 'keep it', { chat: async () => '{"actions":[],"done":true}', render: async () => ({ ok: false, error: 'renderer failed' }), emit: () => {} }, 1);
assert.equal(failed.ok, false, 'a failed render cannot be marked complete');
const emptyAnimation = await runModelingLoop(newModel('empty clip'), 'animate it', {
  chat: async () => JSON.stringify({ actions: [actions[0], actions[2], { action: 'add_animation', name: 'empty', length: 1 }], done: true }),
  render: async () => ({ ok: true }), emit: () => {},
}, 1);
assert.equal(emptyAnimation.ok, false, 'empty animations cannot be marked complete');
console.log('3D action, texture PNG, hierarchy, animation validation and modeling loop checks passed.');

if (process.argv.includes('--blender')) {
  const dir = await mkdtemp(join(tmpdir(), 'quorum-3d-check-'));
  await writeFile(join(dir, 'model.bbmodel'), JSON.stringify(model));
  const ops = [
    { op: 'bbmodel_to_scene', file: join(dir, 'model.bbmodel') },
    { op: 'pose' }, { op: 'render', file: join(dir, 'rest.png'), size: 128 },
    { op: 'pose', animation: 'wave', time: 0.5 }, { op: 'render', file: join(dir, 'wave.png'), size: 128 },
    { op: 'pose', animation: 'jump', time: 0.5 }, { op: 'render', file: join(dir, 'jump.png'), size: 128 },
    { op: 'export', format: 'glb', file: join(dir, 'exports', 'model.glb') },
  ];
  await writeFile(join(dir, 'job.json'), JSON.stringify({ workdir: dir, ops }));
  const { stdout } = await promisify(execFile)(process.env.QUORUM_BLENDER || 'blender', ['-b', '--factory-startup', '--python', resolve('python/blender_ops.py'), '--', join(dir, 'job.json')], { timeout: 180000, maxBuffer: 4 * 1024 * 1024 });
  assert(stdout.includes('DONE '), stdout);
  const glb = await readFile(join(dir, 'exports', 'model.glb'));
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)).trim());
  assert.deepEqual(json.animations.map((a) => a.name).sort(), ['jump', 'wave']);
  assert(json.animations.find((a) => a.name === 'wave').channels.some((c) => json.nodes[c.target.node].name === 'arm'));
  assert(json.animations.find((a) => a.name === 'wave').channels.some((c) => json.nodes[c.target.node].name === 'body'));
  assert(json.images?.some((image) => image.mimeType === 'image/png' && image.bufferView !== undefined));
  assert(json.materials.some((m) => Math.abs((m.pbrMetallicRoughness?.metallicFactor ?? 0) - 0.6) < 1e-6));
  assert(json.meshes.every((m) => m.primitives.every((p) => p.attributes.TEXCOORD_0 !== undefined)));
  assert.notDeepEqual(await readFile(join(dir, 'rest.png')), await readFile(join(dir, 'wave.png')));
  assert.notDeepEqual(await readFile(join(dir, 'rest.png')), await readFile(join(dir, 'jump.png')));
  console.log('Blender integration passed: embedded PNG/UVs, materials, nested transforms, distinct preview poses and both GLB animation clips. Artifacts:', dir);
}
