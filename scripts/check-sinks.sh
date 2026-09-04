#!/usr/bin/env bash
# Fails if app code uses any HTML/script injection sink. Peer data must only
# ever reach the DOM via textContent / createTextNode.
set -euo pipefail
cd "$(dirname "$0")/.."
test -d src && test -d scripts && test -f index.html
pattern='innerHTML|outerHTML|insertAdjacentHTML|createContextualFragment|document\.write|srcdoc|\beval\(|new Function\(|setTimeout\(\s*["'"'"']|setInterval\(\s*["'"'"']|setAttribute\(\s*["'"'"']on|\.cssText|location\s*=[^=]|\bon[a-z]+\s*=\s*["'"'"']'
if grep -rnE --exclude=check-sinks.sh "$pattern" src/ scripts/ index.html; then
  echo "injection sink found"; exit 1
fi
echo "no injection sinks"
