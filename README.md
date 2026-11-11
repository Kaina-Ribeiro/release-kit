# release-kit

Release automation for GitHub repositories. You merge pull requests; the kit creates the version
tags, opens the follow-up PRs, deploys, and tells you when something fails.

One kit serves every project. Nothing in it is specific to a project.

- [How it works](#how-it-works)
- [Add it to a project](#add-it-to-a-project)
- [Reference](#reference): files, tag names, guards
- [Working on the kit](#working-on-the-kit): tests and kit releases

## How it works

```
PR → release/v0.2 → tag v0.2.0-rc (test stage) → prod → merge into main → tag v0.2.0
```

| You do | The kit does |
|:--|:--|
| Merge a PR into `release/v0.2` | Tags the next candidate (`v0.2.0-rc`, `v0.2.1-rc`, …) and deploys it to the test stage |
| Run `deploy` to prod | Deploys the candidate you tested, and checks that the app stays up |
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

**In short:** run one script, merge the six files it copies, run the commands it prints.

### Before you start

- A clone of this kit and a clone of the project, side by side.
- bash (Git Bash on Windows) and Node 18 or newer.
- `gh` logged in as an admin of the project.
- A public repository or a paid GitHub plan. On a free private repository GitHub refuses
  rulesets (HTTP 403); everything else works.

### Step 1: copy the files

From the kit's folder:

```bash
bash install.sh ../my-project
```

The script copies six files and prints the commands for step 3. It does not commit, push or
change any setting.

| File copied into the project | What it is |
|:--|:--|
| `.github/workflows/release.yml` | Caller: tags, sync PRs, deploys, failure issues |
| `.github/workflows/pr-checks.yml` | Caller: the two checks every PR must pass |
| `.github/rulesets/` (3 files) | The rulesets that step 3 sends to GitHub |
| `RELEASING.md` | The rules and procedures for the team |

If one of these files already exists with other content, the script stops. Add `--force` to
overwrite.

### Step 2: merge the files into the default branch

Commit the six files and get them into the default branch, by PR or by a direct push on a new
repository.

Do this **before** step 3. After step 3, only version lines can merge into the default branch.

On this one PR the check `pr-checks / conventions` is red, for that same reason. It is not
required yet. Merge anyway.

### Step 3: apply the GitHub settings

Run the commands the script printed, from the project's folder, in order. They already have
the project's `owner/repo` filled in.

| # | What it sets | Why |
|:--|:--|:--|
| 1 | Merge methods: merge commit and squash on, rebase off | Feature PRs are squashed; a version line is merged with a merge commit |
| 2 | GitHub Actions may open pull requests | The kit opens the sync PRs |
| 3 | Secret `RELEASE_TOKEN` | Without it, the PRs and tags the kit creates start no workflow, so sync PRs never get their checks |
| 4 | The three rulesets | Protect the default branch, the version lines and the `v*` tags |
| 5 | Optional variables | `TICKET_PATTERN`: the ticket id format. `CHECKS_DIRS`, `CHECKS_SCRIPTS`: what the `checks` job runs |

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

To let the kit deploy through Cubeship, set these in the project:

| Name | Kind | Value |
|:--|:--|:--|
| `CUBESHIP_URL` | variable | The Cubeship API, e.g. `https://cubeship.example.com/api` |
| `DEPLOY_TEST_APPS` | variable | The test apps, as `project/environment/app`, separated by spaces, in deploy order |
| `DEPLOY_PROD_APPS` | variable | The prod apps, same format |
| `CUBESHIP_TOKEN` | secret | A Cubeship API key with the Deploy role |

- Test: each new rc is deployed by itself.
- Prod: only when you run Actions → Release → `deploy`, stage `prod`.
- The apps must build from Git. The kit points each app at the tag.
- An empty list turns that stage off.

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
| You want the newest `RELEASING.md` | `bash install.sh ../my-project --force`, then commit the file |
| The kit got a `v2` (a breaking change) | Each project moves to it with a PR |
| The project still has `.github/scripts/release.mjs` (old install) | `bash install.sh ../my-project --force`. It prints how to remove that script and rename the required checks |
| You want to try a kit change before releasing it | `bash install.sh ../sandbox --force --kit-ref <branch>` points the callers at that branch |

## Reference

### What is in this repository

| File | Goes into the project? | What it does |
|:--|:--|:--|
| `release.mjs` | No. The kit's workflows run it | All the logic. Commands: `rc`, `final`, `sync`, `cleanup`, `cut-release`, `cut-hotfix`, `deploy`, `deploy-check`, `conventions`, `report`, `status`. With `--dry-run` a command only prints what it would do |
| `.github/workflows/release.yml`, `pr-checks.yml` | No. Reusable workflows (`on: workflow_call`) | The jobs. Each one checks out the project and this kit at `job.workflow_sha` |
| `workflows/release.yml` | Yes, as `.github/workflows/release.yml` | Caller of the kit's `release.yml@v1`. Passes the project's variables and secrets |
| `workflows/pr-checks.yml` | Yes, as `.github/workflows/pr-checks.yml` | Caller of the kit's `pr-checks.yml@v1` |
| `rulesets/*.json` | Yes, as `.github/rulesets/` | Default branch, version lines and `v*` tags |
| `RELEASING.md` | Yes | The rules, for the people working on the project |
| `install.sh` | No | Copies the files above and prints the settings commands |

When each job of the release workflow runs:

| Event | Jobs |
|:--|:--|
| Push to a version line | `rc` (tag + sync PR), then a deploy to the test stage. A commit that already has a tag (e.g. a fresh cut) gets no rc |
| PR merged into a version line | `cleanup`: deletes the feature branch |
| PR merged into the default branch | `final`: the final tag, plus a sync PR from the default branch into the next open release |
| Run workflow (manual) | `cut-release`, `cut-hotfix` or `deploy` |
| An automatic job fails | `report`: one issue per job and line, closed by that job's next success |

The two PR checks:

- `pr-checks / checks`: install, lint, typecheck.
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
| A deploy "succeeded" but the app died | Fails, unless each app's container stays up |
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
- `test/cubeship-mock.mjs` stands in for Cubeship and `test/github-mock.mjs` for the GitHub API
  (section 14b: a real `final` opens the sync PR and comments).
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
