# Releasing

How code moves from a pull request to production in this repository. The automation in
`.github/` enforces these rules; `.github/scripts/release.mjs` holds the logic.

## Model

- **Default branch** (`master` or `main`) = what is in prod. Only `release/vX.Y` and
  `hotfix/vX.Y` merge into it.
- **Version lines**: `release/vX.Y` is the next version; `hotfix/vX.Y` fixes what is in prod.
- **Tags** follow SemVer: `vX.Y.Z-rc.N` is a release candidate, `vX.Y.Z` is shipped.
- **Patch number**: `.0` until the line ships, then the last shipped patch + 1
  (`release/v0.2` ships `v0.2.0`; `hotfix/v0.2` then ships `v0.2.1`, `v0.2.2`, …).
- Tags, GitHub releases, new version lines and sync PRs are created **only by the automation**.
  Never create, move or delete a tag by hand.

## Naming

- Branch: `<type>/<TICKET>-short-name`, e.g. `feat/ABC-12-login`.
- PR title and squash commit: Conventional Commits, `type(TICKET): summary`, imperative,
  lowercase, e.g. `feat(ABC-12): add login`. The ticket must match the branch.
- Types: `feat`, `fix`, `chore`, `refactor`, `perf`, `docs`, `test`, `ci`, `build`, `revert`.
- PRs from a version line (release day, hotfix, sync) take any Conventional Commits title,
  e.g. `chore(release): ship release/v0.2`.
- GitHub "Revert" PRs (`revert-123-…`, `Revert "…"`) are accepted as they come.

## Procedures

1. **Feature or fix**: find the open release it ships in (a `release/vX.Y` not yet shipped;
   ask if more than one fits). Branch from it, PR into it, **squash** merge.
   The push tags `vX.Y.Z-rc.N` and opens a sync PR into the next open release, if any.
2. **Remove a feature from a release**: GitHub "Revert" on its PR, into that release.
   Reapply it in the next release by reverting the revert.
3. **New release**: Actions → Release → Run workflow → `cut-release`. It branches from the
   newest open release, or from the default branch if none is open. Never create `release/*`
   by hand. `version` forces a line such as `1.0` for a major bump.
4. **Release day**: PR `release/vX.Y` → default branch, **merge commit** (never squash or
   rebase). The release must contain the default branch first (the `conventions` check says so),
   so prod gets exactly the code of the last rc. The merge tags `vX.Y.0` with release notes.
5. **Hotfix**: Actions → Release → `cut-hotfix` (branches from the final tag in prod; if the
   branch already exists it is reused). Fix PRs into `hotfix/vX.Y` (squash) → test the rc →
   PR into the default branch (merge commit) → `vX.Y.Z`.
6. **Sync PRs** (`chore(sync): merge A into B`, opened automatically): review and merge with a
   **merge commit**. On conflicts, resolve on a branch cut from the target, never on the source.

## Deploy gate

`node .github/scripts/release.mjs deploy-check <tag> [--prod]` exits non-zero when a deploy
breaks the rules. Call it from any deploy tool before deploying.

- Test stages: any `vX.Y.Z-rc.N` or `vX.Y.Z`, any time. Branch names never deploy.
- Prod: only a final `vX.Y.Z`, only on release day, and only if its code equals its last
  `vX.Y.Z-rc.N`.

## Before acting

- `git fetch --all --tags` first; reason from remote state, not local.
- Confirm with the owner before anything outward-facing: push, opening or merging PRs, running
  workflows, deploying, changing repository settings.
- Never push directly to the default branch, `release/*` or `hotfix/*`. Never force-push them.
- If something looks off (a release not based on the previous open release, a final tag whose
  code differs from its last rc, a manual tag), report it before continuing.
  `node .github/scripts/release.mjs status` lists the state and flags manual tags.

## When the automation refuses

- **`final` refused, "differs from vX.Y.Z-rc.N"**: the default branch had changes the release
  did not. Nothing was tagged. Merge the default branch into the version line with a PR (new rc),
  then PR the line into the default branch again.
- **`final` refused, "no rc"**: the line was never tagged as a candidate. Push a change to the
  line (or re-run its last Release run) so it gets an rc, then merge again.
- **`rc` refused, "already shipped"**: that release line is done. Fixes for prod go through
  `cut-hotfix`; new work goes to the next release.

## Setup

Files: `.github/scripts/release.mjs`, `.github/workflows/release.yml`,
`.github/workflows/pr-checks.yml`, `.github/rulesets/*.json`, this file.
`install.sh` in the release kit copies them and prints the `gh api` commands below.

1. **Repository merge settings**: allow merge commits and squash merging; rebase off.
2. **Actions → Workflow permissions**: allow GitHub Actions to create pull requests
   (needed for sync PRs).
3. **Token** (strongly recommended): add a `RELEASE_TOKEN` secret, a GitHub App installation
   token or an admin's fine-grained PAT with contents and pull-requests write. Without it the
   workflow falls back to `GITHUB_TOKEN`, and GitHub does not trigger workflows for what that
   token creates: sync PRs get no `checks`/`conventions` runs and cannot merge, and pushed tags
   do not start tag-based deploys. If the token is not an admin's, add its app to the
   `version-tags` and `version-lines` ruleset bypass lists.
4. **Rulesets**, applied with `gh api` (see `install.sh` output):
   - `default-branch`: PR with 1 approval, `checks` + `conventions` required, merge commit
     only, no force push, no deletion.
   - `version-lines` (`release/v*`, `hotfix/v*`): the same, squash and merge commit allowed.
     GitHub Actions may bypass it so the automation can create the branches.
   - `version-tags` (`v*`): only GitHub Actions (app id 15368) and admins can create, update
     or delete.
   Solo repository? Nobody else can approve; add yourself (repository admin role, id 5) to the
   branch rulesets' bypass list with `"bypass_mode": "pull_request"`.
5. **Optional variables**: `TICKET_PATTERN` (default `[A-Z][A-Z0-9]+-\d+`), `CHECKS_DIRS`,
   `CHECKS_SCRIPTS` (see `pr-checks.yml`).
6. Bots that open PRs against the default branch (Dependabot, Renovate) must target the open
   release instead (Dependabot: `target-branch`), or the `conventions` check fails.

Tags created before the automation stay as history; `status` lists them as manual.
