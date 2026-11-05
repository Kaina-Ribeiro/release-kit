#!/usr/bin/env bash
# Exercises release.mjs --dry-run through a full release cycle on a throwaway copy of a repo.
# Usage: test/fixtures.sh [<source-repo>] <empty-scratch-dir>
#   An empty <source-repo> ("") builds one in <scratch>/source: a single commit on main.
# Creates <scratch>/remote.git (bare copy) and <scratch>/work (clone). Tags and branches that the
# automation "would" create are simulated by hand inside that copy; the source repo is untouched.
# Each later section starts from its own copy (fresh <name>: <scratch>/<name>/{remote.git,work}).
# Candidates are vX.Y.Z-rc on a release line and vX.Y.Z-hf-rc on a hotfix line, one patch per rc
# (v0.2.0-rc, v0.2.1-rc, …, v0.2.3-hf-rc); the final is the last rc without -rc (v0.2.3-hf).
# Every step asserts its outcome (expect, expect_out, check); any miss makes the script exit 1.
set -uo pipefail

kit=$(cd "$(dirname "$0")/.." && pwd)
src=${1-}
scratch=${2:?scratch dir}
unset GITHUB_ACTIONS GITHUB_REF_NAME GITHUB_REF_TYPE GITHUB_SHA GITHUB_OUTPUT GITHUB_STEP_SUMMARY DEFAULT_BRANCH
export GH_TOKEN= GITHUB_TOKEN= GITHUB_REPOSITORY=example/fixture

# Guard: everything below pushes to "origin", so it must only ever run inside a scratch clone whose
# origin is a scratch bare repo. Without -e, a failed clone or cd would leave the script in the
# caller's directory, and its fixture branches and tags would go to that checkout's real remote.
die() { echo "fixtures: $*" >&2; exit 1; }
mkdir -p "$scratch" || die "cannot create $scratch"
[ -z "$(ls -A "$scratch")" ] || die "$scratch is not empty"
if [ -z "$src" ]; then
  src="$scratch/source"
  git init --quiet -b main "$src" || die "cannot create $src"
  git -C "$src" config core.autocrlf false
  echo "fixture source" > "$src/README"
  git -C "$src" add README && git -C "$src" -c user.name=tester -c user.email=tester@example.com \
    commit --quiet -m "chore: initial commit" || die "cannot commit in $src"
fi
src=$(cd "$src" && pwd) || die "cannot enter $src" # absolute: each section clones it from its own dir

# A bare copy of $src in <dir>/remote.git and a clone of it in <dir>/work; cd there.
clone_into() { # dir
  local bare="$1/remote.git"
  { [ ! -e "$bare" ] && [ ! -e "$1/work" ]; } || die "$1 already holds a fixture copy"
  git clone --quiet --bare "$src" "$bare" || die "cannot clone $src (it must be a git repository)"
  # Only the source's history: its own tags (the kit's v1.0.0, v1) would read as releases in prod.
  git -C "$bare" tag -l | xargs -r git -C "$bare" tag -d >/dev/null || die "cannot drop the tags of $1/remote.git"
  # git's own spelling of the path (C:/… on Windows): the URL it records for origin.
  bare=$(git -C "$bare" rev-parse --absolute-git-dir) || die "cannot read $1/remote.git"
  git clone --quiet "$bare" "$1/work" || die "cannot clone $bare"
  cd "$1/work" || die "cannot enter $1/work"
  { [ "$(git remote)" = origin ] && [ "$(git remote get-url --push origin)" = "$bare" ]; } \
    || die "the scratch clone's only remote must be origin = $bare"
  # Second lock: a pre-push hook refuses any push that is not to the scratch bare repo (its own
  # hooksPath, so a global core.hooksPath cannot bypass it).
  local hooks; hooks="$(git rev-parse --absolute-git-dir)/hooks"
  mkdir -p "$hooks" && git config core.hooksPath "$hooks" || die "cannot install the pre-push hook"
  printf '#!/bin/sh\n[ "$2" = %s ] || { echo "fixtures: refusing push to $2" >&2; exit 1; }\n' \
    "'$bare'" > "$hooks/pre-push" && chmod +x "$hooks/pre-push" || die "cannot install the pre-push hook"
  git config user.name tester
  git config user.email tester@example.com
  git config core.autocrlf false
  def=$(git symbolic-ref --short refs/remotes/origin/HEAD | sed 's#^origin/##')
}
# A new section's own copy of $src, so it never depends on the state the other sections left.
fresh() { # name
  [ ! -e "$scratch/$1" ] || die "$scratch/$1 already exists"
  mkdir "$scratch/$1" || die "cannot create $scratch/$1"
  clone_into "$scratch/$1"; echo "  [fixture] fresh copy $1 (default branch $def)"
}

