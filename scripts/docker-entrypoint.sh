#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Adjust the node user's UID/GID if they differ from the runtime request.

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
fi

# AgentDash (#721): a platform Volume can arrive root-owned (Railway mounts
# them that way), and a root-run `docker exec` can leave root-owned files
# under a node-owned root. The server and Hermes run as node and keep all
# state under /paperclip, so every entry not owned by node is handed to node.
# -xdev stays on the Volume's filesystem; -h changes a symlink itself and never
# follows it out of /paperclip. When the UID/GID was remapped above, every
# entry carries the old owner and is caught by the same test.
find /paperclip -xdev \( ! -user node -o ! -group node \) -exec chown -h node:node {} +

exec gosu node "$@"
