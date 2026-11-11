#!/usr/bin/env bash
# The `checks` job of .github/workflows/pr-checks.yml, run from the project's root.
# Environment (all optional; the workflow passes the project's repository variables):
#   CHECKS_COMMAND  the project's own check (e.g. "make lint"), run with bash -euo pipefail -c;
#                   when set, nothing else runs
#   CHECKS_DIRS     space-separated folders with a package.json (default: the root one, else
#                   every package.json up to two folders deep)
#   CHECKS_SCRIPTS  package.json scripts to run (default: "lint typecheck type-check"; missing
#                   ones are skipped)
#   CHECKS_DRY_RUN  non-empty: print the Node steps (+ npm ci …) instead of running them
set -euo pipefail

if [ -n "${CHECKS_COMMAND:-}" ]; then
  echo "+ $CHECKS_COMMAND"
  exec bash -euo pipefail -c "$CHECKS_COMMAND"
fi

CHECKS_SCRIPTS=${CHECKS_SCRIPTS:-lint typecheck type-check}
run() { if [ -n "${CHECKS_DRY_RUN:-}" ]; then echo "+ $*"; else "$@"; fi; }
if [ -n "${CHECKS_DIRS:-}" ]; then
  dirs=$(printf '%s\n' $CHECKS_DIRS)
elif [ -f package.json ]; then
  dirs=.
else
  dirs=$(find . -mindepth 2 -maxdepth 3 -name package.json -not -path '*/node_modules/*' -printf '%h\n' | sort)
fi
if [ -z "$dirs" ]; then
  echo "::notice::No package.json found; nothing to install, lint or typecheck."
  exit 0
fi
while IFS= read -r dir; do
  echo "::group::$dir"
  (
    cd "$dir"
    if [ -f pnpm-lock.yaml ]; then pm=pnpm; run corepack enable; run pnpm install --frozen-lockfile
    elif [ -f yarn.lock ] && [ -f .yarnrc.yml ]; then pm=yarn; run corepack enable; run yarn install --immutable
    elif [ -f yarn.lock ]; then pm=yarn; run yarn install --frozen-lockfile
    elif [ -f package-lock.json ]; then pm=npm; run npm ci
    else pm=npm; run npm install
    fi
    for script in $CHECKS_SCRIPTS; do
      if node -e "process.exit(require('./package.json').scripts?.[process.argv[1]] ? 0 : 1)" "$script"; then
        run "$pm" run "$script"
      else
        echo "no \"$script\" script in $dir/package.json; skipped"
      fi
    done
  )
  echo "::endgroup::"
done <<< "$dirs"