misses=0
miss() { echo "  ✗ MISS: $*"; misses=$((misses + 1)); }
# expect ok|fail <args>: runs release.mjs and checks its exit code.
expect() {
  local want=$1; shift
  echo; echo "\$ release.mjs $*   [expect $want]"; node "$kit/release.mjs" "$@"; local code=$?
  echo "(exit $code)"
  if { [ "$want" = ok ] && [ $code -ne 0 ]; } || { [ "$want" = fail ] && [ $code -eq 0 ]; }; then
    miss "expected $want"
  fi
}
# expect_out ok|fail "<text>" <args>: like expect, and stdout+stderr must also contain <text>.
expect_out() {
  local want=$1 text=$2; shift 2
  echo; echo "\$ release.mjs $*   [expect $want: \"$text\"]"
  local out; out=$(node "$kit/release.mjs" "$@" 2>&1); local code=$?
  printf '%s\n' "$out"; echo "(exit $code)"
  if { [ "$want" = ok ] && [ $code -ne 0 ]; } || { [ "$want" = fail ] && [ $code -eq 0 ]; }; then
    miss "expected $want"
  fi
  if ! printf '%s\n' "$out" | grep -qF -- "$text"; then miss "expected the output to contain \"$text\""; fi
}
# check "<description>" <command…>: the command must exit 0 (output files, git state).
check() {
  local what=$1; shift
  if "$@"; then echo "  [check] $what"; else miss "check failed: $what"; fi
}
not() { ! "$@"; }

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

clone_into "$scratch"

# Runs of this script from inside this script set FIXTURES_NESTED, and never run section 0 again.
if [ -z "${FIXTURES_NESTED-}" ]; then
  echo "=== 0. the fixtures never push outside their scratch copy"
  # A checkout whose origin stands in for a real remote (e.g. the kit's own repository on GitHub).
  git clone --quiet --bare "$src" "$scratch/canary.git"; git clone --quiet "$scratch/canary.git" "$scratch/canary"
  canary_refs() { git -C "$scratch/canary.git" for-each-ref --format='%(refname)'; }
  refs_before=$(canary_refs)
  mkdir -p "$scratch/guard-dirty/kept" "$scratch/not-a-repo"
  echo; echo "\$ fixtures.sh \"\" <a dir that is not empty>, run from the checkout   [expect exit 1: \"is not empty\"]"
  out=$(cd "$scratch/canary" && FIXTURES_NESTED=1 bash "$kit/test/fixtures.sh" "" "$scratch/guard-dirty" 2>&1); code=$?
  printf '%s\n' "$out" | tail -n 2; echo "(exit $code)"
  check "a scratch dir that is not empty exits 1" [ "$code" -eq 1 ]
  check "it says why" grep -qF "is not empty" <<<"$out"
  check "it leaves that dir as it was" [ "$(ls -A "$scratch/guard-dirty")" = kept ]
  echo; echo "\$ fixtures.sh <not a git repository> <empty dir>, run from the checkout   [expect exit 1: \"cannot clone\"]"
  out=$(cd "$scratch/canary" && FIXTURES_NESTED=1 bash "$kit/test/fixtures.sh" "$scratch/not-a-repo" "$scratch/guard-bad-src" 2>&1); code=$?
  printf '%s\n' "$out" | tail -n 2; echo "(exit $code)"
  check "a source that is not a git repository exits 1" [ "$code" -eq 1 ]
  check "it says why" grep -qF "cannot clone" <<<"$out"
  check "the checkout's origin got no push" [ "$(canary_refs)" = "$refs_before" ]
  check "the scratch clone refuses a push to any other URL" \
    not git -C "$scratch/work" push --quiet "$scratch/canary.git" HEAD:refs/heads/hook-test
  echo
