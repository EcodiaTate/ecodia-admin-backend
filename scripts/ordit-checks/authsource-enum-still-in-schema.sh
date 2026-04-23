#!/usr/bin/env bash
# Ordit-specific sanity check: AuthSource enum + User.authSource column
# must still be present in prisma/schema.prisma. Guards against an accidental
# revert of the Cognito integration schema.
#
# Expected CWD: the Ordit backend checkout.
# Exit 0 on pass, 1 if either is missing.

set -u

schema="prisma/schema.prisma"

if [ ! -f "$schema" ]; then
  echo "FAIL: $schema not found (are you in the Ordit backend checkout?)"
  exit 1
fi

if ! grep -q "enum AuthSource" "$schema"; then
  echo "FAIL: enum AuthSource not found in $schema"
  exit 1
fi

if ! grep -qE "authSource[[:space:]]+AuthSource" "$schema"; then
  echo "FAIL: User.authSource column not found in $schema"
  exit 1
fi

exit 0
