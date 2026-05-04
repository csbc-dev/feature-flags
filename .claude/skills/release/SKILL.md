---
name: release
description: Manual release procedure for publishing `@csbc-dev/feature-flags` to npm. Use this when the user asks to "release", "publish", "ship a version", "bump the version", "cut v0.x.y", "npm publish", or similar. CI/CD is not yet wired up, so every step runs from a local shell. If `gh` CLI is available, also create a GitHub Release.
---

# Release procedure (manual)

How to publish `@csbc-dev/feature-flags` to npm. CI/CD is planned for the future; for now **every step runs locally and by hand**.

> Invariant:
> **The `main` HEAD, the latest npm version, and the latest git tag must always match.** Never proceed with a release while any one of those three is out of sync.

---

## Prerequisites

- Logged in to npm with publish rights to the `@csbc-dev` org (`npm whoami`).
- Because the package is scoped (`@csbc-dev/...`), the first publish needs `--access public`.
  - To fix this permanently, add `"publishConfig": { "access": "public" }` to `package.json` (you may suggest this as a separate task).
- Remote is `origin = https://github.com/csbc-dev/feature-flags.git`.
- If 2FA is enabled, `npm publish` will prompt for an OTP, so run from an interactive terminal.

---

## 0. Decide the release scope

Inspect the diff between the previous tag and `HEAD`, then pick the semver level (patch / minor / major).

```sh
git fetch --tags
git log --oneline $(git describe --tags --abbrev=0 2>/dev/null || echo "")..HEAD
```

Decision rules:

- **patch** — bug fixes, docs, tests, internal refactors only.
- **minor** — backwards-compatible feature additions (new Provider, new option, new field on `flags`, etc.).
- **major** — breaking changes (removing a public Shell property, changing the `FlagProvider` interface, following a major bump of `@wc-bindable/*`, etc.).

> Pre-1.0 (currently 0.x), it is conventional to map breaking changes onto minor versions, but this package follows the stricter policy: **major for breaking, minor for features, patch for fixes — even before 1.0.**

If no tags exist yet (current state), list every commit with `git log --oneline` and decide where the "release scope" begins.

---

## 1. Pre-flight checks

Every command below must pass before moving on. **If any one fails, abort the release and fix the cause.**

```sh
# 1.1 Branch and working tree
git status                          # → "nothing to commit, working tree clean"
git rev-parse --abbrev-ref HEAD     # → main
git fetch origin && git status -sb  # → ahead/behind both 0

# 1.2 Dependency consistency
npm ci                              # exact install against package-lock.json

# 1.3 Unit tests
npm run test:unit

# 1.4 Coverage (optional but recommended)
npm run test:coverage

# 1.5 Build (prepack will rerun this at publish time, but verify upfront)
npm run build

# 1.6 Integration tests (Playwright — depends on the build)
npm run test:integration

# 1.7 Dry-run the publish payload
npm publish --dry-run
```

In the `npm publish --dry-run` output, visually confirm that **only** `dist/` and `README.md` are included — sources (`src/`), tests (`__tests__/`, `tests/`), and config files must not be packaged. The contents are controlled by the `files` field in `package.json`.

---

## 2. Version decision and tagging

`npm version` updates `package.json`, creates a commit, and creates a tag in one shot. **Do not edit `package.json` by hand.**

```sh
# Pick exactly one
npm version patch -m "chore(release): v%s"
npm version minor -m "chore(release): v%s"
npm version major -m "chore(release): v%s"
```

Verify after running:

```sh
git log -1 --format="%h %s"   # → "xxxxxxx chore(release): v0.x.y"
git tag --points-at HEAD      # → "v0.x.y"
cat package.json | grep version
```

> If you need to undo before pushing:
> ```sh
> git tag -d v0.x.y
> git reset --hard HEAD~1
> ```
> If the tag has already been pushed, you also need `git push origin :refs/tags/v0.x.y`. **Reverting after a push is a destructive operation** — confirm with the user first.

---

## 3. Push to the remote

Send the tag along with the commit. `--follow-tags` only pushes annotated tags reachable from the pushed commits, which is the safe default.

```sh
git push --follow-tags origin main
```

---

## 4. Publish to npm

```sh
# First time (or while publishConfig is unset):
npm publish --access public

# If publishConfig.access=public is in package.json:
npm publish
```

If 2FA is enabled, you will be prompted for an OTP.

Confirm propagation immediately after:

```sh
npm view @csbc-dev/feature-flags version       # → 0.x.y
npm view @csbc-dev/feature-flags dist-tags     # → { latest: '0.x.y' }
```

---

## 5. Create a GitHub Release (if `gh` CLI is available)

Build the release notes from the commit log between tags.

```sh
PREV=$(git describe --tags --abbrev=0 HEAD^ 2>/dev/null)
CURR=$(git describe --tags --abbrev=0 HEAD)

# Draft release notes from git log
git log --oneline "${PREV:-$(git rev-list --max-parents=0 HEAD)}".."$CURR"

# Review, then create
gh release create "$CURR" \
  --title "$CURR" \
  --notes "$(git log --pretty=format:'- %s (%h)' ${PREV:-$(git rev-list --max-parents=0 HEAD)}..$CURR)"
```

Once `CHANGELOG.md` lands later, switch the release-notes body to be the corresponding section of the changelog instead.

---

## 6. Post-publish verification

In a scratch directory, install the published package and verify both the root and `/server` entries resolve.

```sh
cd $(mktemp -d)
npm init -y >/dev/null
npm install @csbc-dev/feature-flags@latest

node -e "import('@csbc-dev/feature-flags/server').then(m => console.log('server ok:', Object.keys(m)))"
# e.g. ['FlagsCore', 'InMemoryFlagProvider', 'FlagsmithProvider', 'UnleashProvider', 'LaunchDarklyProvider']
```

The browser entry (`@csbc-dev/feature-flags`) references `HTMLElement`, so importing it directly from Node is expected to fail. That is correct behavior.

---

## Rollback on failure

| Situation | Response |
|---|---|
| Critical bug discovered immediately after publish | `npm deprecate @csbc-dev/feature-flags@0.x.y "<reason>"` to mark the version, then ship a patch right away. `npm unpublish` is only allowed within 72h **and** breaks downstream consumers — last resort only. |
| Mistake found before publish (tag created, not yet pushed) | Use the undo steps at the end of §2, fix, and start over. |
| Mistake found before publish (already pushed, not yet published) | Delete the tag with `git push origin :refs/tags/v0.x.y`, then `git revert` or force-push the bad commit (force-push requires explicit user confirmation). |

---

## Agent behavior

When this skill is invoked:

1. **Ask the user which release level (patch / minor / major) to take.** Show the diff since the last tag with `git log --oneline` so they have something to base the call on. For the very first release (no tags yet), ask whether to keep the current `package.json` version (e.g. `0.4.0`) or restart from `0.1.0`.
2. Run each command in §1 in order; **stop and report to the user the moment anything goes red.** Do not advance until everything is green.
3. The `npm version` command in §2 must be **explicitly confirmed by the user before running**. Do not edit `package.json` or manipulate commits/tags by hand.
4. §3 `git push` and §4 `npm publish` each require **their own user confirmation** — do not bundle them into a single approval, because their reversibility costs are very different.
5. §5 GitHub Release creation is optional. Run `gh auth status` first to confirm authentication.
6. If §6 verification turns up anything wrong, immediately report it to the user and offer the choices from the rollback table.

> Invariant (restated):
> **The `main` HEAD, the latest npm version, and the latest git tag must always match.** Never leave a state where only one of `publish` and `push` succeeded.
