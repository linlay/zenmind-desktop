#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_DESKTOP_WORKSPACE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DESKTOP_WORKSPACE_ROOT="${DESKTOP_WORKSPACE_ROOT:-$DEFAULT_DESKTOP_WORKSPACE_ROOT}"

DRY_RUN=0
SYNC_OS=""
SYNC_ARCH=""
SIGN_MAC_BUILTINS="${SIGN_MAC_BUILTINS:-0}"
BUILD_ARCH=""

UPSTREAM_SERVICE_REPOS=(
  "agent-container-hub"
  "agent-webclient"
  "agent-platform"
  "identity-center"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/build-all-dist.sh [options]

Build the complete set of upstream builtin service release packages, then sync
only those release outputs into build/resources/services.

Options:
  --sync-os os     Sync only one target OS (darwin, windows, linux).
  --sync-arch arch Build upstream services for, and sync only, one target arch
                    (arm64, amd64). Defaults to the host arch for upstream builds.
  --sign-mac       Pre-sign extracted Darwin service binaries before packaging.
  --no-sign-mac    Disable Darwin service binary pre-signing.
  --dry-run        Print upstream and sync commands without running them.
  -h, --help       Show this help.

Environment:
  DESKTOP_WORKSPACE_ROOT
                   Override the parent directory containing the four service repos.
  SIGN_MAC_BUILTINS=1
                   Enable --sign-mac without putting signing details in git.
  DESKTOP_DARWIN_CODESIGN_IDENTITY / MACOS_CODESIGN_IDENTITY / CSC_NAME
                   Developer ID Application identity for --sign-mac. Final
                   release signing still happens in electron-builder.

Each upstream service owns its VERSION, target matrix, and all service-private
release inputs. Desktop invokes only: make release ARCH=<host-or-sync-arch>.

Examples:
  scripts/build-all-dist.sh --sync-os darwin --sync-arch arm64
  SIGN_MAC_BUILTINS=1 CSC_NAME="Your Name (TEAMID)" scripts/build-all-dist.sh --sync-os darwin --sync-arch arm64
  DESKTOP_WORKSPACE_ROOT=/Users/me/Project/desktop-workspace scripts/build-all-dist.sh --sync-os windows --sync-arch amd64
EOF
}

log() {
  printf '[build-all-dist] %s\n' "$*"
}

die() {
  printf '[build-all-dist] %s\n' "$*" >&2
  exit 1
}

normalize_bool() {
  local value="$1"
  local label="$2"
  case "$value" in
    1|true|TRUE|yes|YES|on|ON)
      printf '1\n'
      ;;
    0|false|FALSE|no|NO|off|OFF|"")
      printf '0\n'
      ;;
    *)
      die "$label must be a boolean value: $value"
      ;;
  esac
}

detect_host_os() {
  case "$(uname -s)" in
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
      die "unsupported host OS: $(uname -s)"
      ;;
  esac
}

detect_host_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      printf 'amd64\n'
      ;;
    arm64|aarch64)
      printf 'arm64\n'
      ;;
    *)
      die "unsupported host architecture: $(uname -m)"
      ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

run_cmd_in_dir() {
  local workdir="$1"
  shift

  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  (cd %q && ' "$workdir"
    printf '%q ' "$@"
    printf ')\n'
    return
  fi

  (cd "$workdir" && "$@")
}

normalize_sync_os() {
  case "$1" in
    darwin|macos)
      printf 'darwin\n'
      ;;
    windows|win32)
      printf 'windows\n'
      ;;
    linux)
      printf 'linux\n'
      ;;
    *)
      die "unsupported sync OS: $1"
      ;;
  esac
}

normalize_sync_arch() {
  case "$1" in
    amd64|x64)
      printf 'amd64\n'
      ;;
    arm64|aarch64)
      printf 'arm64\n'
      ;;
    *)
      die "unsupported sync arch: $1"
      ;;
  esac
}

should_sign_mac_builtins() {
  [[ "$SIGN_MAC_BUILTINS" == "1" && ( -z "$SYNC_OS" || "$SYNC_OS" == "darwin" ) ]]
}

