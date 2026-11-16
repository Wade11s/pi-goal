# Releasing to npm

`@wade11s/pi-goal` publishes from GitHub Actions when a `v*` tag is pushed
(`.github/workflows/publish.yml`). The pipeline verifies the tag against
`package.json`, runs typecheck and the full RPC suite, publishes to npm, and
creates a GitHub release whose body is that version's `CHANGELOG.md` section.

## Authentication

**Trusted publishing is currently blocked for this repository.** GitHub issues
immutable OIDC subject claims for new repositories:

```
sub: repo:Wade11s@143927706/pi-goal@1452240836:ref:refs/tags/v0.1.1
```

npm's exchange still compares the legacy `repo:owner/repo` shape, so it answers
`OIDC token exchange error - package not found` (npm/cli#9969). This is not a
configuration mistake and waiting does not fix it.

Until npm fixes that, the workflow authenticates with a granular **`NPM_TOKEN`**
secret. Provenance is still generated from the OIDC token (`id-token: write`).

### One-time setup

1. The first version (0.1.0) was published manually. A trusted publisher is
   configured on npmjs.com, but it cannot be exercised until npm/cli#9969 lands.
2. Create a granular npm token:
   **npmjs.com → Access Tokens → Generate New Token → Granular Access Token**
   - Packages: `@wade11s/pi-goal`
   - Permissions: read and write
   - Expiry: the shortest practical window
3. Store it as a repository secret:

   ```sh
   gh secret set NPM_TOKEN   # paste the token when prompted
   ```

4. When npm/cli#9969 is fixed: configure the trusted publisher
   (`wade11s` / `pi-goal` / `publish.yml`, allow `npm publish`), delete the token
   check and `NODE_AUTH_TOKEN` from the workflow, and revoke the token. The
   workflow header carries the same note.

## Every release

```sh
git switch main && git pull --ff-only
# add the release's "## [X.Y.Z]" section to CHANGELOG.md first
npm version patch        # or: minor / major — bumps package.json, commits, tags vX.Y.Z
git push --follow-tags   # pushes the commit and the tag
```

The tag pipeline then:

1. checks that the tag (`vX.Y.Z`) matches `package.json`;
2. extracts that version's `CHANGELOG.md` section and **fails before publishing**
   if it is missing or empty;
3. runs `npm ci`, `npm run typecheck`, and the full `npm test` suite against the
   Pi CLI installed with the dev dependencies (`PI_BINARY`);
4. runs `npm publish --provenance` (which also runs `prepublishOnly`),
   skipping it when the version is already on npm;
5. creates the GitHub release for the tag from the changelog section — or
   updates that release's notes when it already exists.

Watch the run under **Actions → Publish to npm**, then verify:

```sh
npm view @wade11s/pi-goal version
pi install npm:@wade11s/pi-goal@X.Y.Z
```

Preview the release notes locally before tagging:

```sh
npm run release:notes -- X.Y.Z
```

## Rules and recovery

- **npm versions are immutable.** A wrong or failed publish cannot be overwritten
  under the same version; publish the next patch instead.
- **Tags are triggers, not a publish record.** Moving an existing tag does not
  republish a version npm already has; cut a new version. Re-running the workflow
  is safe: a version already on npm is skipped and the GitHub release is created
  or updated.
- **Version, tag, and changelog move together.** `npm version` writes the tag;
  add the matching `## [X.Y.Z]` entry to `CHANGELOG.md` in the same commit. The
  workflow refuses to publish without it, and Pi shows that entry after an
  update.
- **Bad release:** `npm deprecate @wade11s/pi-goal@X.Y.Z "reason"` and publish a
  fixed patch. Unpublishing is only possible within 72 hours, removes the version
  from the registry, and is rarely the right call.
- **Tag protection:** the repository ruleset `Protect release tags` blocks
  deleting or force-pushing `refs/tags/v*`. To correct a tag before it publishes,
  disable the ruleset, move the tag, and re-enable it.
