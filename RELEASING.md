# Releasing

How code moves from a pull request to production in this repository. The automation in
`.github/` enforces these rules; `.github/scripts/release.mjs` holds the logic.

## Model

- **Default branch** (`master` or `main`) = what is in prod. Only `release/vX.Y` and
  `hotfix/vX.Y` merge into it.
- **Version lines**: `release/vX.Y` is the next version; `hotfix/vX.Y` fixes what is in prod.
- **Tags** follow SemVer: `vX.Y.Z-rc` is a release candidate, `vX.Y.Z` is shipped.
- **Patch number**: every rc takes the next patch, and the final is the last rc without `-rc`.
  `release/v0.2` tags `v0.2.0-rc`, `v0.2.1-rc`, `v0.2.2-rc` and ships `v0.2.2`; `hotfix/v0.2`
  then tags `v0.2.3-rc`, … Older `vX.Y.Z-rc.N` tags are still read, never created.
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
   ask if more than one fits). Branch from it, PR into it, **squash** merge. The automation
   deletes your branch after the merge.
   The push tags the next `vX.Y.Z-rc`, deploys it to the test stage (if configured) and opens a
   sync PR into the next open release, if any.
2. **Remove a feature from a release**: GitHub "Revert" on its PR, into that release.
   Reapply it in the next release by reverting the revert.
3. **New release**: Actions → Release → Run workflow → `cut-release`. It branches from the
   newest open release, or from the default branch if none is open. Never create `release/*`
   by hand. `version` forces a line such as `1.0` for a major bump.
4. **Release day**: prod gets the rc you tested, then the merge only records it.
   1. Test the line's last rc on the test stage.
   2. Actions → Release → Run workflow, **from the release branch** → `deploy`, stage `prod`,
      tag empty (= the newest open release's last rc). Without deploys configured, deploy that rc
      with your own tool after `deploy-check <rc> --prod`.
   3. PR `release/vX.Y` → default branch, **merge commit** (never squash or rebase). The release
      must contain the default branch first (the `conventions` check says so). The merge tags
      that rc's version as final (`v0.2.2-rc` → `v0.2.2`) with release notes, without deploying
      again, and deletes the shipped branch.
5. **Hotfix**: Actions → Release → `cut-hotfix` (branches from the final tag in prod; if the
   branch already exists it is reused). Fix PRs into `hotfix/vX.Y` (squash) → test the rc →
   `deploy` to prod with that rc's tag → PR into the default branch (merge commit) → the last
   rc's `vX.Y.Z`, and the branch is deleted.
6. **Sync PRs** (`chore(sync): merge A into B`, opened automatically): review and merge with a
   **merge commit**. On conflicts, resolve on a branch cut from the target, never on the source.

## Deploys

Every stage runs a **tag**, never a branch: you always know what is live, and rollback is
pointing back at the previous tag.

- Test stage: any `vX.Y.Z-rc` or `vX.Y.Z`, any time. Each new rc deploys there by itself.
- Prod: the last rc of an open line (release day, before the merge), or a final `vX.Y.Z` whose
  code equals its rc (rollback). An older rc is refused.
- The `final` tag is created only if prod already runs the line's last rc (when prod deploys
  are configured), so a final always names what prod runs.

`node .github/scripts/release.mjs deploy-check <tag> [--prod]` exits non-zero when a deploy
breaks these rules; call it from any other deploy tool. `deploy <tag> --stage test|prod` runs it,
then points each app at the tag and deploys it on Cubeship, in order, waiting for each.
Actions → Release → `deploy` is the same as a button (also for rollback).

## Before acting

- `git fetch --all --tags` first; reason from remote state, not local.
- Confirm with the owner before anything outward-facing: push, opening or merging PRs, running
  workflows, deploying, changing repository settings.
- Never push directly to the default branch, `release/*` or `hotfix/*`. Never force-push them.
- If something looks off (a release not based on the previous open release, a final tag whose
  code differs from its last rc, a manual tag), report it before continuing.
  `node .github/scripts/release.mjs status` lists the state and flags manual tags.

## When the automation refuses

- **`final` refused, "differs from vX.Y.Z-rc"**: the default branch had changes the release
  did not. Nothing was tagged. Merge the default branch into the version line with a PR (new rc),
  then PR the line into the default branch again.
- **`final` refused, "no rc"**: the line was never tagged as a candidate. Push a change to the
  line (or re-run its last Release run) so it gets an rc, then merge again.
- **`final` refused, "prod does not run vX.Y.Z-rc"**: the release was merged before prod got its
  last rc. Nothing was tagged and the branch stays. Run `deploy` to prod with that rc, then
  re-run the failed `final` job.
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
6. **Deploys** (optional, Cubeship): variables `CUBESHIP_URL` (the API, e.g.
   `https://cubeship.example.com/api`), `DEPLOY_TEST_APPS` and `DEPLOY_PROD_APPS`
   (`project/environment/app`, space-separated, in deploy order, e.g. `npac/itodev/api
   npac/itodev/web`), and a `CUBESHIP_TOKEN` secret: a Cubeship API key that can manage those
   apps. The apps must build from Git (dockerfile or railpack); the automation sets their `ref`
   to the tag. An empty list turns that stage off. Turn off GitHub's "Automatically delete head
   branches": it would delete a release on merge even when `final` refuses.
7. Bots that open PRs against the default branch (Dependabot, Renovate) must target the open
   release instead (Dependabot: `target-branch`), or the `conventions` check fails.

Tags created before the automation stay as history; `status` lists them as manual.
