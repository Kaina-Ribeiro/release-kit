#!/usr/bin/env bash
# Installs the release kit's callers into a target repository and prints (never runs) the commands
# that apply the GitHub settings. The callers run the kit's reusable workflows pinned at a version
# (default v1); release.mjs is no longer copied. Run it from a copy of the kit, or straight from
# GitHub, inside the project:
#   curl -fsSL https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/v1/install.sh | bash -s -- .
# Usage: install.sh [<target-repo-dir>] [--deploy] [--force] [--kit-ref <ref>]
#   <target-repo-dir>  default: the current folder
#   --deploy           also install the Deploy workflow (on by itself when the project already has
#                      one, or a Release workflow with deploy in its menu)
#   --force            overwrite files that differ
#   --kit-ref <ref>    the kit version the callers run, and the one downloaded (default: v1)
# The files come from the kit copy this script sits in; run any other way (piped from curl), or with
# RELEASE_KIT_RAW_BASE set, they are downloaded from
# ${RELEASE_KIT_RAW_BASE:-https://raw.githubusercontent.com/Kaina-Ribeiro/release-kit/<ref>}/<file>.
set -euo pipefail

kit_repo=Kaina-Ribeiro/release-kit
usage="usage: install.sh [<target-repo-dir>] [--deploy] [--force] [--kit-ref <ref>]"
target='' force='' deploy='' kit_ref=v1
while [ $# -gt 0 ]; do
  case $1 in
    -h|--help) echo "$usage"; exit 0 ;;
    --force) force=1 ;;
    --deploy) deploy=1 ;;
    --kit-ref) kit_ref=${2:-}; shift ;;
    --kit-ref=*) kit_ref=${1#*=} ;;
    -*) echo "error: unknown option $1" >&2; echo "$usage" >&2; exit 2 ;;
    *) if [ -n "$target" ]; then echo "$usage" >&2; exit 2; fi; target=$1 ;;
  esac
  shift
done
target=${target:-.}
if [ -z "$kit_ref" ]; then echo "$usage" >&2; exit 2; fi
if ! root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null); then
  echo "error: $target is not a git repository" >&2
  exit 1
fi

# Local: this script is a file inside a copy of the kit. Download: anything else.
self=${BASH_SOURCE[0]:-}
kit=''
if [ -z "${RELEASE_KIT_RAW_BASE:-}" ] && [ -f "$self" ] \
  && kit=$(cd "$(dirname "$self")" && pwd) && [ -f "$kit/workflows/release.yml" ]; then
  raw_base=''
