#!/usr/bin/env bash
# Copies the release kit into a target repository and prints (never runs) the commands that
# apply the GitHub settings. Usage: install.sh <target-repo-dir> [--force]
set -euo pipefail

kit=$(cd "$(dirname "$0")" && pwd)
target=${1:-}
force=${2:-}
if [ -z "$target" ] || [ "$target" = "-h" ] || [ "$target" = "--help" ]; then
  echo "usage: $0 <target-repo-dir> [--force]" >&2
  exit 2
fi
if ! root=$(git -C "$target" rev-parse --show-toplevel 2>/dev/null); then
  echo "error: $target is not a git repository" >&2
  exit 1
fi

# source|destination (relative to the target root)
files=(
  "release.mjs|.github/scripts/release.mjs"
  "workflows/release.yml|.github/workflows/release.yml"
  "workflows/pr-checks.yml|.github/workflows/pr-checks.yml"
  "rulesets/default-branch.json|.github/rulesets/default-branch.json"
  "rulesets/version-lines.json|.github/rulesets/version-lines.json"
  "rulesets/version-tags.json|.github/rulesets/version-tags.json"
  "RELEASING.md|RELEASING.md"
)

conflicts=()
for entry in "${files[@]}"; do
  src=${entry%%|*}; dst=${entry##*|}
  if [ -e "$root/$dst" ] && ! cmp -s "$kit/$src" "$root/$dst"; then conflicts+=("$dst"); fi
done
if [ ${#conflicts[@]} -gt 0 ] && [ "$force" != "--force" ]; then
  echo "error: these files exist and differ; re-run with --force to overwrite:" >&2
  printf '  %s\n' "${conflicts[@]}" >&2
  exit 1
fi

for entry in "${files[@]}"; do
  src=${entry%%|*}; dst=${entry##*|}
  mkdir -p "$(dirname "$root/$dst")"
  cp "$kit/$src" "$root/$dst"
  echo "copied $dst"
done

remote=$(git -C "$root" remote get-url origin 2>/dev/null || true)
repo=$(printf '%s' "$remote" | sed -nE 's#.*github\.com[:/]([^/]+/[^/]+)$#\1#p' | sed -E 's#\.git$##; s#/$##')
repo=${repo:-OWNER/REPO}
default=$(git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's#^origin/##' || true)

cat <<EOF

Kit copied into $root (repository: $repo, default branch: ${default:-unknown}).
Nothing was committed, pushed or applied. Review the files, commit them on a branch, open a PR.

Then apply the GitHub settings yourself (run from $root; read RELEASING.md "Setup" first):

  # 1. Merge methods: merge commit + squash, no rebase
  gh api -X PATCH repos/$repo -F allow_merge_commit=true -F allow_squash_merge=true -F allow_rebase_merge=false

  # 2. Let GitHub Actions open pull requests (sync PRs)
  gh api -X PUT repos/$repo/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true

  # 3. Token for the automation (recommended; see RELEASING.md)
  gh secret set RELEASE_TOKEN --repo $repo

  # 4. Rulesets (list existing ones first: gh api repos/$repo/rulesets)
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/default-branch.json
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/version-lines.json
  gh api -X POST repos/$repo/rulesets --input .github/rulesets/version-tags.json
  #    To update one later: gh api -X PUT repos/$repo/rulesets/<id> --input <file>

  # 5. Optional variables
  gh variable set TICKET_PATTERN --repo $repo --body '[A-Z][A-Z0-9]+-\d+'

Check the state at any time: node .github/scripts/release.mjs status
EOF
