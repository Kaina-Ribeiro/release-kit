#!/usr/bin/env bash
# Exercises release.mjs --dry-run through a full release cycle on a throwaway copy of a repo.
# Usage: test/fixtures.sh <source-repo> <empty-scratch-dir>
# Creates <scratch>/remote.git (bare copy) and <scratch>/work (clone). Tags and branches that the
# automation "would" create are simulated by hand inside that copy; the source repo is untouched.
# Candidates are vX.Y.Z-rc, one patch per rc (v0.2.0-rc, v0.2.1-rc, …); the final is the last rc.
set -uo pipefail

kit=$(cd "$(dirname "$0")/.." && pwd)
src=${1:?source repo}
scratch=${2:?scratch dir}
unset GITHUB_ACTIONS GITHUB_REF_NAME GITHUB_SHA GITHUB_STEP_SUMMARY DEFAULT_BRANCH
export GH_TOKEN= GITHUB_TOKEN= GITHUB_REPOSITORY=example/fixture

git clone --quiet --bare "$src" "$scratch/remote.git"
git clone --quiet "$scratch/remote.git" "$scratch/work"
cd "$scratch/work"
git config user.name tester
git config user.email tester@example.com
git config core.autocrlf false
def=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')

r() { echo; echo "\$ release.mjs $*"; node "$kit/release.mjs" "$@"; echo "(exit $?)"; }
# What the automation would do, done by hand in the fixture.
tag() { git -c user.name='github-actions[bot]' tag -a "$1" "$2" -m "$1"; git push --quiet origin "refs/tags/$1"; echo "  [fixture] tagged $1"; }
branch() { git push --quiet origin "$(git rev-parse "$2^{commit}"):refs/heads/$1"; echo "  [fixture] created $1"; }
commit_on() { # branch message
  git checkout --quiet -B "$1" "origin/$1"
  echo "$2" >> fixture.txt; git add fixture.txt; git commit --quiet -m "$2"
  git push --quiet origin "$1"; echo "  [fixture] $1 += \"$2\""
}
merge_into_default() { # line
  git checkout --quiet -B "$def" "origin/$def"
  git merge --quiet --no-ff "origin/$1" -m "Merge $1 into $def"
  git push --quiet origin "$def"; echo "  [fixture] merged $1 into $def ($(git rev-parse --short HEAD))"
}

echo "=== 1. starting state"
r status
r cut-release --dry-run
branch release/v0.2 "origin/$def"

echo; echo "=== 2. features land on release/v0.2"
commit_on release/v0.2 "feat(ABC-1): first feature"
r rc --branch release/v0.2 --dry-run
tag v0.2.0-rc origin/release/v0.2
r rc --branch release/v0.2 --dry-run
r cut-release --dry-run
branch release/v0.3 origin/release/v0.2
commit_on release/v0.2 "fix(ABC-2): late fix"
r rc --branch release/v0.2 --dry-run
tag v0.2.1-rc origin/release/v0.2
r sync --branch release/v0.2 --dry-run
r sync --branch release/v0.3 --dry-run
r cut-release --version 0.2 --dry-run

echo; echo "=== 3. PR conventions"
r conventions --head feat/ABC-3-login --base release/v0.2 --title "feat(ABC-3): add login"
r conventions --head feature/login --base release/v0.2 --title "Add login"
r conventions --head feat/ABC-3-login --base "$def" --title "feat(ABC-3): add login"
r conventions --head feat/ABC-3-login --base release/v0.2 --title "feat(ABC-4): Add login"
r conventions --head revert-12-feat/ABC-3-login --base release/v0.2 --title 'Revert "feat(ABC-3): add login"'
r conventions --head release/v0.2 --base release/v0.3 --title "chore(sync): merge release/v0.2 into release/v0.3"
r conventions --head release/v0.2 --base "$def" --title "chore(release): ship release/v0.2"

echo; echo "=== 4. release day, with an untested commit first"
commit_on release/v0.2 "fix(ABC-5): untested"
merge_into_default release/v0.2
r final --head release/v0.2 --dry-run
tag v0.2.2-rc origin/release/v0.2
r final --head release/v0.2 --dry-run
tag v0.2.2 "origin/$def"
r rc --branch release/v0.2 --dry-run

echo; echo "=== 5. hotfix on v0.2"
r cut-release --dry-run
r cut-hotfix --dry-run
branch hotfix/v0.2 v0.2.2
commit_on hotfix/v0.2 "fix(ABC-6): prod bug"
r rc --branch hotfix/v0.2 --dry-run
tag v0.2.3-rc origin/hotfix/v0.2
r sync --branch hotfix/v0.2 --dry-run
merge_into_default hotfix/v0.2
r final --head hotfix/v0.2 --dry-run
tag v0.2.3 "origin/$def"
r cut-hotfix --dry-run
r conventions --head release/v0.3 --base "$def" --title "chore(release): ship release/v0.3"

echo; echo "=== 6. deploy gate"
r deploy-check v0.2.3-rc
r deploy-check v0.2.3-rc --prod
r deploy-check v0.2.3 --prod
r deploy-check release/v0.3

echo; echo "=== 7. legacy rc tags (vX.Y.Z-rc.N) are still read; new ones take the next patch"
tag v0.3.0-rc.1 origin/release/v0.3
r rc --branch release/v0.3 --dry-run
commit_on release/v0.3 "feat(ABC-7): after the tag format change"
r rc --branch release/v0.3 --dry-run
r deploy-check v0.3.0-rc.1

echo; echo "=== 8. final state"
r status
