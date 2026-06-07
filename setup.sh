#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

need_command() {
	if ! command -v "$1" >/dev/null 2>&1; then
		echo "error: missing required command: $1" >&2
		exit 1
	fi
}

need_command git
need_command node
need_command npm
need_command cmake

case "$(uname -s)" in
	Darwin)
		platform="macOS"
		;;
	Linux)
		platform="Linux"
		if ! command -v glslc >/dev/null 2>&1; then
			echo "error: missing glslc; install Vulkan shader tools (for example: glslc/shaderc)." >&2
			exit 1
		fi
		;;
	MINGW*|MSYS*|CYGWIN*)
		platform="Windows"
		if ! command -v glslc >/dev/null 2>&1; then
			echo "error: missing glslc; install the Vulkan SDK and ensure glslc is on PATH." >&2
			exit 1
		fi
		;;
	*)
		echo "error: unsupported platform: $(uname -s)" >&2
		exit 1
		;;
esac

echo "==> Platform: ${platform}"
echo "==> Installing npm dependencies"
npm ci --ignore-scripts

echo "==> Initializing submodules"
git submodule update --init --recursive

echo "==> Building native dependencies"
npm run build:native

echo "==> Setup complete"