fi

echo "=== 1. starting state"
expect ok status
expect ok cut-release --dry-run
branch release/v0.2 "origin/$def"

echo; echo "=== 2. features land on release/v0.2"
commit_on release/v0.2 "feat(ABC-1): first feature"
expect_out ok "release/v0.2 → v0.2.0-rc (first rc)" rc --branch release/v0.2 --dry-run
tag v0.2.0-rc origin/release/v0.2
GITHUB_OUTPUT="$scratch/out-rc" expect_out ok "is already v0.2.0-rc; nothing to do" rc --branch release/v0.2 --dry-run
check "the rc step outputs tag=v0.2.0-rc" grep -qx 'tag=v0.2.0-rc' "$scratch/out-rc"
expect ok cut-release --dry-run
branch release/v0.3 origin/release/v0.2

echo; echo "=== 2b. a cut at an already-tagged commit gets no rc, and its test deploy is a no-op"
GITHUB_OUTPUT="$scratch/out-cut" expect_out ok "no new code on release/v0.3, no rc" rc --branch release/v0.3 --dry-run
check "the rc step outputs an empty tag=" grep -qx 'tag=' "$scratch/out-cut"
DEPLOY_TEST_APPS=demo/test/api expect ok deploy --stage test --branch release/v0.3
commit_on release/v0.2 "fix(ABC-2): late fix"
expect ok rc --branch release/v0.2 --dry-run
tag v0.2.1-rc origin/release/v0.2
expect ok sync --branch release/v0.2 --dry-run
expect ok sync --branch release/v0.3 --dry-run
expect_out fail "must be newer than release/v0.3" cut-release --version 0.2 --dry-run

echo; echo "=== 3. PR conventions"
expect ok conventions --head feat/ABC-3-login --base release/v0.2 --title "feat(ABC-3): add login"
expect fail conventions --head feature/login --base release/v0.2 --title "Add login"
expect fail conventions --head feat/ABC-3-login --base "$def" --title "feat(ABC-3): add login"
expect fail conventions --head feat/ABC-3-login --base release/v0.2 --title "feat(ABC-4): Add login"
expect ok conventions --head revert-12-feat/ABC-3-login --base release/v0.2 --title 'Revert "feat(ABC-3): add login"'
expect ok conventions --head release/v0.2 --base release/v0.3 --title "chore(sync): merge release/v0.2 into release/v0.3"
expect ok conventions --head release/v0.2 --base "$def" --title "chore(release): ship release/v0.2"
expect_out fail "release/v0.3 can merge only into $def or a newer line; release/v0.2 is older." conventions --head release/v0.3 --base release/v0.2 --title "chore(sync): merge release/v0.3 into release/v0.2"
expect ok conventions --head "$def" --base release/v0.2 --title "chore(sync): merge $def into release/v0.2"
expect_out fail "is not Conventional Commits" conventions --head "$def" --base release/v0.2 --title "merge"

echo; echo "=== 3b. merged feature branches are deleted; version lines are kept"
branch feat/ABC-3-login origin/release/v0.2
expect_out ok "would delete branch feat/ABC-3-login" cleanup --head feat/ABC-3-login --base release/v0.2 --dry-run
expect_out ok "→ delete branch feat/ABC-3-login" cleanup --head feat/ABC-3-login --base release/v0.2
expect_out ok "✓ feat/ABC-3-login is already gone" cleanup --head feat/ABC-3-login --base release/v0.2
expect_out ok "✓ release/v0.2 is a version line or the default branch; kept" cleanup --head release/v0.2 --base release/v0.3
expect_out ok "✓ $def is not a version line; nothing to clean" cleanup --head feat/ABC-3-login --base "$def"

