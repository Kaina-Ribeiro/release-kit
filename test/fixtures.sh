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
# Like r, but checks the exit code: expect ok|fail <args>. Any miss makes the script exit 1.
misses=0
expect() {
  local want=$1; shift
  echo; echo "\$ release.mjs $*   [expect $want]"; node "$kit/release.mjs" "$@"; local code=$?
  echo "(exit $code)"
  if { [ "$want" = ok ] && [ $code -ne 0 ]; } || { [ "$want" = fail ] && [ $code -eq 0 ]; }; then
    echo "  ✗ MISS: expected $want"; misses=$((misses + 1))
  fi
}
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
GITHUB_OUTPUT="$scratch/out-rc" r rc --branch release/v0.2 --dry-run
echo "  [output] $(cat "$scratch/out-rc")"
r cut-release --dry-run
branch release/v0.3 origin/release/v0.2

echo; echo "=== 2b. a cut at an already-tagged commit gets no rc, and its test deploy is a no-op"
GITHUB_OUTPUT="$scratch/out-cut" r rc --branch release/v0.3 --dry-run
echo "  [output] $(cat "$scratch/out-cut")"
DEPLOY_TEST_APPS=demo/test/api r deploy --stage test --branch release/v0.3
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

echo; echo "=== 3b. merged feature branches are deleted; version lines are kept"
branch feat/ABC-3-login origin/release/v0.2
r cleanup --head feat/ABC-3-login --base release/v0.2 --dry-run
r cleanup --head feat/ABC-3-login --base release/v0.2
r cleanup --head feat/ABC-3-login --base release/v0.2
r cleanup --head release/v0.2 --base release/v0.3
r cleanup --head feat/ABC-3-login --base "$def"

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
r rc --branch hotfix/v0.2 --dry-run
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
r deploy-check v0.3.0-rc.1 --prod

echo; echo "=== 8. deploys to a test stage (against test/cubeship-mock.mjs)"
port=47123
node "$kit/test/cubeship-mock.mjs" "$port" "$scratch/work" &
mock=$!
trap 'kill $mock 2>/dev/null' EXIT
sleep 1
export CUBESHIP_URL="http://127.0.0.1:$port" CUBESHIP_TOKEN=test-key RELEASE_DEPLOY_POLL_MS=50
export RELEASE_HEALTH_POLL_MS=50 RELEASE_HEALTH_STABLE_S=1 RELEASE_HEALTH_WAIT_S=2
export DEPLOY_TEST_APPS="demo/test/api demo/test/web" DEPLOY_PROD_APPS="demo/prod/api,demo/prod/web"
tag v0.3.1-rc origin/release/v0.3
r deploy --stage test --dry-run
r deploy --stage test --branch release/v0.3
r deploy --stage test --branch release/v0.3
r deploy --stage prod v0.3.0-rc.1
r deploy-check v0.3.1-rc --prod

echo; echo "=== 8b. a deploy whose container does not stay up fails, though Cubeship says \"succeeded\""
expect ok   deploy --stage test v0.3.1-rc --apps demo/test/api
expect fail deploy --stage test v0.3.1-rc --apps demo/test/crash
echo "  (a re-run sees \"already runs\" and must still check the container)"
expect fail deploy --stage test v0.3.1-rc --apps demo/test/crash
expect fail deploy --stage test v0.3.1-rc --apps demo/test/dead
echo "  (RELEASE_HEALTH_STABLE_S=0 turns the check off)"
RELEASE_HEALTH_STABLE_S=0 expect ok deploy --stage test v0.3.1-rc --apps demo/test/dead

echo; echo "=== 9. release day: prod gets the last rc first, the merge only tags it"
git checkout --quiet -B release/v0.3 origin/release/v0.3
git merge --quiet --no-ff -X ours "origin/$def" -m "Merge $def into release/v0.3"
git push --quiet origin release/v0.3; echo "  [fixture] merged $def into release/v0.3"
tag v0.3.2-rc origin/release/v0.3
r deploy --stage test --branch release/v0.3
merge_into_default release/v0.3
r final --head release/v0.3 --dry-run
r deploy --stage prod
r final --head release/v0.3 --dry-run
kill $mock 2>/dev/null
unset CUBESHIP_URL CUBESHIP_TOKEN DEPLOY_TEST_APPS DEPLOY_PROD_APPS RELEASE_DEPLOY_POLL_MS
unset RELEASE_HEALTH_POLL_MS RELEASE_HEALTH_STABLE_S RELEASE_HEALTH_WAIT_S

echo; echo "=== 10. final state"
r status

echo
if [ $misses -ne 0 ]; then echo "✗ $misses expectation(s) missed"; exit 1; fi
echo "✓ all expectations met"
