# Releasing to npm

`@wade11s/pi-goal` publishes from GitHub Actions when a `v*` tag is pushed
(`.github/workflows/publish.yml`). Authentication is npm **Trusted Publishing**
(OIDC), so no long-lived npm token is stored in the repository. Provenance
attestations are generated automatically.

## One-time setup

The first publish must be manual, because a trusted publisher is configured on an
existing npm package page.

1. Publish the first version from a clean `main`:

   ```sh
   npm whoami            # must be wade11s (the @wade11s scope owner)
   npm run typecheck
   npm test              # full RPC suite; needs `pi` 1.5.1+ on PATH
   npm publish           # publishes 0.1.0 (publishConfig.access is public)
   ```

2. Configure the trusted publisher on npmjs.com:
   **@wade11s/pi-goal → Settings → Trusted publishing → GitHub Actions**

   | Field | Value |
   | --- | --- |
   | Organization or user | `wade11s` |
   | Repository | `pi-goal` |
   | Workflow filename | `publish.yml` |
   | Environment name | *(leave empty unless the job uses one)* |

   The configuration must complete its first successful publish within 2 days of
   being created, otherwise it expires and has to be recreated.

3. Recommended hardening: **Settings → Publishing access → Require two-factor
   authentication and disallow tokens**. Trusted publishers keep working; stray
   automation tokens stop working.

## Every release after that

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
4. runs `npm publish` (which also re-runs `prepublishOnly`), skipping it when the
   version is already on npm;
5. creates the GitHub release for the tag, using the changelog section as its
   body — or updates that release's notes when it already exists.

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
- **Token fallback** (if OIDC is unavailable): add a granular read-and-write
  `NPM_TOKEN` repository secret and set
  `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}` on the publish step. Prefer trusted
  publishing; it has no secret to leak or rotate.
