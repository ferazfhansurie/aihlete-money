#!/usr/bin/env bash
# money.aihlete.com — build the static export and publish it to the gh-pages branch.
set -euo pipefail
cd "$(dirname "$0")"
npm run build
tmp=$(mktemp -d)
cp -R out/. "$tmp"/
touch "$tmp/.nojekyll"
printf 'money.aihlete.com\n' > "$tmp/CNAME"
cd "$tmp"
git init -q
git add -A
git -c user.email=firaz@fathopesenergy.com -c user.name=firaz commit -qm "deploy $(date -u +%Y-%m-%dT%H:%MZ)"
git push -q --force "https://x-access-token:$(gh auth token)@github.com/ferazfhansurie/aihlete-money.git" HEAD:gh-pages
cd - >/dev/null && rm -rf "$tmp"
echo "deployed → https://money.aihlete.com"
