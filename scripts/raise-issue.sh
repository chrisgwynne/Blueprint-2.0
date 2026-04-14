#!/bin/bash
# Raise a GitHub issue from the CLI in one line.
#
# Usage:
#   bash scripts/raise-issue.sh "bug: title" "description body" [label1,label2]
#
# Defaults to label "bug" if no label is provided. Multiple labels can be
# passed comma-separated. Opens the created issue URL on stdout.

set -euo pipefail

TITLE="${1:-}"
BODY="${2:-}"
LABELS="${3:-bug}"

if [ -z "$TITLE" ]; then
  echo "Usage: bash scripts/raise-issue.sh 'title' 'description' [labels-csv]"
  echo ""
  echo "Examples:"
  echo "  bash scripts/raise-issue.sh 'bug: agents hired too early' 'Details...' bug,agent,v1.0"
  echo "  bash scripts/raise-issue.sh 'enhancement: add X' 'Details...' enhancement"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "error: GitHub CLI (gh) not installed. Install from https://cli.github.com/"
  exit 1
fi

# --label accepts one at a time on older gh versions; convert CSV.
LABEL_FLAGS=""
IFS=','
for lbl in $LABELS; do
  LABEL_FLAGS="$LABEL_FLAGS --label $lbl"
done
unset IFS

# shellcheck disable=SC2086
gh issue create \
  --title "$TITLE" \
  --body "$BODY" \
  $LABEL_FLAGS
