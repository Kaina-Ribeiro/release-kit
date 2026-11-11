#!/usr/bin/env bash
# A stand-in for a project's own deploy script (DEPLOY_COMMAND), for test/fixtures.sh section 19.
# Usage: deploy-command.sh deploy <stage> <target> <tag> | current <stage> <target>
# State lives in $DEPLOY_STATE (a folder): log (one line per deploy) and <stage>-<target> (the tag).
#   deploy:  target bad exits 1 first; target slow sleeps 5 s; else records the tag.
#   current: target mute prints nothing; boom exits 3; sha prints the first 12 characters of the
#            recorded tag's commit; else the recorded tag, or none.
set -euo pipefail
: "${DEPLOY_STATE:?DEPLOY_STATE must be a folder}"
verb=${1:?verb} stage=${2:?stage} target=${3:?target}

case "$verb" in
  deploy)
    tag=${4:?tag}
    [ "$target" = bad ] && { echo "deploy-command: $target refuses to deploy" >&2; exit 1; }
    echo "$RELEASE_STAGE $RELEASE_TARGET $RELEASE_TAG $RELEASE_SHA" >> "$DEPLOY_STATE/log"
    [ "$target" = slow ] && sleep 5
    echo "$tag" > "$DEPLOY_STATE/$stage-$target"
    echo "deploy-command: $target on $stage now runs $tag"
    ;;
  current)
    file="$DEPLOY_STATE/$stage-$target"
    case "$target" in
      mute) ;;
      boom) echo "deploy-command: cannot reach $target" >&2; exit 3 ;;
      sha) git rev-parse "$(cat "$file")^{commit}" | cut -c1-12 ;;
      *) if [ -e "$file" ]; then cat "$file"; else echo none; fi ;;
    esac
    ;;
  *) echo "deploy-command: unknown verb $verb" >&2; exit 2 ;;
esac