else
  kit=''
  raw_base=${RELEASE_KIT_RAW_BASE:-https://raw.githubusercontent.com/$kit_repo/$kit_ref}
fi

# Deploys: asked for, or already on (a Deploy workflow, or a Release workflow from before it, with
# deploy in its menu; overwriting that one with --force must not take the button away).
old_release=''
if grep -qF "cut-hotfix, deploy" "$root/.github/workflows/release.yml" 2>/dev/null; then old_release=1; fi
if [ -e "$root/.github/workflows/deploy.yml" ] || [ -n "$old_release" ]; then deploy=1; fi

# source|destination (relative to the target root)
files=(
  "workflows/release.yml|.github/workflows/release.yml"
  "workflows/pr-checks.yml|.github/workflows/pr-checks.yml"
  "rulesets/default-branch.json|.github/rulesets/default-branch.json"
  "rulesets/version-lines.json|.github/rulesets/version-lines.json"
  "rulesets/version-tags.json|.github/rulesets/version-tags.json"
  "RELEASING.md|RELEASING.md"
)
if [ -n "$deploy" ]; then files+=("workflows/deploy.yml|.github/workflows/deploy.yml"); fi

# What each file becomes in the target: the callers point at @<kit_ref> instead of @v1 (the uses:
# line and the comments that name the version; @v1.2.0 and the like are left alone). Every file is
# staged before anything is copied, so a failed download leaves the project untouched.
staged=$(mktemp -d)
trap 'rm -rf "$staged"' EXIT
ref_sed=$(printf '%s' "$kit_ref" | sed 's/[#&\\]/\\&/g')
for entry in "${files[@]}"; do
  src=${entry%%|*}
  mkdir -p "$(dirname "$staged/$src")"
  if [ -n "$raw_base" ]; then
    if ! curl -fsSL "$raw_base/$src" -o "$staged/$src.orig"; then
      echo "error: cannot download $raw_base/$src; nothing was installed" >&2
      exit 1
    fi
  else
    cp "$kit/$src" "$staged/$src.orig"
  fi
  case $src in
    workflows/*) sed -E "s#@v1([^0-9A-Za-z_.-]|\.([^0-9]|\$)|\$)#@$ref_sed\1#g" "$staged/$src.orig" > "$staged/$src" ;;
    *) mv "$staged/$src.orig" "$staged/$src" ;;
  esac
done

conflicts=()
for entry in "${files[@]}"; do
  src=${entry%%|*}; dst=${entry##*|}
  if [ -e "$root/$dst" ] && ! cmp -s "$staged/$src" "$root/$dst"; then conflicts+=("$dst"); fi
done
if [ ${#conflicts[@]} -gt 0 ] && [ -z "$force" ]; then
  echo "error: these files exist and differ; re-run with --force to overwrite:" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  exit 1
fi

for entry in "${files[@]}"; do
  src=${entry%%|*}; dst=${entry##*|}
  mkdir -p "$(dirname "$root/$dst")"
  cp "$staged/$src" "$root/$dst"
  echo "copied $dst"
done

remote=$(git -C "$root" remote get-url origin 2>/dev/null || true)
repo=$(printf '%s' "$remote" | sed -nE 's#.*github\.com[:/]([^/]+/[^/]+)$#\1#p' | sed -E 's#\.git$##; s#/$##')
repo=${repo:-OWNER/REPO}
default=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)

# Personal accounts (owner type "User") reject the GitHub Actions app (Integration 15368) as a
# bypass actor (HTTP 422), so there the rulesets are applied with it removed and the repository
# admin role (id 5) bypassing instead. Unknown owner type: print the organization commands.
owner_type=${RELEASE_KIT_OWNER_TYPE:-}
if [ -z "$owner_type" ] && [ "$repo" != OWNER/REPO ] && command -v gh >/dev/null 2>&1; then
  owner_type=$(gh api "repos/$repo" --jq .owner.type 2>/dev/null || true)
fi
owner_type=${owner_type:-unknown}

if [ "$owner_type" = User ]; then
  personal='node -e '\''const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));r.bypass_actors=r.bypass_actors.filter(a=>a.actor_type!=="Integration");if(!r.bypass_actors.some(a=>a.actor_type==="RepositoryRole"&&a.actor_id===5))r.bypass_actors.push({actor_id:5,actor_type:"RepositoryRole",bypass_mode:"always"});console.log(JSON.stringify(r))'\'''
  rulesets="  # 4. Rulesets (list existing ones first: gh api repos/$repo/rulesets)
  #    Personal account: GitHub Actions cannot be a bypass actor, so the version rulesets are
  #    sent without it and with the admin role bypassing; RELEASE_TOKEN must be an admin's PAT.
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/default-branch.json
  $personal .github/rulesets/version-lines.json | gh api -X POST repos/$repo/rulesets --input -
  $personal .github/rulesets/version-tags.json | gh api -X POST repos/$repo/rulesets --input -"
else
  rulesets="  # 4. Rulesets (list existing ones first: gh api repos/$repo/rulesets)
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/default-branch.json
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/version-lines.json
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/version-tags.json"
  if [ "$owner_type" = unknown ]; then
    rulesets="$rulesets
  #    Owner type unknown; these are for organization repos. Personal account? Re-run with
  #    RELEASE_KIT_OWNER_TYPE=User (see RELEASING.md \"Setup\" 4)."
  fi
fi

# Deploys: the adapter and the targets (item 6), or a line on how to turn them on.
if [ -n "$deploy" ]; then
  deploys="
  # 6. Deploys: each rc goes to the test targets; Actions → Deploy sends a tag to test or prod.
  #    Pick one adapter. Your own script, run from the project's root as
  #    <command> deploy <stage> <target> <tag> and <command> current <stage> <target>:
  # gh variable set DEPLOY_COMMAND --repo $repo --body './scripts/deploy.sh'
  #    or Cubeship (targets are project/environment/app):
  # gh variable set DEPLOY_URL --repo $repo --body 'https://…'
  # gh secret set DEPLOY_TOKEN --repo $repo
  #    Then the targets, in order (empty = that stage deploys nothing):
  # gh variable set DEPLOY_TEST_APPS --repo $repo --body 'web'
  # gh variable set DEPLOY_PROD_APPS --repo $repo --body 'web'
"
else
  deploys="
Deploys are off. To let the kit deploy too, run this again with --deploy.
"
fi

# A Release workflow from before the Deploy workflow passed CUBESHIP_URL and CUBESHIP_TOKEN; the
# new callers pass DEPLOY_URL and DEPLOY_TOKEN only.
renames=''
if [ -n "$old_release" ]; then
  renames="
Your Release workflow was the old one, with deploy in its menu. The new callers pass DEPLOY_URL
and the secret DEPLOY_TOKEN; with only CUBESHIP_URL and CUBESHIP_TOKEN set, the next deploy fails
with \"no deploy adapter is configured\". Copy them to the new names before merging:

  gh variable set DEPLOY_URL --repo $repo --body \"\$(gh variable get CUBESHIP_URL --repo $repo)\"
  gh secret set DEPLOY_TOKEN --repo $repo   # paste the CUBESHIP_TOKEN value (secrets cannot be read back)
"
fi

# An installation from before the reusable workflows: the required checks were `checks` and
# `conventions`; now they are `pr-checks / checks` and `pr-checks / conventions`. The update
# rewrites only those names in the existing rulesets and sends every other field back as the
# repository has it (name, conditions, bypass list, approvals: rulesets get tuned by hand),
# then reads each one back.
upgrade=''
if [ -e "$root/.github/scripts/release.mjs" ]; then
  # Prints the whole ruleset (its writable fields) with the two contexts renamed, or nothing
  # when it requires neither.
  rename='node -e '\''let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);let n=0;for(const x of r.rules)if(x.type==="required_status_checks")for(const c of x.parameters.required_status_checks)if(c.context==="checks"||c.context==="conventions"){c.context="pr-checks / "+c.context;n++}if(n)console.log(JSON.stringify({name:r.name,target:r.target,enforcement:r.enforcement,conditions:r.conditions,bypass_actors:r.bypass_actors??[],rules:r.rules}))})'\'''
  readback='"\(.name): \([.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context] | join(", ")); bypass \([.bypass_actors[]? | "\(.actor_type):\(.actor_id):\(.bypass_mode)"] | join(","))"'
  upgrade="
This repository has the old installation (.github/scripts/release.mjs). Also:

  # a. Remove the copied script; the kit now runs from $kit_repo@$kit_ref
  git -C \"$root\" rm .github/scripts/release.mjs

  # b. Rename the required checks in every branch ruleset that requires them (run it right
  #    before merging the PR that installs the callers: that PR's checks already run with the
  #    new names, and the old ones never report again)
  gh api repos/$repo/rulesets --jq '.[] | \"\\(.id) \\(.target) \\(.name)\"'
  for id in \$(gh api repos/$repo/rulesets --jq '.[] | select(.target == \"branch\") | .id'); do
    body=\$(gh api repos/$repo/rulesets/\$id | $rename)
    if [ -n \"\$body\" ]; then printf '%s' \"\$body\" | gh api -X PUT repos/$repo/rulesets/\$id --input - --jq '\"updated \\(.id) \\(.name)\"'; fi
  done
  # c. Read them back: the new check names and the same bypass list as before
  for id in \$(gh api repos/$repo/rulesets --jq '.[] | select(.target == \"branch\") | .id'); do
    gh api repos/$repo/rulesets/\$id --jq '$readback'
  done

The other settings (merge methods, Actions PRs, token, rulesets, variables) came with the first
install; nothing else to apply.
"
  cat <<EOF

Kit callers installed into $root (repository: $repo, owner type: $owner_type, default branch: ${default:-unknown}).
They run $kit_repo's reusable workflows at @$kit_ref.
Nothing was committed, pushed or applied. Review the files, commit them on a branch, open a PR.
$upgrade$renames
Check the state at any time (fetches the pinned release.mjs into .git, never committed):
  curl -fsSL https://raw.githubusercontent.com/$kit_repo/$kit_ref/release.mjs -o .git/release.mjs && node .git/release.mjs status
EOF
  exit 0
fi

cat <<EOF

Kit callers installed into $root (repository: $repo, owner type: $owner_type, default branch: ${default:-unknown}).
They run $kit_repo's reusable workflows at @$kit_ref.
Nothing was committed, pushed or applied. Review the files, commit them on a branch, open a PR.

Then apply the GitHub settings yourself (run from $root; read RELEASING.md "Setup" first):

  # 1. Merge methods: merge commit + squash, no rebase
  gh api -X PATCH repos/$repo -F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false

  # 2. Let GitHub Actions open pull requests (sync PRs)
  gh api -X PUT repos/$repo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

  # 3. Token for the automation (recommended; see RELEASING.md)
  gh secret set RELEASE_TOKEN --repo $repo

$rulesets
  #    To update one later: gh api -X PUT repos/$repo/rulesets/<id> --input <the same input>

  # 5. Optional variables
  gh variable set TICKET_PATTERN --repo $repo --body '[A-Z][A-Z0-9]+-\d+'
  #    Branches and titles without a ticket (feat/login, "feat: add login"):
  # gh variable set TICKET_PATTERN --repo $repo --body none
  #    Your own PR check instead of the npm install/lint/typecheck:
  # gh variable set CHECKS_COMMAND --repo $repo --body 'make lint'
$deploys$renames
Check the state at any time (fetches the pinned release.mjs into .git, never committed):
  curl -fsSL https://raw.githubusercontent.com/$kit_repo/$kit_ref/release.mjs -o .git/release.mjs && node .git/release.mjs status
EOF
