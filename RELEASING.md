# Releasing

How code moves from a pull request to production in this repository. The workflows in
`.github/workflows` enforce these rules: they call the release kit
([Kaina-Ribeiro/release-kit](https://github.com/Kaina-Ribeiro/release-kit)) pinned at `@v1`,
whose `release.mjs` holds the logic. A kit fix reaches this repository without a PR.

To run a command locally (always the pinned version; the file stays inside `.git`, never
committed):

```bash
curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/release.mjs -o .git/release.mjs && node .git/release.mjs status
```

## Model

- **Default branch** (`master` or `main`) = what is in prod. Only `release/vX.Y` and
  `hotfix/vX.Y` merge into it.
- **Version lines**: `release/vX.Y` is the next version; `hotfix/vX.Y` fixes what is in prod.
- **Tags**: a release candidate (rc) and a final (shipped) per line kind:

  | Line | Candidates | Final |
  |:--|:--|:--|
  | `release/v1.29` | `v1.29.0-rc`, `v1.29.1-rc`, … | `v1.29.7` |
  | `hotfix/v1.29` | `v1.29.8-hf-rc`, `v1.29.9-hf-rc`, … | `v1.29.9-hf` |

- **Patch number**: every rc takes the next patch of X.Y, counted across its release and its
  hotfix, and the final is the last rc's name without `-rc`. `release/v0.2` tags `v0.2.0-rc`,
  `v0.2.1-rc`, `v0.2.2-rc` and ships `v0.2.2`; `hotfix/v0.2` then tags `v0.2.3-hf-rc`, … and
  ships the last one, e.g. `v0.2.3-hf`.
- **A `-hf` tag is a final** like `vX.Y.Z`: prod runs it, the next hotfix branches from it, a
  rollback can deploy it, and its GitHub release is marked latest.
- **Older tags are read, never created**: `vX.Y.Z-rc.N` candidates and hotfix tags from before
  `-hf` (`vX.Y.Z-rc` → `vX.Y.Z` on a hotfix line). A hotfix in progress when the kit updated
  gets `-hf-rc` from its next rc on, and its final follows the last rc's name.
- For SemVer, `-hf` is a pre-release (`v1.29.9-hf` sorts before `v1.29.9`). The automation
  orders tags itself (by X.Y.Z, the rc before the final); tools that sort by SemVer may not.
- Tags, GitHub releases, new version lines and sync PRs are created **only by the automation**.
  Never create, move or delete a tag by hand.

## Naming

- Branch: `<type>/<TICKET>-short-name`, e.g. `feat/ABC-12-login`.
- PR title and squash commit: Conventional Commits, `type(TICKET): summary`, imperative,
  lowercase, e.g. `feat(ABC-12): add login`. The ticket must match the branch.
- Without tickets (`TICKET_PATTERN` set to `none`): branch `<type>/short-name`, e.g.
  `feat/login`; title `type: summary` or `type(scope): summary`, e.g. `feat: add login`.
- Types: `feat`, `fix`, `chore`, `refactor`, `perf`, `docs`, `test`, `ci`, `build`, `revert`.
- PRs from a version line (release day, hotfix, sync) take any Conventional Commits title,
  e.g. `chore(release): ship release/v0.2`. So do sync PRs from the default branch into a
  version line, e.g. `chore(sync): merge main into release/v0.3`.
- A version line merges only into the default branch or a newer line (`hotfix/v0.2` →
  `release/v0.3`, never `release/v0.3` → `hotfix/v0.2`).
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
   by hand. `version` forces a line such as `1.0` for a major bump. Cut only after the newest
   open release's last push got its rc: until then `cut-release` refuses (its Release run may
   still be running), so the older line never loses that rc. A fresh line has no new code, so it
   gets no rc (and no test deploy) until the first PR merges into it: a commit that already
   carries a final or an older line's rc never becomes an rc.
4. **Release day**: prod gets the rc you tested, then the merge only records it.
   1. Merge any open sync PR into the release first (it brings what prod already has, such as a
      shipped hotfix; prod refuses an rc without it). Then test the line's last rc on the test stage.
   2. Actions → Deploy → Run workflow, **from the release branch**, stage `prod`, tag empty
      (= that branch's last rc). Without deploys configured, deploy that rc with your own tool
      after `deploy-check <rc> --prod`.
   3. PR `release/vX.Y` → default branch, **merge commit** (never squash or rebase). The release
      must contain the default branch first (the `conventions` check says so). The merge tags
      that rc's version as final (`v0.2.2-rc` → `v0.2.2`) with release notes, without deploying
      again, and deletes the shipped branch. Before deleting it, if the next open release lacks
      the default branch, it opens `chore(sync): merge <default> into release/vX.Y` (merge it
      before that release's own release day), and it comments on each PR still open from the
      shipped branch, which GitHub closes with the branch, saying where its changes went.
5. **Hotfix**: Actions → Release → `cut-hotfix` (branches from the final tag in prod; if the
   branch already exists it is reused; it gets its first rc with the first fix, never at the
   final tag itself). Fix PRs into `hotfix/vX.Y` (squash; each push tags the next
   `vX.Y.Z-hf-rc`) → test the rc → Actions → Deploy, stage `prod`, **run from `hotfix/vX.Y`**
   with the tag empty (= its last rc) → PR into the default branch (merge commit) → the last rc ships as its
   final (`vX.Y.Z-hf-rc` → `vX.Y.Z-hf`), the sync PR from the default branch into the open
   release (as in 4.3), and the branch is deleted.
6. **Sync PRs** (`chore(sync): merge A into B`, opened automatically): review and merge with a
   **merge commit**. There are two kinds: from a version line into the next open release (on
   each push to the line), and from the default branch into the first open release (after each
   ship, `chore(sync): merge <default> into release/vX.Y`). On conflicts, resolve on a branch cut
   from the target, never on the source.

## Deploys

Every stage runs a **tag**, never a branch: you always know what is live, and rollback is
pointing back at the previous tag.

- Test stage: any release tag (`vX.Y.Z-rc`, `vX.Y.Z`, `vX.Y.Z-hf-rc` or `vX.Y.Z-hf`), any time.
  Each new rc deploys there by itself; a push that makes no rc (a cut) deploys nothing.
- Prod: the last rc of an open line **that contains the default branch** (release day, before
  the merge), or a final (`vX.Y.Z` or `vX.Y.Z-hf`) whose code equals its rc (`vX.Y.Z-rc` or
  `vX.Y.Z-hf-rc`: rollback). An older rc is refused, and
  so is an rc that lacks something the default branch has (e.g. a hotfix shipped meanwhile): prod
  would lose it. Merge the open sync PR (or the default branch) into the line, then deploy the new rc.
- The `final` tag is created only if prod already runs the line's last rc (when prod deploys
  are configured), so a final always names what prod runs.

Deploys are optional. Without them the kit only creates tags, and you deploy with your own tool.
With them, the targets of each stage are listed in `DEPLOY_TEST_APPS` and `DEPLOY_PROD_APPS`
(in order; an empty list deploys nothing), and a **deploy adapter** does the work for each
target: `command` (this repository's own script) or `cubeship`.

`node .git/release.mjs deploy-check <tag> [--prod]` (fetched as at the top of this file) exits
non-zero when a deploy breaks these rules; call it from any other deploy tool. `deploy <tag> --stage test|prod` runs it,
then deploys the tag to each target through the adapter, in order, and stops at the first that
fails. Actions → Deploy is the same as a button (also for rollback; on an older install it is
Actions → Release, command `deploy`). With the tag empty it deploys the last rc of the line you
run it from (`release/vX.Y` or `hotfix/vX.Y`), or the tag you run it from. Run from the default
branch, it takes the only open line's last rc and refuses when more than one line is open (a
hotfix and a release): run it from the line's branch instead.

### Command adapter

`DEPLOY_COMMAND` (e.g. `./scripts/deploy.sh`) is run from the repository's root:

```
<DEPLOY_COMMAND> deploy  <stage> <target> <tag>   # exit 0 = the target runs the tag and is up
<DEPLOY_COMMAND> current <stage> <target>         # print the tag or the commit the target runs
```

- The environment also has `RELEASE_TAG`, `RELEASE_SHA` (the tag's commit), `RELEASE_STAGE`,
  `RELEASE_TARGET`, `DEPLOY_URL` and `DEPLOY_TOKEN`.
- `deploy`: an exit other than 0 fails the job, and the next target is not deployed. Limit: 45
  minutes per target. Running it again for the same tag must be safe.
- `current`: `final` compares the first line printed with the rc's name and its commit (full SHA
  or a prefix of 7+ characters). The same: it tags. Different: it refuses (`prod does not run`).
  Exit other than 0: it fails. Nothing printed with exit 0 means "unknown": it warns in the log
  and the job summary and tags anyway, so that target skips the prod check.
- One script, not a chain: the kit appends the arguments to `DEPLOY_COMMAND`, so in
  `./a.sh && ./b.sh` only `./b.sh` gets them (and the whole chain also runs for `current`).
- In a dry run `deploy` only prints `would run: …`; `current` runs (it only reads).

### Cubeship adapter

A target is `project/environment/app`. The kit points the app's `ref` at the tag, deploys it and
waits.

**A deploy is green only if the app stays up.** Cubeship calls a deploy "succeeded" as soon as
it starts the new container, even when the process dies a second later (a missing env var, a
failed migration) and crashloops. So after each app, `deploy` watches Cubeship's live container
list and fails, red in Actions, unless that deploy's container comes up and is not restarted for
60 s; the next app in the list is not deployed. A re-run checks again instead of trusting the
earlier "succeeded". When it fails: read the app's logs in Cubeship, fix and ship a new rc, or
roll back by deploying the previous tag.

## Before acting

- `git fetch --all --tags` first; reason from remote state, not local.
- Confirm with the owner before anything outward-facing: push, opening or merging PRs, running
  workflows, deploying, changing repository settings.
- Never push directly to the default branch, `release/*` or `hotfix/*`. Never force-push them.
- If something looks off (a release not based on the previous open release, a final tag whose
  code differs from its last rc, a manual tag), report it before continuing.
  `node .git/release.mjs status` (fetched as at the top of this file) lists the state and flags
  manual tags.

## When the automation refuses

- **`final` refused, "differs from vX.Y.Z-rc"**: the default branch had changes the release
  did not. Nothing was tagged. Merge the sync PR from the default branch
  (`chore(sync): merge <default> into <line>`, or open one) into the version line (new rc), then
  PR the line into the default branch again.
- **`deploy` refused, "lacks what <default> has"**: the rc misses something prod already runs
  (e.g. a hotfix shipped after the rc). Merge the open sync PR from the default branch into the
  line, then deploy the new rc.
- **`deploy` refused, "N lines are open"**: the run started from the default branch with the tag
  empty, and more than one line could be meant. Run it from the line's branch, or pass the tag.
- **`cut-release` refused, "has no rc yet"**: the newest release's last push is still being
  tagged. Wait for its Release run, then cut again.
- **`final` refused, "no rc"**: the line was never tagged as a candidate. Push a change to the
  line (or re-run its last Release run) so it gets an rc, then merge again.
- **`final` refused, "prod does not run vX.Y.Z-rc"**: the release was merged before prod got its
  last rc. Nothing was tagged and the branch stays. Deploy that rc to prod (Actions → Deploy,
  stage `prod`), then re-run the failed `final` job.
- **`rc` or `final` failed after pushing the tag** (e.g. GitHub could not create the release):
  re-run the failed job. The re-run sees the tag, creates the missing release or prerelease, and
  finishes what the first run left (for `final`: the sync PR, the comments, the branch delete).
- **`rc` refused, "already shipped"**: that release line is done. Fixes for prod go through
  `cut-hotfix`; new work goes to the next release.

## When the automation fails

- When an automatic job (`rc`, `deploy-test`, `final`, `cleanup`) fails, the Release run's
  `report` job opens an issue `Release automation failing: <job> on <line>` (label
  `release-kit`) with the run link and the error. Manual runs (Actions → Deploy, cuts) open none.
- The next failure of the same job on the same line comments on that issue; it never opens a
  second one. The next success of that job on that line comments `Fixed by <run>` and closes it.
  A success on another line or job leaves it open.
- To act: read the error, find it under "When the automation refuses" above, fix the cause, then
  re-run the failed job (or push to the line). Do not close the issue by hand while the job still
  fails: the next failure would open a new one.
- If the `report` job cannot reach GitHub, it only warns: the failed job stays red either way.

## Setup

Files: `.github/workflows/release.yml`, `.github/workflows/pr-checks.yml` and, with deploys on,
`.github/workflows/deploy.yml` (short callers of the kit's reusable workflows at `@v1`: they pass
the variables and secrets below to the kit), `.github/rulesets/*.json`, this file. `install.sh`
in the release kit copies them and prints the `gh api` commands below. Kit versions: `vX.Y.Z` tags and a moving `v1`; a breaking change
becomes `v2`, and each repository moves to it by PR.

1. **Repository merge settings**: allow merge commits and squash merging; rebase off. Turn off
   "Automatically delete head branches": it would delete a release on merge even when `final`
   refuses.
2. **Actions → Workflow permissions**: allow GitHub Actions to create pull requests
   (needed for sync PRs).
3. **Token** (strongly recommended): add a `RELEASE_TOKEN` secret, a GitHub App installation
   token or an admin's fine-grained PAT with contents and pull-requests write. Without it the
   workflow falls back to `GITHUB_TOKEN`, and GitHub does not trigger workflows for what that
   token creates: sync PRs get no `pr-checks / checks` / `pr-checks / conventions`
   runs (or a `PR checks` run that fails before any job starts; re-run it yourself and it
   passes) and cannot merge, and pushed tags do not start tag-based deploys. If the token is not an admin's, add its app to the
   `version-tags` and `version-lines` ruleset bypass lists.
4. **Rulesets**, applied with `gh api` (see `install.sh` output):
   - `default-branch`: PR with 1 approval, `pr-checks / checks` + `pr-checks / conventions`
     required (the caller job `pr-checks` / the kit's jobs), merge commit
     only, no force push, no deletion.
   - `version-lines` (`release/v*`, `hotfix/v*`): the same, squash and merge commit allowed.
     GitHub Actions may bypass it so the automation can create the branches.
   - `version-tags` (`v*`): only GitHub Actions (app id 15368) and admins can create, update
     or delete.
   Solo repository? Nobody else can approve; add yourself (repository admin role, id 5) to the
   branch rulesets' bypass list with `"bypass_mode": "pull_request"`.
   **Personal account** (no organization): GitHub rejects the GitHub Actions app as a bypass
   actor (HTTP 422 "Actor GitHub Actions integration must be part of the ruleset source or
   owner organization"). `install.sh` detects the owner type and then prints commands that send
   `version-lines` and `version-tags` without that actor and with the admin role (id 5,
   `"bypass_mode": "always"`) instead; the files in `.github/rulesets` stay as the kit ships
   them. Here `RELEASE_TOKEN` is required and must be an admin's PAT: `GITHUB_TOKEN` cannot
   bypass, so the automation could not create version lines or tags. If detection fails,
   re-run with `RELEASE_KIT_OWNER_TYPE=User`.
   Upgrading from the copied `.github/scripts/release.mjs`: `install.sh` also prints the
   commands that remove it and rename the required checks in the existing rulesets
   (`checks` → `pr-checks / checks`, `conventions` → `pr-checks / conventions`).
5. **Optional variables**: `TICKET_PATTERN` (default `[A-Z][A-Z0-9]+-\d+`; `none` drops the
   ticket, see "Naming"), `CHECKS_COMMAND` (this repository's own PR check, e.g. `make lint`, run
   from the root with `bash -euo pipefail -c` instead of the Node steps), `CHECKS_DIRS`,
   `CHECKS_SCRIPTS` (the Node steps; see `pr-checks.yml`).
6. **Deploys** (optional): install with `install.sh --deploy`, which adds
   `.github/workflows/deploy.yml` (it turns itself on when the repository already has that file,
   or a Release workflow with `deploy` in its menu). Actions → Deploy exists only once that
   file is on the default branch. Variables `DEPLOY_TEST_APPS` and
   `DEPLOY_PROD_APPS` (the targets, space-separated, in deploy order; an empty list turns that
   stage off), and one adapter (see "Deploys"); `DEPLOY_ADAPTER` (`command` or `cubeship`)
   forces one, otherwise `command` when `DEPLOY_COMMAND` is set, else `cubeship`:
   - `command`: variable `DEPLOY_COMMAND`, the script to run.
   - `cubeship`: variable `DEPLOY_URL` (the API, e.g. `https://cubeship.example.com/api`) and a
     `DEPLOY_TOKEN` secret: a Cubeship API key that can manage the apps. Targets are
     `project/environment/app`, e.g. `npac/itodev/api npac/itodev/web`. The apps must build
     from Git (dockerfile or railpack); the automation sets their `ref` to the tag. The older
     names `CUBESHIP_URL` and `CUBESHIP_TOKEN` are still read when the new ones are empty, but
     the callers installed from `v1.2.0` on pass only `DEPLOY_URL` and `DEPLOY_TOKEN`: set those
     (`install.sh` prints the commands) or the next deploy fails with "no deploy adapter is
     configured".
   The Cubeship health check after each deploy reads Cubeship's live containers, so the key needs view on
   servers (Cubeship's Deploy role has it). Optional variables: `RELEASE_HEALTH_STABLE_S`, how
   long a new container must run without restarting (default `60`; `0` turns the check off), and
   `RELEASE_HEALTH_WAIT_S`, how long to wait for it to come up (default `300`). Each deploy takes
   about a minute longer because of it.
7. Bots that open PRs against the default branch (Dependabot, Renovate) must target the open
   release instead (Dependabot: `target-branch`), or the `conventions` check fails.

Tags created before the automation stay as history; `status` lists them as manual.
