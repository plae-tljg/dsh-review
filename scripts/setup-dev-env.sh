#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Create this plugin's development environment.
#
# The plugin's own package is plain JavaScript with no build-time
# dependencies, but its tests and its build need three things the harness
# owns:
#
#   - @deepseek-ai/cordis, @deepseek-ai/dsh-client-store and
#     @deepseek-ai/dsh-typert-protocol, which the plugin imports at runtime;
#   - zod, which the build BUNDLES rather than leaving external, so the
#     version must be the one the harness itself uses;
#   - esbuild and react, which the build and the render test resolve from a
#     harness checkout.
#
# The three imports are installed from the registry at the versions that
# match the harness this plugin is built against, so a host needs no harness
# checkout to RUN the plugin — only to BUILD it.
#
# Usage:
#   scripts/setup-dev-env.sh [path-to-harness-checkout]
#
# The checkout is used for esbuild and react only. It comes from
# $DSH_CHECKOUT when the argument is absent; the build and the test fall
# back to the mother checkout and the plain checkout under ~/00lib.
# ---------------------------------------------------------------------------
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
checkout="${1:-${DSH_CHECKOUT:-/home/fit/00lib/dsh-harness}}"

# The harness line this plugin is built against. The packages are published
# at the same version as the harness release they belong to.
DSH_LINE="0.2.2-rc.4"

echo "setup-dev-env: installing the runtime imports at the ${DSH_LINE} line"
cd "$here"

# `--no-save` keeps the plugin's own manifest free of the harness's
# packages: they are the harness's identities, and a plugin that declared
# them would claim ownership of modules the harness owns.
#
# `immer`, `zustand`, `react`, `react-dom` and `use-sync-external-store` are
# here because the published `@deepseek-ai/dsh-client-store` imports immer
# and zustand WITHOUT declaring them, and zustand imports react and
# use-sync-external-store — so a flat install has to carry the whole chain
# beside it. The RUNNING plugin never needs any of them: the browser half
# takes the harness's own module table, and the harness's build carries
# them all.
npm install --no-save --no-package-lock \
  "@deepseek-ai/cordis@~4.1.0" \
  "@deepseek-ai/dsh-client-store@${DSH_LINE}" \
  "@deepseek-ai/dsh-typert-protocol@${DSH_LINE}" \
  "zustand@^5" \
  "immer@^10" \
  "react@18.3.1" \
  "react-dom@18.3.1" \
  "use-sync-external-store@^1" \
  2>&1 | tail -3

echo
echo "setup-dev-env: the build and the tests also read from the checkout"
if [ ! -d "$checkout/node_modules/.pnpm" ]; then
  echo "  $checkout is not an installed checkout." >&2
  echo "  The build resolves esbuild and the render test resolves react from it." >&2
  echo "  Install it there first, or point DSH_CHECKOUT at one that is." >&2
  exit 1
fi
echo "  using $checkout"

echo
echo "done. Build and test with:"
echo "  DSH_CHECKOUT=$checkout node build/build.mjs"
echo "  DSH_CHECKOUT=$checkout node --test \"tests/*.test.mjs\""
