# release-kit

Branch, PR, tag and release automation for GitHub repositories, with no repository-specific
values. `RELEASING.md` holds the rules it enforces; it is copied into each repository.

## What it contains

| File | Installed as | Does |
|:--|:--|:--|
| `release.mjs` | `.github/scripts/release.mjs` | `rc`, `final`, `sync`, `cleanup`, `cut-release`, `cut-hotfix`, `deploy`, `deploy-check`; `--dry-run` |
| `workflows/release.yml` | `.github/workflows/release.yml` | rc + sync + test-stage deploy on push to a version line (none for a commit already tagged, e.g. a cut), branch cleanup on merge into a version line, final on merge into the default branch, cuts and deploys on dispatch |
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

Builds a throwaway copy of `<source-repo>` with fixture tags and runs the whole cycle in
`--dry-run`, with `test/cubeship-mock.mjs` standing in for Cubeship. It prints each command with
its output and exit code; read the log. Among others it covers: one rc per new commit, no rc for a
cut at an already-tagged commit (section 2b and the hotfix in section 5), the deploy gate, legacy
`-rc.N` tags and test/prod deploys.
