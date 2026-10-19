const isDevTag = (tag) => /^v?\d+\.\d+\.\d+-dev\.[0-9A-Za-z.-]+$/.test(tag);

/** Keep the replacement available before deleting any previous dev releases. */
export async function pruneDevReleases(github, repo, keepTag) {
  if (!isDevTag(keepTag)) throw new Error('Cleanup requires a dev release tag.');
  const { data: keep } = await github.rest.repos.getReleaseByTag({ ...repo, tag: keepTag });
  const assets = await github.paginate(github.rest.repos.listReleaseAssets, { ...repo, release_id: keep.id, per_page: 100 });
  const uploaded = assets.filter((asset) => asset.state === 'uploaded');
  if (keep.draft || !keep.published_at || !uploaded.some((a) => a.name.endsWith('.AppImage'))
    || !uploaded.some((a) => a.name.endsWith('.deb')) || !uploaded.some((a) => a.name === 'SHA256SUMS.txt')) {
    throw new Error('Replacement dev release is not published with all required assets; retaining previous releases.');
  }
  const releases = await github.paginate(github.rest.repos.listReleases, { ...repo, per_page: 100 });
  for (const release of releases) {
    if (release.id === keep.id || !isDevTag(release.tag_name)) continue;
    await github.rest.repos.deleteRelease({ ...repo, release_id: release.id });
    console.log(`Removed dev release ${release.tag_name}`);
  }
}
