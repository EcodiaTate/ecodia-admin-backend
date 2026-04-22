#!/usr/bin/env bash
# Tier-4b: initialize bi-temporal validity on Decision / Pattern / Strategic_Direction
set -euo pipefail
cd "$(dirname "$0")/.."
node scripts/initialize-bitemporal-decisions.js
