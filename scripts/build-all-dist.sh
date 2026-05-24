#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_ZENMIND_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
ZENMIND_ROOT="${ZENMIND_ROOT:-$DEFAULT_ZENMIND_ROOT}"

CLEAN_FIRST=1
DRY_RUN=0
ONLY_PROJECTS=""
SKIP_PROJECTS=""

usage() {
  cat <<'EOF'
Usage:
  scripts/build-all-dist.sh [options]

Build latest dist/release packages for:
  container-hub -> agent-container-hub
  webclient     -> term-webclient
  platform      -> agent-platform
  app-server    -> zenmind-app-server

Options:
  --only a,b,c     Build only selected short names.
  --skip a,b,c     Skip selected short names.
  --no-clean       Do not remove previous dist output first.
  --dry-run        Print commands without running them.
  -h, --help       Show this help.

Environment:
  ZENMIND_ROOT     Override the parent directory containing the four projects.
  PROGRAM_TARGETS / PROGRAM_TARGET_MATRIX / ARCH / VERSION
                   Passed through to the underlying project release scripts.

Examples:
  scripts/build-all-dist.sh
  scripts/build-all-dist.sh --only container-hub,platform
  ZENMIND_ROOT=/Users/me/Project/zenmind scripts/build-all-dist.sh
EOF
}

log() {
  printf '[build-all-dist] %s\n' "$*"
}

die() {
  printf '[build-all-dist] %s\n' "$*" >&2
  exit 1
}

detect_host_os() {
  local uname_s
  uname_s="$(uname -s)"
  case "$uname_s" in
    Darwin)
      printf 'macos\n'
      ;;
    Linux)
      printf 'linux\n'
      ;;
    MINGW*|MSYS*|CYGWIN*)
      printf 'windows\n'
      ;;
    *)
      die "unsupported host OS: $uname_s"
      ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

contains_csv() {
  local csv="$1"
  local needle="$2"
  [[ ",$csv," == *",$needle,"* ]]
}

run_cmd() {
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  '
    printf '%q ' "$@"
    printf '\n'
    return
  fi
  "$@"
}

clean_dist_dir() {
  local project_dir="$1"
  local dist_dir="$project_dir/dist"

  if [[ "$CLEAN_FIRST" != "1" ]]; then
    return
  fi

  case "$dist_dir" in
    "$ZENMIND_ROOT"/*/dist)
      log "clean $dist_dir"
      run_cmd rm -rf "$dist_dir"
      ;;
    *)
      die "refusing to clean unexpected path: $dist_dir"
      ;;
  esac
}

build_project() {
  local short_name="$1"
  local repo_name="$2"
  local make_target="$3"
  local project_dir="$ZENMIND_ROOT/$repo_name"

  [[ -d "$project_dir" ]] || die "missing project directory for $short_name: $project_dir"
  [[ -f "$project_dir/Makefile" ]] || die "missing Makefile for $short_name: $project_dir/Makefile"

  log "start $short_name ($repo_name)"
  clean_dist_dir "$project_dir"
  run_cmd make -C "$project_dir" "$make_target"
  log "done $short_name"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || die "--only requires a comma-separated value"
      ONLY_PROJECTS="$2"
      shift 2
      ;;
    --skip)
      [[ $# -ge 2 ]] || die "--skip requires a comma-separated value"
      SKIP_PROJECTS="$2"
      shift 2
      ;;
    --no-clean)
      CLEAN_FIRST=0
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

HOST_OS="$(detect_host_os)"
case "$HOST_OS" in
  macos|linux)
    require_command make
    ;;
  windows)
    require_command make
    ;;
esac

[[ -d "$ZENMIND_ROOT" ]] || die "ZENMIND_ROOT does not exist: $ZENMIND_ROOT"

log "host=$HOST_OS root=$ZENMIND_ROOT"

PROJECT_SPECS=(
  "container-hub|agent-container-hub|release"
  "webclient|term-webclient|release"
  "platform|agent-platform|release"
  "app-server|zenmind-app-server|release"
)

for spec in "${PROJECT_SPECS[@]}"; do
  IFS='|' read -r short_name repo_name make_target <<<"$spec"

  if [[ -n "$ONLY_PROJECTS" ]] && ! contains_csv "$ONLY_PROJECTS" "$short_name"; then
    continue
  fi

  if [[ -n "$SKIP_PROJECTS" ]] && contains_csv "$SKIP_PROJECTS" "$short_name"; then
    log "skip $short_name"
    continue
  fi

  build_project "$short_name" "$repo_name" "$make_target"
done

log "all requested dist packages finished"
