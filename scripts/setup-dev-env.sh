#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Create this plugin's development environment.
#
# The plugin's own package is plain JavaScript with no build-time
# dependencies, but its tests and its build need three things the harness
# owns:
#
#   - @deepseek-ai/cordis, @deepseek-ai/dsh-client-store and
#     @deepseek-ai/dsh-typert-protocol, which the harness checkout carries
#     as source packages;
#   - zod, which the build BUNDLES rather than leaving external, so the
#     version must be the one the harness itself uses;
#   - esbuild and react, which the build resolves from the same checkout.
#
# A harness checkout is a monorepo, so none of these are installable from a
# registry in a form the plugin can consume. They are therefore symlinks
# into the checkout — which is also why the build used to embed a
# checkout-relative path in its output and made the artifact differ from
# one machine to the next.
#
# Usage:
#   scripts/setup-dev-env.sh [path-to-harness-checkout]
#
# The checkout comes from $DSH_CHECKOUT when the argument is absent. The
# default is the local mother checkout this repository expects.
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${1:-${DSH_CHECKOUT:-/home/fit/00lib/dsh-mother}}"

if [ ! -d "$checkout/packages" ]; then
  echo "setup-dev-env: $checkout does not look like a harness checkout" >&2
  exit 1
fi

echo "setup-dev-env: using the checkout at $checkout"

mkdir -p "$here/node_modules/@deepseek-ai"

link() {
  local target="$1" name="$2"
  if [ ! -e "$target" ]; then
    echo "  missing: $target" >&2
    return 1
  fi
  ln -sfn "$target" "$here/node_modules/$name"
  echo "  $name -> $target"
}

echo "linking the harness packages:"
link "$checkout/vendor/cordis" "@deepseek-ai/cordis"
link "$checkout/packages/client/store" "@deepseek-ai/dsh-client-store"
link "$checkout/packages/typert/protocol" "@deepseek-ai/dsh-typert-protocol"

# zod: the build bundles the version the harness itself uses, so it is
# resolved out of the checkout's pnpm store rather than pinned.
zod_dir="$(ls -1d "$checkout"/node_modules/.pnpm/zod@* 2>/dev/null | sort -V | tail -1 || true)"
if [ -n "$zod_dir" ]; then
  link "$zod_dir/node_modules/zod" "zod"
else
  echo "  zod is not installed in the checkout; run 'pnpm install' there first" >&2
fi

echo
echo "done. Build and test with:"
echo "  DSH_CHECKOUT=$checkout node build/build.mjs"
echo "  DSH_CHECKOUT=$checkout node --test \"tests/*.test.mjs\""
