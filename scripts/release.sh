#!/usr/bin/env bash
# Release script.
#
# Bumps the version (creates a git commit + tag) and publishes to npm.
# `prepublishOnly` runs lint/typecheck/test/build before publish, so this
# script stays thin on purpose.
#
# Usage: ./scripts/release.sh [patch|minor|major]
#
# Why: the user commits manually, so this script does NOT push tags.
# After it exits, run `git push --follow-tags` yourself.

set -euo pipefail

bump="${1:-patch}"
if [[ ! "$bump" =~ ^(patch|minor|major)$ ]]; then
  echo "usage: $0 [patch|minor|major]" >&2
  exit 1
fi

# Refuse to clobber uncommitted work — npm version refuses too, but checking
# up front gives a clearer error.
if ! git diff --quiet; then
  echo "working tree has uncommitted changes; commit or stash first." >&2
  exit 1
fi

# Print the version we're about to publish so the operator can sanity-check.
current="$(node -p "require('./package.json').version")"
echo "current version: $current"
echo "bump: $bump"

npm version "$bump"
new="$(node -p "require('./package.json').version")"
echo "new version: $new"

# `prepublishOnly` runs here: lint → typecheck → test → build.
npm publish

echo
echo "Published $new. Next: git push --follow-tags"