#!/usr/bin/env bash
set -e

LOG_FILE="/opt/mdrcloud-lxc-panel/data/update.log"
TRIGGER_FILE="/opt/mdrcloud-lxc-panel/data/.update_trigger"
rm -f "$TRIGGER_FILE"

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Starting MDRCloud LXC Panel Update ===" >> "$LOG_FILE"

cd /opt/mdrcloud-lxc-panel

# Fetch both origin (MDRCloud fork) and upstream (original repo)
git fetch origin main >> "$LOG_FILE" 2>&1 || true
git fetch upstream main >> "$LOG_FILE" 2>&1 || true

# Pull latest from origin main
git pull origin main >> "$LOG_FILE" 2>&1 || true

# Rebuild and restart the container
docker compose up -d --build >> "$LOG_FILE" 2>&1

echo "=== [$(date '+%Y-%m-%d %H:%M:%S')] Update Complete! ===" >> "$LOG_FILE"
