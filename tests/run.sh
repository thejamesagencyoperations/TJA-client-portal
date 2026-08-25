#!/bin/sh
# Run every test. No package.json on purpose — this repo has no build step and no deps;
# the tests lift the functions they exercise straight out of the shipped source files.
#   sh tests/run.sh
set -e
fail=0
for t in "$(dirname "$0")"/*.test.cjs; do
  echo "── $(basename "$t")"
  node "$t" || fail=1
done
[ $fail -eq 0 ] && echo "\nAll suites passed." || { echo "\nSome suites FAILED."; exit 1; }
