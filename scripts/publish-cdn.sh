#!/usr/bin/env bash
# Upload the UMD build to the platform's bucket, where the backend serves
# it as https://www.runapps.ai/sdk/<version>.js and /sdk/latest.js.
#
# Needs the bucket credentials in the environment (AWS_ACCESS_KEY_ID,
# AWS_SECRET_ACCESS_KEY, R2_ENDPOINT, R2_BUCKET); ~/.config/runapps/r2.env
# is sourced when present. Run after `npm run build` and the npm release:
#
#   npm run release:cdn            # uploads <version>.js and latest.js
#   npm run release:cdn -- --pin   # uploads <version>.js only
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f "$HOME/.config/runapps/r2.env" ] && . "$HOME/.config/runapps/r2.env"
: "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}" "${R2_ENDPOINT:?}" "${R2_BUCKET:?}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

version=$(node -p "require('./package.json').version")
file=dist/sdk.umd.js
[ -s "$file" ] || { echo "no $file — run npm run build first" >&2; exit 1; }
grep -q "@runappsai/sdk $version" "$file" || echo "warning: $file does not mention $version; is the build current?" >&2

put() {
  aws s3 cp "$file" "s3://$R2_BUCKET/sdk/$1" --endpoint-url "$R2_ENDPOINT" \
    --content-type "application/javascript; charset=utf-8" --only-show-errors
  echo "uploaded sdk/$1 ($(wc -c < "$file") bytes)"
}
put "$version.js"
[ "${1:-}" = "--pin" ] || put latest.js
