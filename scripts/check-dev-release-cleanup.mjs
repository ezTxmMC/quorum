import assert from 'node:assert/strict';
import { pruneDevReleases } from './prune-dev-releases.mjs';

const repo = { owner: 'example', repo: 'quorum' };
const tag = '1.0.0-dev.1234abcd';
const keep = { id: 7, tag_name: tag, draft: false, published_at: '2026-10-19T12:00:00Z' };
const assets = ['Quorum.AppImage', 'Quorum.deb', 'SHA256SUMS.txt'].map((name) => ({ name, state: 'uploaded' }));
function fixture(replacement = keep, files = assets) {
  const deleted = [];
  const listReleases = () => {};
  const listReleaseAssets = () => {};
  const github = {
    rest: { repos: {
      getReleaseByTag: async (args) => { assert.deepEqual(args, { ...repo, tag }); return { data: replacement }; },
      listReleases, listReleaseAssets,
      deleteRelease: async (args) => { assert.equal(args.owner, repo.owner); assert.equal(args.repo, repo.repo); deleted.push(args.release_id); },
    } },
    paginate: async (method, args) => {
      assert.equal(args.per_page, 100);
      if (method === listReleaseAssets) { assert.equal(args.release_id, keep.id); return files; }
      assert.equal(method, listReleases);
      return [keep,
        { id: 1, tag_name: '1.0.0-dev.8765abcd' },
        { id: 2, tag_name: 'v1.0.0-dev.abcdef12', draft: true },
        { id: 3, tag_name: '1.0.0-beta.1' },
        { id: 4, tag_name: '1.0.0-release.1' },
        { id: 5, tag_name: 'unrelated-dev.preview' },
      ];
    },
  };
  return { github, deleted };
}
const valid = fixture();
await pruneDevReleases(valid.github, repo, tag);
assert.deepEqual(valid.deleted, [1, 2]);
for (const [replacement, files] of [
  [{ ...keep, draft: true }, assets],
  [{ ...keep, published_at: null }, assets],
  [keep, assets.slice(0, 2)],
  [keep, assets.map((a) => ({ ...a, state: 'new' }))],
]) {
  const unsafe = fixture(replacement, files);
  await assert.rejects(pruneDevReleases(unsafe.github, repo, tag), /Replacement dev release/);
  assert.deepEqual(unsafe.deleted, []);
}
const invalid = fixture();
await assert.rejects(pruneDevReleases(invalid.github, repo, '1.0.0-beta.1'), /dev release tag/);
assert.deepEqual(invalid.deleted, []);
console.log('Dev cleanup checks passed: replace before deleting, preserve beta/release, include all pages and old drafts.');
