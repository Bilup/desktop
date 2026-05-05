#!/usr/bin/env bash
set -e

if [ -z "$R2_ACCOUNT_ID" ]; then
  echo "R2_ACCOUNT_ID is not set"
  exit 1
fi

aws "$@" \
  --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"