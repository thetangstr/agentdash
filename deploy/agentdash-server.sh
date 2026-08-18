#!/bin/zsh
# The server, started the way launchd needs it: non-interactively.
#
# Deliberately NOT `paperclipai run`. That command is built for a human at a
# terminal — it uses @clack/prompts and can stop to ask a question, which under
# launchd means a process that never becomes healthy and never says why. This
# is the same invocation that has been verified by hand on this stack.
#
# Env comes from one file so there is exactly one place to change a secret,
# a port, or a license key. INSTANCE selects which one.
set -eu

INSTANCE="${AGENTDASH_INSTANCE:-mkboard}"
ENV_FILE="${AGENTDASH_ENV_FILE:-$HOME/.config/agentdash/${INSTANCE}.env}"
APP_DIR="${AGENTDASH_APP_DIR:-$HOME/agentdash}"

# Homebrew node is not on launchd's PATH; launchd starts with a minimal one.
#
# `$HOME/.local/bin` is listed explicitly because that is where `hermes` lives,
# and hermes is what every agent run actually executes.
#
# It already worked without this line, and the reason is worth writing down so
# nobody "cleans up" the redundancy: `~/.zshenv` also exports it, and zsh
# sources .zshenv on EVERY invocation -- including a non-interactive script run
# by launchd. So the dependency was real but invisible, resting on one line in
# a personal dotfile that any tidy-up would take with it. Naming it here makes
# the wrapper self-contained; it is belt-and-braces, not a bug fix.
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

if [ ! -f "$ENV_FILE" ]; then
  echo "agentdash: no env file at $ENV_FILE" >&2
  exit 78            # EX_CONFIG — a wrong config, not a crash to retry forever
fi

cd "$APP_DIR/server"
set -a
. "$ENV_FILE"
set +a

echo "agentdash: starting instance=${PAPERCLIP_INSTANCE_ID:-$INSTANCE} port=${PORT:-3000}"
exec pnpm exec tsx src/index.ts
