ifeq ($(OS),Windows_NT)
HOST_PLATFORM := windows
else
UNAME_S := $(shell uname -s)
ifeq ($(UNAME_S),Darwin)
HOST_PLATFORM := macos
else
HOST_PLATFORM := unsupported
endif
endif

.PHONY: help icons sync-version build test release release-mac release-win release-win-docker clean-dist

help:
	@printf "ZenMind Desktop targets:\n"
	@printf "  make icons              Regenerate app and tray icons\n"
	@printf "  make sync-version       Sync package metadata from VERSION\n"
	@printf "  make build              Build Electron main and renderer bundles\n"
	@printf "  make test               Run the project test suite\n"
	@printf "  make release            Build a release package for the current host platform\n"
	@printf "  make release-mac        Build the macOS arm64 DMG package\n"
	@printf "  make release-win        Build the Windows x64 NSIS package on Windows\n"
	@printf "  make release-win-docker Build the Windows x64 NSIS package through Docker\n"
	@printf "  make clean-dist         Remove release output from dist/\n"

icons:
	npm run icons

sync-version:
	npm run sync:version

build:
	npm run build

test:
	npm test

release:
ifeq ($(HOST_PLATFORM),macos)
	$(MAKE) release-mac
else ifeq ($(HOST_PLATFORM),windows)
	$(MAKE) release-win
else
	@printf "Unsupported release host: %s\n" "$(UNAME_S)"
	@printf "Use 'make release-win-docker' for Windows packaging from this host.\n"
	@exit 1
endif

release-mac: icons
	npm run dist:mac

release-win: icons
	npm run dist:win

release-win-docker: icons
	npm run dist:win-docker

clean-dist:
	rm -rf dist
