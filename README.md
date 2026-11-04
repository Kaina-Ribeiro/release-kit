# release-kit

Branch, PR, tag and release automation for GitHub repositories, with no repository-specific
values. `RELEASING.md` holds the rules it enforces; it is copied into each repository.

## What it contains

| File | Installed as | Does |
|:--|:--|:--|
| `release.mjs` | `.github/scripts/release.mjs` | `rc`, `final`, `sync`, `cleanup`, `cut-release`, `cut-hotfix`, `deploy`, `deploy-check`; `--dry-run` |
| `workflows/release.yml` | `.github/workflows/release.yml` | rc + sync + test-stage deploy on push to a version line, branch cleanup on merge into a version line, final on merge into the default branch, cuts and deploys on dispatch |
| `workflows/pr-checks.yml` | `.github/workflows/pr-checks.yml` | `checks` (install, lint, typecheck) and `conventions` (branch name, PR title, target) |
| `rulesets/*.json` | GitHub settings | Default branch, version lines and `v*` tags |
| `RELEASING.md` | `RELEASING.md` | The rules, for the people working on the repository |

## Install into a repository

```bash
bash install.sh ../some-repo
```

It copies the files and prints the `gh api` commands that apply the rulesets. It never applies
them itself: review, then run them.

## Test

```bash
bash test/fixtures.sh <source-repo> <empty-scratch-dir>
```

Runs a full cycle in a throwaway copy, with `test/cubeship-mock.mjs` standing in for Cubeship.

Builds a throwaway repository with fixture tags and runs the whole cycle in `--dry-run`.
