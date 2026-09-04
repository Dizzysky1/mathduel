#!/usr/bin/env bash
# Fails unless vendor/peerjs.min.js matches the hash recorded in vendor/INTEGRITY
# AND the SRI attribute in index.html. Run in CI and before every deploy.
set -euo pipefail
cd "$(dirname "$0")/.."
expected="$(grep -o 'sha384-[A-Za-z0-9+/=]*' vendor/INTEGRITY)"
in_html="$(grep -o 'integrity="sha384-[A-Za-z0-9+/=]*"' index.html | sed 's/integrity="//; s/"$//')"
actual="sha384-$(openssl dgst -sha384 -binary vendor/peerjs.min.js | openssl base64 -A)"
echo "INTEGRITY file: $expected"
echo "index.html SRI: $in_html"
echo "actual:         $actual"
[ "$expected" = "$actual" ] || { echo "vendor/INTEGRITY does not match vendor/peerjs.min.js"; exit 1; }
[ "$in_html" = "$actual" ] || { echo "index.html SRI attribute does not match vendor/peerjs.min.js"; exit 1; }
echo "integrity OK"