echo; echo "=== 4. release day, with an untested commit first"
commit_on release/v0.2 "fix(ABC-5): untested"
merge_into_default release/v0.2
expect_out fail "differs from v0.2.1-rc" final --head release/v0.2 --dry-run
tag v0.2.2-rc origin/release/v0.2
expect_out ok "→ v0.2.2 (same code as v0.2.2-rc)" final --head release/v0.2 --dry-run
echo "  (release/v0.3 lacks $def's merge, so shipping opens the sync PR before the branch goes)"
expect_out ok "would open PR \"chore(sync): merge $def into release/v0.3\"" final --head release/v0.2 --dry-run
echo "  (GitHub down while shipping: the sync PR and the comments only warn, since the tag is out)"
GH_TOKEN=x GITHUB_API_URL=http://127.0.0.1:9 expect_out ok "warning: could not open the sync PR" final --head release/v0.2 --dry-run
tag v0.2.2 "origin/$def"
echo "  (a re-run once the tag exists does not fail and still suggests the sync)"
expect_out ok "already on" final --head release/v0.2 --dry-run
expect_out ok "(no GitHub token: skipping the check for the v0.2.2 release)" final --head release/v0.2 --dry-run
expect_out ok "would open PR \"chore(sync): merge $def into release/v0.3\"" final --head release/v0.2 --dry-run
echo "  (but a re-run that cannot check the tag's GitHub release fails: a missing release must show)"
GH_TOKEN=x GITHUB_API_URL=http://127.0.0.1:9 expect_out fail "GitHub API GET /releases/tags/v0.2.2" final --head release/v0.2 --dry-run
expect_out fail "already shipped as v0.2.2" rc --branch release/v0.2 --dry-run

echo; echo "=== 5. hotfix on v0.2"
expect ok cut-release --dry-run
expect_out ok "in prod: v0.2.2; the hotfix's next rc will be v0.2.3-hf-rc" cut-hotfix --dry-run
branch hotfix/v0.2 v0.2.2
expect_out fail "is older" conventions --head release/v0.3 --base hotfix/v0.2 --title "chore(sync): merge release/v0.3 into hotfix/v0.2"
expect ok conventions --head hotfix/v0.2 --base release/v0.3 --title "chore(sync): merge hotfix/v0.2 into release/v0.3"
expect_out ok "no new code on hotfix/v0.2, no rc" rc --branch hotfix/v0.2 --dry-run
commit_on hotfix/v0.2 "fix(ABC-6): prod bug"
expect_out ok "hotfix/v0.2 → v0.2.3-hf-rc (first rc)" rc --branch hotfix/v0.2 --dry-run
tag v0.2.3-hf-rc origin/hotfix/v0.2
expect ok sync --branch hotfix/v0.2 --dry-run
merge_into_default hotfix/v0.2
expect_out ok "→ v0.2.3-hf (same code as v0.2.3-hf-rc)" final --head hotfix/v0.2 --dry-run
expect_out ok "would open PR \"chore(sync): merge $def into release/v0.3\"" final --head hotfix/v0.2 --dry-run
expect_out ok "Closed because hotfix/v0.2 shipped as v0.2.3-hf; its changes reach release/v0.3 through the sync PR." final --head hotfix/v0.2 --dry-run
tag v0.2.3-hf "origin/$def"
echo "  (v0.2.3-hf is a final: prod runs it, the next hotfix starts from it, a re-run sees it shipped)"
expect_out ok "in prod: v0.2.3-hf; the hotfix's next rc will be v0.2.4-hf-rc" cut-hotfix --dry-run
expect_out ok "✓ v0.2.3-hf already on" final --head hotfix/v0.2 --dry-run
expect_out fail "is behind $def" conventions --head release/v0.3 --base "$def" --title "chore(release): ship release/v0.3"

echo; echo "=== 6. deploy gate"
expect_out ok "✓ v0.2.3-hf-rc can go to a test stage" deploy-check v0.2.3-hf-rc
expect_out fail "is not the last rc" deploy-check v0.2.3-hf-rc --prod
expect_out ok "✓ v0.2.3-hf can go to prod (same code as v0.2.3-hf-rc)" deploy-check v0.2.3-hf --prod
expect_out fail "\"release/v0.3\" is not a release tag (vX.Y.Z, vX.Y.Z-rc, vX.Y.Z-hf or vX.Y.Z-hf-rc); branches and other refs never deploy" deploy-check release/v0.3