build_project() {
  local repo_name="$1"
  local project_dir="$DESKTOP_WORKSPACE_ROOT/$repo_name"

  [[ -d "$project_dir" ]] || die "missing service project: $project_dir"
  [[ -f "$project_dir/Makefile" ]] || die "missing Makefile: $project_dir/Makefile"

  log "release $repo_name (ARCH=$BUILD_ARCH)"
  if [[ "$DRY_RUN" == "1" ]]; then
    printf '  (cd %q && unset VERSION PROGRAM_TARGETS PROGRAM_TARGET_MATRIX && make release ARCH=%q)\n' \
      "$project_dir" "$BUILD_ARCH"
    return
  fi

  (
    cd "$project_dir"
    unset VERSION PROGRAM_TARGETS PROGRAM_TARGET_MATRIX
    make release "ARCH=$BUILD_ARCH"
  )
}

assert_no_synced_darwin_archives() {
  local services_dir="$DESKTOP_ROOT/build/resources/services"
  local found=0

  [[ -d "$services_dir" ]] || return

  while IFS= read -r -d '' archive_path; do
    printf '[build-all-dist] unexpected Darwin archive after sync: %s\n' "$archive_path" >&2
    found=1
  done < <(find "$services_dir" -type f \( -name '*-darwin-*.tar.gz' -o -name '*-darwin-*.tgz' \) -print0)

  [[ "$found" == "0" ]] || die "Darwin builtin services must be synced as directories, not tar.gz archives."
}

sync_desktop_assets() {
  local sync_args=("./scripts/sync-builtin-assets.mjs")
  local repo_name

  for repo_name in "${UPSTREAM_SERVICE_REPOS[@]}"; do
    sync_args+=("--source=$DESKTOP_WORKSPACE_ROOT/$repo_name/dist/release")
  done
  if [[ -n "$SYNC_OS" ]]; then
    sync_args+=("--os=$SYNC_OS")
  fi
  if [[ -n "$SYNC_ARCH" ]]; then
    sync_args+=("--arch=$SYNC_ARCH")
  fi
  if should_sign_mac_builtins; then
    sync_args+=("--sign-darwin")
  fi

  log "sync current upstream release packages into $DESKTOP_ROOT/build/resources/services"
  run_cmd_in_dir "$DESKTOP_ROOT" node "${sync_args[@]}"
  if [[ "$DRY_RUN" != "1" && ( -z "$SYNC_OS" || "$SYNC_OS" == "darwin" ) ]]; then
    assert_no_synced_darwin_archives
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --sync-os)
      [[ $# -ge 2 ]] || die "--sync-os requires a value"
      SYNC_OS="$(normalize_sync_os "$2")"
      shift 2
      ;;
    --sync-arch)
      [[ $# -ge 2 ]] || die "--sync-arch requires a value"
      SYNC_ARCH="$(normalize_sync_arch "$2")"
      shift 2
      ;;
    --sign-mac)
      SIGN_MAC_BUILTINS=1
      shift
      ;;
    --no-sign-mac)
      SIGN_MAC_BUILTINS=0
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

SIGN_MAC_BUILTINS="$(normalize_bool "$SIGN_MAC_BUILTINS" "SIGN_MAC_BUILTINS")"
HOST_OS="$(detect_host_os)"
BUILD_ARCH="${SYNC_ARCH:-$(detect_host_arch)}"

require_command make
require_command node
if should_sign_mac_builtins; then
  [[ "$HOST_OS" == "macos" ]] || die "--sign-mac requires a macOS host when syncing Darwin assets"
  require_command codesign
  require_command security
  require_command tar
fi

[[ -d "$DESKTOP_WORKSPACE_ROOT" ]] || die "DESKTOP_WORKSPACE_ROOT does not exist: $DESKTOP_WORKSPACE_ROOT"
[[ -d "$DESKTOP_ROOT" ]] || die "Desktop root does not exist: $DESKTOP_ROOT"

log "host=$HOST_OS workspace=$DESKTOP_WORKSPACE_ROOT desktop=$DESKTOP_ROOT build-arch=$BUILD_ARCH"

for repo_name in "${UPSTREAM_SERVICE_REPOS[@]}"; do
  build_project "$repo_name"
done

sync_desktop_assets

log "all core service release packages were synced"
