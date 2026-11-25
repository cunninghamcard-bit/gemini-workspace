#!/usr/bin/env sh
# Vendor agy-fast tool implementations into src/agy-fast/.
# Usage: scripts/sync-agy-fast.sh [path-to-agy-fast-checkout]
set -eu

SRC="${1:-$HOME/Projects/agy-fast}"
ROOT="$(CDPATH= cd -P "$(dirname "$0")/.." && pwd -P)"
DST="$ROOT/src/agy-fast"

test -f "$SRC/src/tools/batch-search.ts" || { echo "not an agy-fast checkout: $SRC" >&2; exit 1; }

rm -rf "$DST"
mkdir -p "$DST/tools" "$DST/utils"
cp "$SRC"/src/tools/apply-edits.ts "$SRC"/src/tools/batch-search.ts \
   "$SRC"/src/tools/read-slices.ts "$SRC"/src/tools/run-checks.ts "$DST/tools/"
cp "$SRC"/src/utils/arg-validation.ts "$SRC"/src/utils/exec-utils.ts \
   "$SRC"/src/utils/fs-utils.ts "$SRC"/src/utils/fuzzy-match.ts \
   "$SRC"/src/utils/output-filter.ts "$DST/utils/"
cp "$SRC/LICENSE" "$DST/LICENSE"

# Gemini Web kills tool calls at ~60s; agy-fast budgets for agy's 180s.
sed -i.bak 's/^export const MCP_CALL_BUDGET_SEC = [0-9]*;/export const MCP_CALL_BUDGET_SEC = 45;/' "$DST/utils/exec-utils.ts"
rm "$DST/utils/exec-utils.ts.bak"
grep -q '^export const MCP_CALL_BUDGET_SEC = 45;' "$DST/utils/exec-utils.ts" || { echo "budget patch failed" >&2; exit 1; }

printf '%s\n' "$(git -C "$SRC" rev-parse HEAD)" > "$DST/UPSTREAM_COMMIT"
echo "synced agy-fast $(cat "$DST/UPSTREAM_COMMIT") -> $DST"