echo; echo "=== 7. legacy rc tags (vX.Y.Z-rc.N) are still read; new ones take the next patch"
tag v0.3.0-rc.1 origin/release/v0.3
expect_out ok "is already v0.3.0-rc.1; nothing to do" rc --branch release/v0.3 --dry-run
commit_on release/v0.3 "feat(ABC-7): after the tag format change"
expect_out ok "release/v0.3 → v0.3.1-rc (last rc v0.3.0-rc.1)" rc --branch release/v0.3 --dry-run
expect_out ok "✓ v0.3.0-rc.1 can go to a test stage" deploy-check v0.3.0-rc.1
echo "  (release/v0.3 lacks the hotfix v0.2.3 until section 9 merges $def into it)"
expect_out fail "lacks what $def has" deploy-check v0.3.0-rc.1 --prod

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
echo "  (hotfix/v0.2 still exists, so a deploy with no tag and no line to start from has two to pick)"
expect_out fail "2 lines are open" deploy --stage test --dry-run
expect ok deploy --stage test --branch release/v0.3
expect ok deploy --stage test --branch release/v0.3
expect_out fail "(that is v0.3.1-rc)" deploy --stage prod v0.3.0-rc.1
expect_out fail "lacks what $def has" deploy-check v0.3.1-rc --prod

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
expect ok deploy --stage test --branch release/v0.3
merge_into_default release/v0.3
expect_out fail "prod does not run v0.3.2-rc" final --head release/v0.3 --dry-run
expect ok deploy --stage prod --branch release/v0.3
expect_out ok "✓ prod runs v0.3.2-rc" final --head release/v0.3 --dry-run
kill $mock 2>/dev/null
unset CUBESHIP_URL CUBESHIP_TOKEN DEPLOY_TEST_APPS DEPLOY_PROD_APPS RELEASE_DEPLOY_POLL_MS
unset RELEASE_HEALTH_POLL_MS RELEASE_HEALTH_STABLE_S RELEASE_HEALTH_WAIT_S

echo; echo "=== 10. final state"
expect_out ok "in prod:        v0.2.3-hf" status

echo; echo "=== 11. B3: a stale local tag does not break the fetch; git errors read as git's"
fresh b3
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
c=$(git rev-parse 'v0.1.0-rc^{commit}'); git tag -d v0.1.0-rc >/dev/null; git tag v0.1.0-rc "$c"
expect ok status
git remote set-url origin "$scratch/nowhere.git"
expect_out fail "git fetch origin --tags --prune --force failed: fatal:" status

echo; echo "=== 12. B2: prod refuses an rc that lacks what the default branch has"
fresh b2
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"
branch release/v0.2 "origin/$def"; commit_on release/v0.2 "feat(ABC-2): two"; tag v0.2.0-rc origin/release/v0.2
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-3): prod bug"; tag v0.1.1-hf-rc origin/hotfix/v0.1
expect ok deploy-check v0.1.1-hf-rc --prod
merge_into_default hotfix/v0.1; tag v0.1.1-hf "origin/$def"
expect_out fail "v0.2.0-rc lacks what $def has" deploy-check v0.2.0-rc --prod
expect_out fail "prod v0.1.1-hf): prod would lose it. Merge the open sync PR (or $def) into release/v0.2" deploy-check v0.2.0-rc --prod
expect ok deploy-check v0.2.0-rc
git checkout --quiet -B release/v0.2 origin/release/v0.2
git merge --quiet --no-ff -X ours "origin/$def" -m "Merge $def into release/v0.2"; git push --quiet origin release/v0.2
tag v0.2.1-rc origin/release/v0.2
expect ok deploy-check v0.2.1-rc --prod
expect_out ok "✓ v0.1.1-hf can go to prod (same code as v0.1.1-hf-rc)" deploy-check v0.1.1-hf --prod

