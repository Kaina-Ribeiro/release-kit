# release-kit

Branch, PR, tag and release automation for GitHub repositories, with no repository-specific
values. `RELEASING.md` holds the rules it enforces; it is copied into each repository.

## What it contains

| File | Installed as | Does |
|:--|:--|:--|
| `release.mjs` | `.github/scripts/release.mjs` | `rc`, `final`, `sync`, `cleanup`, `cut-release`, `cut-hotfix`, `deploy` (fails unless each app stays up), `deploy-check`; `--dry-run` |
| `workflows/release.yml` | `.github/workflows/release.yml` | rc + sync + test-stage deploy on push to a version line (none for a commit already tagged, e.g. a cut), branch cleanup on merge into a version line, final on merge into the default branch (plus a sync PR from the default branch into the next open release), cuts and deploys on dispatch |
| `workflows/pr-checks.yml` | `.github/workflows/pr-checks.yml` | `checks` (install, lint, typecheck) and `conventions` (branch name, PR title, target) |
| `rulesets/*.json` | GitHub settings | Default branch, version lines and `v*` tags |
| `RELEASING.md` | `RELEASING.md` | The rules, for the people working on the repository |

## Tags

| Line | Candidates (one patch per rc, across release and hotfix) | Final (the last rc without `-rc`) |
|:--|:--|:--|
| `release/vX.Y` | `vX.Y.0-rc`, `vX.Y.1-rc`, … | `vX.Y.Z` |
| `hotfix/vX.Y` | `vX.Y.Z-hf-rc` (the patch after the shipped final), … | `vX.Y.Z-hf` |

A `-hf` final counts as a final everywhere (what prod runs, `cut-hotfix`, rollback, latest
release). Older `vX.Y.Z-rc.N` candidates and hotfix tags from before `-hf` are read, never
created; other `v*` tags (a manual `v1.0`) are ignored.

## Guards

What the automation refuses or does on its own, beyond tagging (details in `RELEASING.md`):

- **Deploy with the tag empty** takes the last rc of the line the run starts from, or the tag it
  starts from. From the default branch it takes the only open line, and refuses when more than
  one is open (e.g. a hotfix and a release).
- **Prod** takes an rc only if it contains the default branch, so a hotfix already in prod is
  never lost; merge the sync PR first.
- **`cut-release`** from an open release refuses while that release's head has no rc yet, and an
  rc is skipped only for a commit that carries a final or an older line's rc.
- **A version line** merges only into the default branch or a newer line.
- **Shipping a line** (`final`) opens `chore(sync): merge <default> into <next release>` when that
  release lacks it, and comments on the PRs still open from the shipped branch before deleting it.
- **A git command that fails** reports git's own message, and the tag fetch replaces stale local
  tags (the remote is the truth).

## Install into a repository

```bash
bash install.sh ../some-repo
```

It copies the files and prints the `gh api` commands that apply the rulesets. It never applies
them itself: review, then run them.

## Test

```bash
bash test/fixtures.sh "" "$(mktemp -d)"
bash test/fixtures.sh <source-repo> <empty-scratch-dir>
```

`<source-repo>` is optional: empty (`""`), the script builds its own source, a single commit on
`main`. Pass a repository (`.` for the kit itself) to run against its default branch instead,
e.g. one that is not called `main`.

Builds a throwaway copy of the source with fixture tags and runs the whole cycle in `--dry-run`,
with `test/cubeship-mock.mjs` standing in for Cubeship and `test/github-mock.mjs` for the GitHub
API (section 14b: a real `final` opens the sync PR and comments). Every step asserts its outcome: `expect
ok|fail` checks the exit code, `expect_out ok|fail "<text>"` also requires the text in the output,
and `check` asserts a file or git state. A step that misses prints `✗ MISS` and makes the script
exit 1; a clean run ends with `✓ all expectations met`. Among others it covers: one rc per new
commit, no rc for a cut at an already-tagged commit (section 2b and the hotfix in section 5), the
deploy gate, legacy `-rc.N` tags, test/prod deploys and a deploy whose container crashloops or
exits although Cubeship calls it "succeeded" (section 8b), and hotfix `-hf-rc` → `-hf` tags
(section 5). Sections 11 and up each start from their own copy of the source and reproduce one
bug; section 15 mixes legacy and manual tags with a hotfix that switches to `-hf` mid-way.

It never pushes outside its scratch copy: it stops (exit 1) on a scratch dir that is not empty
or a failed clone, checks that each clone's only remote is its scratch bare repo, and installs a
`pre-push` hook there that refuses any other URL. Section 0 proves it.

`.github/workflows/test.yml` runs it on every pull request and push to `master`.
