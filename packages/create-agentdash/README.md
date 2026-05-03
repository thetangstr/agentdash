# create-agentdash

Bootstrap [AgentDash](https://github.com/thetangstr/agentdash) on your machine in one command.

```sh
npx create-agentdash
```

Defaults to `~/agentdash`. Pass a custom path:

```sh
npx create-agentdash /path/to/your/workspace
```

## What it does

1. Pre-flight checks (Node ≥ 20, git, pnpm)
2. `git clone` the public AgentDash repo
3. `pnpm install` (workspace deps)
4. `pnpm install-cli` (symlinks `agentdash` into `/usr/local/bin`, `/opt/homebrew/bin`, or `~/.local/bin`)
5. Tells you to run `agentdash setup` — a 2-prompt wizard (pick adapter + your email)

## Prerequisites

- Node 20+ — install via [nodejs.org](https://nodejs.org), nvm, fnm, or asdf
- pnpm — `npm install -g pnpm` or `corepack enable && corepack prepare pnpm@latest --activate`
- git — usually already installed; otherwise `brew install git` / `apt install git`

## After it runs

```sh
agentdash setup       # configure adapter + founding user email
cd ~/agentdash
pnpm dev              # start the server
# open http://localhost:3100/cos
```

If `agentdash` isn't on your PATH yet, the install step prints the exact `export PATH=…` line you need to add to your shell rc.

## License

MIT — same as AgentDash. See the [main repo](https://github.com/thetangstr/agentdash).
