#!/bin/sh
# Run the installed WeCom CLI using Desktop's embedded Node.
# Usage: ./wecom-desktop.sh /absolute/path/to/Desktop-executable /absolute/path/to/wecom.js [arguments...]
set -eu
if [ "$#" -lt 2 ]; then
  printf '%s\n' "Usage: $0 <Desktop executable> <wecom.js> [CLI arguments...]" >&2
  exit 64
fi
wecom_desktop_executable=$1
wecom_entry=$2
shift 2
case "$wecom_desktop_executable" in /*) ;; *) printf '%s\n' 'Desktop executable must be an absolute path' >&2; exit 64 ;; esac
case "$wecom_entry" in /*) ;; *) printf '%s\n' 'WeCom entry must be an absolute path' >&2; exit 64 ;; esac
[ -x "$wecom_desktop_executable" ] || { printf '%s\n' 'Desktop executable is missing or not executable' >&2; exit 66; }
[ -f "$wecom_entry" ] || { printf '%s\n' 'WeCom entry is missing' >&2; exit 66; }
ELECTRON_RUN_AS_NODE=1 exec "$wecom_desktop_executable" "$wecom_entry" "$@"