echo; echo "=== 13. B1: a deploy without a tag takes the line or tag the run starts from"
fresh b1
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"; git push --quiet origin --delete release/v0.1
branch release/v0.2 "origin/$def"; commit_on release/v0.2 "feat(ABC-2): two"; tag v0.2.0-rc origin/release/v0.2
export DEPLOY_PROD_APPS=demo/prod/api DEPLOY_TEST_APPS=demo/test/api
expect_out ok "deploying v0.2.0-rc to prod" deploy --stage prod --dry-run
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-3): prod bug"; tag v0.1.1-hf-rc origin/hotfix/v0.1
GITHUB_REF_TYPE=branch GITHUB_REF_NAME=hotfix/v0.1 expect_out ok "deploying v0.1.1-hf-rc to prod" deploy --stage prod --dry-run
GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v0.2.0-rc expect_out ok "deploying v0.2.0-rc to test" deploy --stage test --dry-run
GITHUB_REF_TYPE=branch GITHUB_REF_NAME="$def" expect_out fail "2 lines are open (hotfix/v0.1: v0.1.1-hf-rc, release/v0.2: v0.2.0-rc)" deploy --stage prod --dry-run
unset DEPLOY_PROD_APPS DEPLOY_TEST_APPS

echo; echo "=== 14. B4: cutting a release does not take the rc of the line it is cut from"
fresh b4
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"
expect_out fail "release/v0.1's head" cut-release --dry-run
tag v0.1.0-rc origin/release/v0.1
expect ok cut-release --dry-run
commit_on release/v0.1 "fix(ABC-2): late"
branch release/v0.2 origin/release/v0.1
tag v0.2.0-rc origin/release/v0.2
expect_out ok "release/v0.1 → v0.1.1-rc" rc --branch release/v0.1 --dry-run

echo; echo "=== 14b. B6 for real (against test/github-mock.mjs): the sync PR, the comments, a refused PR"
fresh b6
mkdir "$scratch/ghmock"
node "$kit/test/github-mock.mjs" 47125 "$scratch/ghmock" &
ghmock=$!
trap 'kill $mock $ghmock 2>/dev/null' EXIT
sleep 1
export GITHUB_API_URL=http://127.0.0.1:47125 GH_TOKEN=test-token
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc origin/release/v0.1
merge_into_default release/v0.1; tag v0.1.0 "origin/$def"; git push --quiet origin --delete release/v0.1
branch release/v0.2 "origin/$def"; commit_on release/v0.2 "feat(ABC-2): two"; tag v0.2.0-rc origin/release/v0.2
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-3): prod bug"; tag v0.1.1-hf-rc origin/hotfix/v0.1
echo "  (the hotfix's own sync PR, which GitHub closes once shipping deletes hotfix/v0.1)"
expect_out ok "✓ opened #1" sync --branch hotfix/v0.1
merge_into_default hotfix/v0.1
echo "$def" > "$scratch/ghmock/refuse-pulls-from"
echo "  (GitHub refuses the sync PR from $def: the final still ships, warns, and its comment says no PR exists)"
expect_out ok "warning: could not open the sync PR from $def into release/v0.2" final --head hotfix/v0.1
check "the final tag is out" git ls-remote --quiet --exit-code --tags origin refs/tags/v0.1.1-hf
check "it has a GitHub release, not a prerelease (so it is marked latest)" grep -qx "release v0.1.1-hf" "$scratch/ghmock/log"
check "the shipped branch is gone" not git ls-remote --quiet --exit-code --heads origin hotfix/v0.1
check "the comment on #1 says the sync into release/v0.2 is still to do" grep -qF \
  "comment #1: Closed because hotfix/v0.1 shipped as v0.1.1-hf; its changes are in $def but no sync PR into release/v0.2 could be opened: open one (merge $def into release/v0.2)." "$scratch/ghmock/log"
rm "$scratch/ghmock/refuse-pulls-from"
echo "  (a re-run once GitHub allows it opens the sync PR and points #1 at it)"
expect_out ok "✓ opened #2" final --head hotfix/v0.1
check "the comment on #1 points at #2" grep -qF \
  "comment #1: Closed because hotfix/v0.1 shipped as v0.1.1-hf; its changes reach release/v0.2 through #2." "$scratch/ghmock/log"
kill $ghmock 2>/dev/null

