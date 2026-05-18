#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}
ENV_FILE=${PAPERCLIP_ENV_FILE:-/paperclip/agentdash.env}

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

generate_secret() {
    node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))'
}

read_env_file_value() {
    key="$1"
    if [ ! -f "$ENV_FILE" ]; then
        return 0
    fi
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2-
}

ensure_secret_env_var() {
    key="$1"
    current_value="$(printenv "$key" 2>/dev/null || true)"
    if [ -n "$current_value" ]; then
        return 0
    fi

    file_value="$(read_env_file_value "$key")"
    if [ -n "$file_value" ]; then
        export "${key}=${file_value}"
        return 0
    fi

    generated_value="$(generate_secret)"
    mkdir -p "$(dirname "$ENV_FILE")"
    touch "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    printf '%s=%s\n' "$key" "$generated_value" >> "$ENV_FILE"
    chown node:node "$ENV_FILE" >/dev/null 2>&1 || true
    export "${key}=${generated_value}"
    echo "Generated $key in $ENV_FILE"
}

ensure_secret_env_var "BETTER_AUTH_SECRET"
ensure_secret_env_var "PAPERCLIP_AGENT_JWT_SECRET"

exec gosu node "$@"
