#!/usr/bin/env bash
# vibecosting — zero-prereq installer.
#
#   curl -fsSL https://raw.githubusercontent.com/ahmedmango/vibecosting/main/install.sh | bash
#
# Detects Bun, installs it if missing, then runs `bunx github:ahmedmango/vibecosting`
# with any args you pass. Reads ~/.claude/projects locally — no network beyond
# the bun fetch + vibecosting fetch from GitHub.

set -e

REPO="ahmedmango/vibecosting"
GITHUB="github:${REPO}"

c_dim()   { printf '\033[2m%s\033[0m' "$*"; }
c_bold()  { printf '\033[1m%s\033[0m' "$*"; }
c_green() { printf '\033[32m%s\033[0m' "$*"; }
c_yellow(){ printf '\033[33m%s\033[0m' "$*"; }
c_red()   { printf '\033[31m%s\033[0m' "$*"; }

# ── Check OS ──────────────────────────────────────────────────────────────
case "$(uname -s)" in
  Darwin*|Linux*) ;;
  *)
    c_red "vibecosting: this installer only supports macOS and Linux."
    echo
    echo "Windows users: install Bun manually (https://bun.sh), then run"
    echo "  bunx github:${REPO}"
    exit 1
    ;;
esac

# ── Install Bun if missing ────────────────────────────────────────────────
if ! command -v bun >/dev/null 2>&1; then
  c_yellow "Bun not found. Installing Bun first…"; echo
  curl -fsSL https://bun.sh/install | bash
  # Make the freshly-installed bun visible to this shell
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if ! command -v bun >/dev/null 2>&1; then
    c_red "vibecosting: Bun install finished but \`bun\` still isn't on PATH."; echo
    echo "Open a new terminal (so PATH refreshes) and re-run this installer,"
    echo "or just run:  bunx ${GITHUB}"
    exit 1
  fi
  echo
  c_green "Bun installed."; echo
fi

# ── Run vibecosting ───────────────────────────────────────────────────────
echo
c_bold "▶ bunx ${GITHUB} $*"; echo
echo
exec bunx "${GITHUB}" "$@"
