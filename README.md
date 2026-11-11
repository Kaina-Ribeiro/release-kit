# release-kit

Release automation for GitHub repositories. You merge pull requests; the kit creates the version
tags, opens the follow-up PRs, and tells you when something fails. Deploys are optional: turn
them on and the kit deploys through your own script or through Cubeship.

One kit serves every project. Nothing in it is specific to a project.

- [How it works](#how-it-works)
- [Add it to a project](#add-it-to-a-project)
- [Versions and trust](#versions-and-trust)
- [Reference](#reference): files, tag names, guards
- [Working on the kit](#working-on-the-kit): tests and kit releases

## How it works

```
PR → release/v0.2 → tag v0.2.0-rc (test stage) → prod → merge into main → tag v0.2.0
```

| You do | The kit does |
|:--|:--|
| Merge a PR into `release/v0.2` | Tags the next candidate (`v0.2.0-rc`, `v0.2.1-rc`, …) and, with deploys on, deploys it to the test stage |
| Deploy to prod (Actions → Deploy; only with deploys on) | Deploys the candidate you tested, and checks that it is up |
| Merge `release/v0.2` into the default branch | Tags the final version (`v0.2.1`), writes the release notes, deletes the branch |
| Run `cut-release` or `cut-hotfix` | Creates the next `release/vX.Y`, or a `hotfix/vX.Y` from what is in prod |
| Nothing: a job failed | Opens an issue with the error, and closes it when the job passes again |

Words used below:

| Word | Meaning |
|:--|:--|
| **Version line** | A branch `release/vX.Y` (the next version) or `hotfix/vX.Y` (a fix for what is in prod) |
| **rc** | Release candidate: a tag such as `v0.2.1-rc`, a version ready to be tested |
| **Final** | A tag such as `v0.2.1`: the version that went to prod |
| **Sync PR** | A PR the kit opens to carry changes from one branch to the next version line |
| **Caller** | A small workflow file in the project that runs the kit's workflows |
| **Ruleset** | GitHub's protection rules for branches and tags |

The full rules, for the people working on a project, are in `RELEASING.md`. The kit copies that
file into each project.

## Add it to a project

**In short:** run one command, merge the files it copies, run the commands it prints.

### Before you start

- A clone of the project.
- bash (Git Bash on Windows), `curl`, and Node 18 or newer.
- `gh` logged in as an admin of the project.
- A public repository or a paid GitHub plan. On a free private repository GitHub refuses
  rulesets (HTTP 403); everything else works.

### Step 1: copy the files

From the project's folder:

```bash
curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/install.sh | bash -s -- .
```

To let the kit deploy too, add `--deploy` at the end (step 4).

The script downloads six files (seven with `--deploy`) into the project and prints the commands
for step 3. It does not commit, push or change any setting.

| File copied into the project | What it is |
|:--|:--|
| `.github/workflows/release.yml` | Caller: tags, sync PRs, failure issues (and, with deploys on, each rc to the test stage) |
| `.github/workflows/pr-checks.yml` | Caller: the two checks every PR must pass |
| `.github/workflows/deploy.yml` | Only with `--deploy`. Caller: Actions → Deploy, a tag to test or prod |
| `.github/rulesets/` (3 files) | The rulesets that step 3 sends to GitHub |
| `RELEASING.md` | The rules and procedures for the team |

If one of these files already exists with other content, the script stops. Add `--force` to
overwrite.

Other options:

- `--kit-ref <ref>`: the kit version the callers run (default `v1`). See
  [Versions and trust](#versions-and-trust).
- With a clone of this kit next to the project, the same script copies from that clone instead
  of downloading: `bash ../release-kit/install.sh .` (or `bash install.sh ../my-project` from the
  kit's folder).

### Step 2: merge the files into the default branch

Commit the files and get them into the default branch, by PR or by a direct push on a new
repository.

Do this **before** step 3. After step 3, only version lines can merge into the default branch.

On this one PR the check `pr-checks / conventions` is red, for that same reason. It is not
required yet. Merge anyway.

Installing again later, with the rulesets already on: merge that PR as an admin (bypass), or
open it into the open version line and let it reach the default branch on release day.

### Step 3: apply the GitHub settings

Run the commands the script printed, from the project's folder, in order. They already have
the project's `owner/repo` filled in.

| # | What it sets | Why |
|:--|:--|:--|
| 1 | Merge methods: merge commit and squash on, rebase off | Feature PRs are squashed; a version line is merged with a merge commit |
| 2 | GitHub Actions may open pull requests | The kit opens the sync PRs |
| 3 | Secret `RELEASE_TOKEN` | Without it, the PRs and tags the kit creates start no workflow: a sync PR gets no checks, or a `PR checks` run that fails before any job starts. Re-run that run yourself and it passes |
| 4 | The three rulesets | Protect the default branch, the version lines and the `v*` tags |
| 5 | Optional variables | `TICKET_PATTERN`: the ticket id format, or `none` for branches and titles without a ticket (`feat/login`, `feat: add login`). `CHECKS_COMMAND`: your own PR check (e.g. `make lint`), run instead of the Node steps. `CHECKS_DIRS`, `CHECKS_SCRIPTS`: what the Node steps of the `checks` job run |

About `RELEASE_TOKEN`: use a fine-grained personal access token of an admin, with write access
to contents and pull requests (or a GitHub App token).

Three things to know:

- **Personal account** (no organization): `RELEASE_TOKEN` is required, not optional. The script
  detects the account type and prints the right ruleset commands. If it printed
  `owner type: unknown`, run it again with `RELEASE_KIT_OWNER_TYPE=User` in front.
- **Working alone:** nobody else can approve your PRs. Add yourself to the bypass list of the
  branch rulesets (`RELEASING.md`, "Setup", item 4).
- **Keep "Automatically delete head branches" off** in the repository settings. The kit deletes
  merged branches itself.

More detail on each setting: `RELEASING.md`, "Setup".

### Step 4: deploys (optional)

Skip this step and the kit only creates tags; deploy them with your own tool.

To let the kit deploy, install with `--deploy` (it copies `.github/workflows/deploy.yml` and
prints item 6), then set the targets and one adapter in the project.

GitHub shows Actions → Deploy only once `deploy.yml` is on the default branch. Get it there
before the first release day that needs a prod deploy.

| Name | Kind | Value |
|:--|:--|:--|
| `DEPLOY_TEST_APPS` | variable | The test targets, separated by spaces, in deploy order. Empty = test deploys nothing |
| `DEPLOY_PROD_APPS` | variable | The prod targets, same format. Empty = prod deploys nothing |

| Adapter | Set | A target is |
|:--|:--|:--|
| `command`: your own script, any language | variable `DEPLOY_COMMAND`, e.g. `./scripts/deploy.sh` | Whatever your script understands, e.g. `web` |
| `cubeship` | variable `DEPLOY_URL` (the Cubeship API, e.g. `https://cubeship.example.com/api`), secret `DEPLOY_TOKEN` (an API key with the Deploy role) | `project/environment/app`; the app must build from Git |

The kit picks `command` when `DEPLOY_COMMAND` is set, else `cubeship`. `DEPLOY_ADAPTER`
(`command` or `cubeship`) forces one. The older names `CUBESHIP_URL` and `CUBESHIP_TOKEN` are
still read by the `cubeship` adapter.

- Test: each new rc is deployed by itself.
- Prod: only when you run Actions → Deploy, stage `prod`.
- On release day, `final` tags only if prod runs the last rc.

The `command` adapter runs your script from the project's root, twice per target at most:

```
<DEPLOY_COMMAND> deploy  <stage> <target> <tag>   # exit 0 = the target runs the tag and is up
<DEPLOY_COMMAND> current <stage> <target>         # print the tag or the commit the target runs
```

- Example: `DEPLOY_COMMAND=./scripts/deploy.sh`, `DEPLOY_PROD_APPS=web`. A prod deploy runs
  `./scripts/deploy.sh deploy prod web v0.2.1-rc`.
- The environment also has `RELEASE_TAG`, `RELEASE_SHA` (the tag's commit), `RELEASE_STAGE`,
  `RELEASE_TARGET`, `DEPLOY_URL` and `DEPLOY_TOKEN`.
- `deploy`: any exit other than 0 fails the job, and the next target is not deployed. Limit: 45
  minutes per target.
- `current`: the first line printed is compared with the rc's name and its commit (full SHA or a
  prefix of 7+ characters). The same: `final` tags. Different: `final` refuses. Exit other than
  0: `final` fails. **Nothing printed** (exit 0) means "I don't know": `final` warns in the log
  and the job summary, and tags anyway.
- `DEPLOY_COMMAND` is one script, not a chain: the kit appends the arguments, so in
  `./a.sh && ./b.sh` only `./b.sh` would get them. Put the steps inside the script.
- In a dry run, `deploy` only prints `would run: …`; `current` runs (it only reads).

### Step 5: the first release

1. Actions → Release → Run workflow → `cut-release`. It creates `release/v0.1`.
   To start at another version, fill `version` (e.g. `1.0`).
2. Create a branch `feat/ABC-1-something` from `release/v0.1`.
3. Open a PR into `release/v0.1` with the title `feat(ABC-1): something`. Squash merge it.
4. The kit tags `v0.1.0-rc`.

Release day and everything after: `RELEASING.md`, "Procedures".

### Check the state of a project

Run this from the project's folder, at any time:

```bash
curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/release.mjs -o .git/release.mjs && node .git/release.mjs status
```

It downloads the kit's script into `.git` (never committed) and lists the open lines, the tags
and what is in prod.

### Later

| Situation | What to do |
|:--|:--|
| The kit got a new `v1.x` version | Nothing. The callers follow `@v1`, so the project gets it on its next run |
| You want the newest `RELEASING.md` | Run the step 1 command again with `--force`, then commit the file |
| You want deploys now | Run the step 1 command again with `--deploy`, then follow step 4 |
| The kit got a `v2` (a breaking change) | Each project moves to it with a PR |
| The project's Release workflow still has `deploy` in its menu (install before `v1.2.0`) | Run the step 1 command again with `--force`. It keeps deploys on, adds Actions → Deploy, and prints how to copy `CUBESHIP_URL`/`CUBESHIP_TOKEN` to `DEPLOY_URL`/`DEPLOY_TOKEN` |
| The project still has `.github/scripts/release.mjs` (old install) | Run the step 1 command again with `--force`. It prints how to remove that script and rename the required checks |
| You want to try a kit change before releasing it | Add `--force --kit-ref <branch>` (in the URL too: `…/release-kit/<branch>/install.sh`) on a sandbox project |

## Versions and trust

The callers run the kit at `@v1`. Each new `v1.x` of the kit then runs in your repository, with
your tokens (`RELEASE_TOKEN`, `DEPLOY_TOKEN`), on the next run, without a PR on your side.

If you would rather review each kit change first, pin an exact version and move it by hand:

```bash
curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1.2.0/install.sh | bash -s -- . --kit-ref v1.2.0
```

## Reference

### What is in this repository

| File | Goes into the project? | What it does |
|:--|:--|:--|
| `release.mjs` | No. The kit's workflows run it | All the logic. Commands: `rc`, `final`, `sync`, `cleanup`, `cut-release`, `cut-hotfix`, `deploy`, `deploy-check`, `conventions`, `report`, `status`. With `--dry-run` a command only prints what it would do |
| `adapters/` | No. `release.mjs` loads one when it deploys or checks prod | The deploy adapters: `command.mjs` (the project's script), `cubeship.mjs` |
| `checks.sh` | No. The `checks` job runs it | `CHECKS_COMMAND`, or the Node install, lint and typecheck |
| `.github/workflows/release.yml`, `pr-checks.yml` | No. Reusable workflows (`on: workflow_call`) | The jobs. Each one checks out the project and this kit at `job.workflow_sha` |
| `workflows/release.yml` | Yes, as `.github/workflows/release.yml` | Caller of the kit's `release.yml@v1`. Passes the project's variables and secrets |
| `workflows/deploy.yml` | Only with deploys on, as `.github/workflows/deploy.yml` | Caller of the kit's `release.yml@v1` with `command: deploy` (Actions → Deploy) |
| `workflows/pr-checks.yml` | Yes, as `.github/workflows/pr-checks.yml` | Caller of the kit's `pr-checks.yml@v1` |
| `rulesets/*.json` | Yes, as `.github/rulesets/` | Default branch, version lines and `v*` tags |
| `RELEASING.md` | Yes | The rules, for the people working on the project |
| `install.sh` | No | Copies (or downloads) the files above and prints the settings commands |
| `LICENSE` | No | MIT |

When each job of the release workflow runs:

| Event | Jobs |
|:--|:--|
| Push to a version line | `rc` (tag + sync PR), then a deploy to the test stage (when `DEPLOY_TEST_APPS` is set). A commit that already has a tag (e.g. a fresh cut) gets no rc |
| PR merged into a version line | `cleanup`: deletes the feature branch |
| PR merged into the default branch | `final`: the final tag, plus a sync PR from the default branch into the next open release |
| Actions → Release (manual) | `cut-release` or `cut-hotfix` |
| Actions → Deploy (manual, only with deploys on) | `deploy`: a tag to the test or prod targets |
| An automatic job fails | `report`: one issue per job and line, closed by that job's next success |

The two PR checks:

- `pr-checks / checks`: `CHECKS_COMMAND`, or install, lint, typecheck.
- `pr-checks / conventions`: branch name, PR title, target branch.

### Tag names

Every rc takes the next patch number of X.Y, counted across the release and its hotfix. The
final is the last rc's name without `-rc`.

| Line | Candidates | Final |
|:--|:--|:--|
| `release/vX.Y` | `vX.Y.0-rc`, `vX.Y.1-rc`, … | `vX.Y.Z` |
| `hotfix/vX.Y` | `vX.Y.Z-hf-rc`, starting at the patch after the shipped final | `vX.Y.Z-hf` |

- A `-hf` final counts as a final everywhere: what prod runs, `cut-hotfix`, rollback, latest
  release.
- Older tags (`vX.Y.Z-rc.N`, hotfix tags from before `-hf`) are read, never created.
- Other `v*` tags, such as a manual `v1.0`, are ignored.

### Guards

What the kit refuses, or does by itself, besides tagging. Details in `RELEASING.md`.

| Situation | What the kit does |
|:--|:--|
| `deploy` with the tag empty | Takes the last rc of the line the run starts from, or the tag it starts from. From the default branch it takes the only open line, and refuses when more than one is open (e.g. a hotfix and a release) |
| `deploy` to prod | Takes an rc only if it contains the default branch, so a hotfix already in prod is never lost. Merge the sync PR first |
| A deploy "succeeded" but the app died | Fails, unless the adapter sees each target up (your script's exit code; on Cubeship, the container stays up) |
| `final` while prod runs something else | Refuses until prod runs the last rc. A `command` script that prints nothing for `current` skips this check, with a warning |
| `cut-release` from an open release | Refuses while that release's head has no rc yet |
| A commit that already carries a final, or an older line's rc | Gets no rc |
| A PR from a version line | Accepted only into the default branch or a newer line |
| A line ships (`final`) | Opens `chore(sync): merge <default> into <next release>` when that release lacks it, and comments on the PRs still open from the shipped branch before deleting it |
| A git command fails | Reports git's own message. The tag fetch replaces stale local tags (the remote is the truth) |

## Working on the kit

### Test

```bash
bash test/fixtures.sh "" "$(mktemp -d)"
```

A clean run ends with `✓ all expectations met`. A step that misses prints `✗ MISS` and the
script exits 1. `.github/workflows/test.yml` runs it on every pull request and push to `master`.

What it does:

- Builds a throwaway repository with fixture tags and runs the whole release cycle in
  `--dry-run`.
- `test/cubeship-mock.mjs` stands in for Cubeship, `test/deploy-command.sh` for a project's
  deploy script, and `test/github-mock.mjs` for the GitHub API (section 14b: a real `final`
  opens the sync PR and comments).
- Every step asserts its outcome. `expect ok|fail` checks the exit code. `expect_out ok|fail
  "<text>"` also requires the text in the output. `check` asserts a file or a git state.

The first argument is the source repository:

```bash
bash test/fixtures.sh <source-repo> <empty-scratch-dir>
```

- Empty (`""`): the script builds its own source, a single commit on `main`.
- A repository (`.` for the kit itself): it runs against that repository's default branch, e.g.
  one that is not called `main`.

What it covers, among others:

- One rc per new commit; no rc for a cut at an already-tagged commit (section 2b, and the hotfix
  in section 5).
- The deploy gate, and test and prod deploys.
- A deploy whose container crashloops or exits although Cubeship calls it "succeeded"
  (section 8b).
- Legacy `-rc.N` tags, and hotfix `-hf-rc` → `-hf` tags (section 5).
- Sections 11 and up each start from their own copy of the source and reproduce one bug.
- Section 15 mixes legacy and manual tags with a hotfix that switches to `-hf` mid-way.
- Sections 17 to 23, the generic kit: tags only (17), adapter choice and the Cubeship adapter
  under the new names (18), the `command` adapter (19), the callers (20), `TICKET_PATTERN=none`
  (21), `checks.sh` (22), and `install.sh` in local and download mode (23).

It never pushes outside its scratch copy:

- It stops (exit 1) on a scratch dir that is not empty, or on a failed clone.
- It checks that each clone's only remote is its scratch bare repo.
- It installs a `pre-push` hook there that refuses any other URL. Section 0 proves it.

### Release the kit

Actions → Kit release → `version` = `X.Y.Z`. It is a dry run by default.

1. It runs only from `master`.
2. It runs the tests.
3. It refuses a version that already exists, or that is not greater than the last one.
4. It tags `vX.Y.Z` and moves `vX` to it.

Every project on `@vX` gets the change on its next run. So a release is an outward action: run
it only with the owner's yes. A breaking change takes a new major.
