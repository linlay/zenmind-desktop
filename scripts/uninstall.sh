#!/bin/bash

set -euo pipefail

APP_NAME="XiaoJun"
APP_PATH="/Applications/${APP_NAME}.app"
DATA_PATH="${HOME}/.zenmind/.desktop"
PROGRAM_DATA_PATH="${HOME}/Library/Application Support/ZenMind"

show_dialog() {
  local message="$1"

  osascript -e "display dialog \"$message\" buttons {\"OK\"} default button \"OK\" with icon caution" >/dev/null
}

is_app_running() {
  osascript -e "tell application \"System Events\" to return (name of processes) contains \"$APP_NAME\""
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

if [ "$(is_app_running)" = "true" ]; then
  show_dialog "$APP_NAME is still running. Quit the app and run this uninstall script again."
  printf '%s\n' "$APP_NAME is still running. Quit it and rerun this script."
  exit 1
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
