#!/bin/bash

set -euo pipefail

APP_NAME="ZenMind"
APP_PATH="/Applications/${APP_NAME}.app"
DATA_PATH="${HOME}/.zenmind/.desktop"
PROGRAM_DATA_PATH="${HOME}/Library/Application Support/ZenMind"
STORAGE_NAMESPACE="zenmind-desktop"
SHUTDOWN_ARG="--desktop-shutdown-for-update"
ACK_PATH="${TMPDIR:-/tmp}/${STORAGE_NAMESPACE}-shutdown-$$-$(date +%s).status"
SNAPSHOT_PATH="${TMPDIR:-/tmp}/${STORAGE_NAMESPACE}-processes-$$-$(date +%s).snapshot"

cleanup_temp_files() {
  rm -f "$ACK_PATH" "$SNAPSHOT_PATH"
}

trap cleanup_temp_files EXIT

show_dialog() {
  local message="$1"

  osascript -e "display dialog \"$message\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null
}

request_desktop_shutdown() {
  local executable="$APP_PATH/Contents/MacOS/$APP_NAME"
  local attempt=0

  rm -f "$ACK_PATH"
  if [ ! -x "$executable" ]; then
    return 0
  fi

  "$executable" "$SHUTDOWN_ARG" "--desktop-shutdown-ack=$ACK_PATH" >/dev/null 2>&1 &
  while [ "$attempt" -lt 24 ]; do
    if [ -f "$ACK_PATH" ]; then
      head -n 1 "$ACK_PATH" 2>/dev/null || true
      return 0
    fi
    attempt=$((attempt + 1))
    sleep 0.5
  done
  printf '%s\n' "NO_ACK"
}

append_unique_pid() {
  local candidate="$1"
  case " $MANAGED_PIDS " in
    *" $candidate "*) ;;
    *) MANAGED_PIDS="$MANAGED_PIDS $candidate" ;;
  esac
}

capture_managed_processes() {
  if ! ps -axo pid=,ppid=,command= >"$SNAPSHOT_PATH"; then
    return 1
  fi

  ROOT_PIDS=""
  MANAGED_PIDS=""
  while read -r pid ppid command; do
    [ -n "${pid:-}" ] || continue
    [ "$pid" = "$$" ] && continue
    local matched=0
    case "$command" in *"$APP_PATH"*) matched=1 ;; esac
    if [ "$matched" = "0" ]; then
      case "$command" in *"$PROGRAM_DATA_PATH"*) matched=1 ;; esac
    fi
    if [ "$matched" = "0" ]; then
      case "$command" in *"$DATA_PATH"*) matched=1 ;; esac
    fi
    if [ "$matched" = "1" ]; then
      ROOT_PIDS="$ROOT_PIDS $pid"
      append_unique_pid "$pid"
    fi
  done <"$SNAPSHOT_PATH"

  local pending="$ROOT_PIDS"
  while [ -n "${pending// /}" ]; do
    local next=""
    for parent in $pending; do
      while read -r child; do
        [ -n "$child" ] || continue
        append_unique_pid "$child"
        next="$next $child"
      done < <(awk -v parent="$parent" '$2 == parent { print $1 }' "$SNAPSHOT_PATH")
    done
    pending="$next"
  done
}

signal_managed_processes() {
  local signal="$1"
  local current_pgid
  current_pgid="$(ps -o pgid= -p $$ | tr -d ' ')"

  for root in $ROOT_PIDS; do
    local pgid
    pgid="$(ps -o pgid= -p "$root" 2>/dev/null | tr -d ' ' || true)"
    if [ -n "$pgid" ] && [ "$pgid" != "$current_pgid" ]; then
      kill "-$signal" "-$pgid" 2>/dev/null || true
    fi
  done

  for pid in $MANAGED_PIDS; do
    kill "-$signal" "$pid" 2>/dev/null || true
  done
}

wait_for_managed_processes() {
  local timeout_steps="$1"
  local step=0
  while [ "$step" -lt "$timeout_steps" ]; do
    SURVIVOR_PIDS=""
    for pid in $MANAGED_PIDS; do
      if kill -0 "$pid" 2>/dev/null; then
        SURVIVOR_PIDS="$SURVIVOR_PIDS $pid"
      fi
    done
    if [ -z "${SURVIVOR_PIDS// /}" ]; then
      return 0
    fi
    step=$((step + 1))
    sleep 0.1
  done
  return 1
}

stop_managed_processes() {
  if ! capture_managed_processes; then
    SURVIVOR_PIDS="process snapshot failed"
    return 2
  fi
  if [ -z "${MANAGED_PIDS// /}" ]; then
    SURVIVOR_PIDS=""
    return 0
  fi

  signal_managed_processes TERM
  if wait_for_managed_processes 20; then
    return 0
  fi
  signal_managed_processes KILL
  wait_for_managed_processes 10
}

remove_application_bundle() {
  if [ ! -d "$APP_PATH" ]; then
    printf '%s\n' "Application bundle not found at $APP_PATH. Skipping app removal."
    return 0
  fi

  local escaped_app_path
  escaped_app_path=${APP_PATH//\"/\\\"}
  osascript -e "do shell script \"rm -rf \\\"$escaped_app_path\\\"\" with administrator privileges" >/dev/null
  printf '%s\n' "Removed application bundle: $APP_PATH"
}

prompt_for_data_cleanup() {
  osascript -e "button returned of (display dialog \"Do you also want to delete $APP_NAME app data?\n\nThis removes $DATA_PATH and $PROGRAM_DATA_PATH, including settings, service config, service/plugin program files, credentials, logs, caches, and browser profiles.\" buttons {\"Keep Data\", \"Delete Data\"} default button \"Keep Data\" with icon caution)"
}

ACK_STATUS="$(request_desktop_shutdown)"
printf '%s\n' "Desktop shutdown acknowledgement: $ACK_STATUS"

if ! stop_managed_processes; then
  show_dialog "$APP_NAME still has managed processes running. Uninstall was stopped. Remaining PIDs: $SURVIVOR_PIDS"
  printf '%s\n' "$APP_NAME uninstall stopped; remaining managed PIDs:$SURVIVOR_PIDS"
  exit 20
fi

remove_application_bundle

if [ "$(prompt_for_data_cleanup)" = "Delete Data" ]; then
  rm -rf "$DATA_PATH"
  rm -rf "$PROGRAM_DATA_PATH"
  printf '%s\n' "Removed app data: $DATA_PATH"
  printf '%s\n' "Removed program data: $PROGRAM_DATA_PATH"
else
  printf '%s\n' "Kept app data: $DATA_PATH"
  printf '%s\n' "Kept program data: $PROGRAM_DATA_PATH"
fi

printf '%s\n' "$APP_NAME uninstall finished."