echo; echo "=== 14c. a re-run creates the GitHub release that a failed run left missing"
fresh rel
mkdir "$scratch/ghmock-rel"
node "$kit/test/github-mock.mjs" 47126 "$scratch/ghmock-rel" &
ghmock=$!
sleep 1
export GITHUB_API_URL=http://127.0.0.1:47126 GH_TOKEN=test-token
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"
touch "$scratch/ghmock-rel/fail-next-release"
echo "  (the rc job pushes the tag, then GitHub fails to create its prerelease)"
expect_out fail "GitHub API POST /releases: 500" rc --branch release/v0.1
check "the rc tag is out" git ls-remote --quiet --exit-code --tags origin refs/tags/v0.1.0-rc
check "it has no prerelease" not grep -q "^release v0.1.0-rc" "$scratch/ghmock-rel/log"
expect_out ok "create GitHub prerelease v0.1.0-rc" rc --branch release/v0.1
check "the re-run created the prerelease" grep -qx "release v0.1.0-rc (prerelease)" "$scratch/ghmock-rel/log"
expect_out ok "release v0.1.0-rc already exists" rc --branch release/v0.1
merge_into_default release/v0.1
touch "$scratch/ghmock-rel/fail-next-release"
echo "  (the final job pushes the tag, then GitHub fails to create its release)"
expect_out fail "GitHub API POST /releases: 500" final --head release/v0.1
check "the final tag is out" git ls-remote --quiet --exit-code --tags origin refs/tags/v0.1.0
check "it has no release" not grep -qx "release v0.1.0" "$scratch/ghmock-rel/log"
expect_out ok "would create GitHub release v0.1.0" final --head release/v0.1 --dry-run
expect_out ok "→ create GitHub release v0.1.0" final --head release/v0.1
check "the re-run created the release" grep -qx "release v0.1.0" "$scratch/ghmock-rel/log"
check "and then deleted the shipped branch" not git ls-remote --quiet --exit-code --heads origin release/v0.1
expect_out ok "release v0.1.0 already exists" final --head release/v0.1
kill $ghmock 2>/dev/null
export GH_TOKEN=; unset GITHUB_API_URL

echo; echo "=== 15. legacy and manual tags; a hotfix that switches to -hf mid-way"
fresh legacy
branch release/v0.1 "origin/$def"; commit_on release/v0.1 "feat(ABC-1): one"; tag v0.1.0-rc.1 origin/release/v0.1
merge_into_default release/v0.1
echo "  (a legacy vX.Y.Z-rc.N ships as vX.Y.Z)"
expect_out ok "→ v0.1.0 (same code as v0.1.0-rc.1)" final --head release/v0.1 --dry-run
tag v0.1.0 "origin/$def"
echo "  (a hotfix rc from before -hf, and a manual tag that is not a release tag)"
branch hotfix/v0.1 v0.1.0; commit_on hotfix/v0.1 "fix(ABC-2): old style"; tag v0.1.1-rc origin/hotfix/v0.1
git tag v1.0 "origin/$def"; git push --quiet origin refs/tags/v1.0
expect_out ok "in prod:        v0.1.0" status
expect_out ok "tags:           v0.1.0-rc.1, v0.1.0, v0.1.1-rc" status
expect_out ok "hotfix/v0.1: open, last rc v0.1.1-rc, next rc v0.1.2-hf-rc" status
expect_out ok "release/v0.2 branches from $def" cut-release --dry-run
expect_out ok "✓ v0.1.0 can go to prod (same code as v0.1.0-rc.1)" deploy-check v0.1.0 --prod
commit_on hotfix/v0.1 "fix(ABC-3): new style"
expect_out ok "in prod: v0.1.0; the hotfix's next rc will be v0.1.2-hf-rc" cut-hotfix --dry-run
expect_out ok "hotfix/v0.1 → v0.1.2-hf-rc (last rc v0.1.1-rc)" rc --branch hotfix/v0.1 --dry-run
tag v0.1.2-hf-rc origin/hotfix/v0.1
merge_into_default hotfix/v0.1
echo "  (the final follows the last rc's name)"
expect_out ok "→ v0.1.2-hf (same code as v0.1.2-hf-rc)" final --head hotfix/v0.1 --dry-run
tag v0.1.2-hf "origin/$def"
expect_out ok "in prod:        v0.1.2-hf" status
expect_out ok "✓ v0.1.2-hf can go to prod (same code as v0.1.2-hf-rc)" deploy-check v0.1.2-hf --prod

echo; echo "=== 16. failures open one issue per job and line; a recovery closes it"
cd "$scratch/work" || die "cannot enter $scratch/work" # the main story, where release/v0.2 shipped
GITHUB_OUTPUT="$scratch/out-err" expect fail rc --branch release/v0.2 --dry-run --no-fetch
check "the error is a step output, on one line" grep -q '^error=release/v0.2 already shipped' "$scratch/out-err"
mkdir "$scratch/ghmock-iss"
node "$kit/test/github-mock.mjs" 47127 "$scratch/ghmock-iss" &
ghmock=$!
trap 'kill $mock $ghmock 2>/dev/null' EXIT
sleep 1
export GITHUB_API_URL=http://127.0.0.1:47127 GH_TOKEN=test-token
issues="$scratch/ghmock-iss/log"
expect_out ok 'would open issue "Release automation failing: final on release/v0.3"' \
  report --job final --line release/v0.3 --result failure --run-url https://x/runs/0 --error "boom" --dry-run
check "a dry run opens nothing" not grep -q '^issue' "$issues"
expect_out ok "opened issue #1" \
  report --job final --line release/v0.3 --result failure --run-url https://x/runs/1 --error "prod does not run v0.3.2-rc"
check "one issue, titled by job and line, labelled release-kit" \
  grep -qx "issue #1 \[release-kit\]: Release automation failing: final on release/v0.3" "$issues"
check "its body has the run" grep -qF "https://x/runs/1" "$issues"
check "its body has the error" grep -qF "prod does not run v0.3.2-rc" "$issues"
check "its body points to RELEASING.md" grep -qF "RELEASING.md#when-the-automation-refuses" "$issues"
expect_out ok 'would comment on issue #1' \
  report --job final --line release/v0.3 --result failure --run-url https://x/runs/2 --error "again" --dry-run
expect_out ok "commented on issue #1" \
  report --job final --line release/v0.3 --result failure --run-url https://x/runs/2 --error "again"
check "the same failure comments, it opens no second issue" not grep -q '^issue #2' "$issues"
check "the comment has the new run" grep -qF "https://x/runs/2" "$issues"
expect_out ok "no open issue for rc on release/v0.3" \
  report --job rc --line release/v0.3 --result success --run-url https://x/runs/3
expect_out ok "no open issue for final on release/v0.4" \
  report --job final --line release/v0.4 --result success --run-url https://x/runs/3
expect_out ok "nothing to report: final was skipped" \
  report --job final --line release/v0.3 --result skipped --run-url https://x/runs/3
echo "  (on a push, final and cleanup are skipped and have no line)"
expect_out ok "nothing to report: cleanup was skipped" \
  report --job cleanup --line "" --result skipped --run-url https://x/runs/3 --error ""
check "a success on another job or line closes nothing" not grep -q '^closed' "$issues"
expect_out ok 'would close issue #1' \
  report --job final --line release/v0.3 --result success --run-url https://x/runs/4 --dry-run
expect_out ok "closed issue #1" \
  report --job final --line release/v0.3 --result success --run-url https://x/runs/4
check "it says what fixed it" grep -qx "comment #1: Fixed by https://x/runs/4" "$issues"
check "it is closed" grep -qx "closed #1" "$issues"
expect_out ok "opened issue #2" \
  report --job final --line release/v0.3 --result failure --run-url https://x/runs/5 --error "once more"
kill $ghmock 2>/dev/null
export GH_TOKEN=; unset GITHUB_API_URL
echo "  (no token: a dry run cannot look for an open issue)"
expect_out ok 'would open issue "Release automation failing: rc on hotfix/v0.2"' \
  report --job rc --line hotfix/v0.2 --result failure --run-url u --dry-run
GH_TOKEN=test-token GITHUB_API_URL=http://127.0.0.1:9 expect_out ok "warning: could not report" \
  report --job rc --line hotfix/v0.2 --result failure --run-url u --error "boom"
expect_out fail "--job must be rc, deploy-test, final or cleanup" \
  report --job deploy --line release/v0.3 --result failure --run-url u

echo
if [ $misses -ne 0 ]; then echo "✗ $misses expectation(s) missed"; exit 1; fi
echo "✓ all expectations met"
