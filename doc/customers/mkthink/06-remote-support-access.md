# Remote Support Access — SSH to Customer Mac Mini

How to remotely access a customer's AgentDash Mac mini for support and troubleshooting.

---

## Recommended: Tailscale (Zero-Config VPN)

Tailscale is the simplest, most secure way to SSH into a customer's Mac mini without exposing it to the internet.

### On-Site Setup (During Install)

**On the customer's Mac mini:**

```sh
# Install Tailscale
brew install tailscale
sudo tailscale up

# Note the Tailscale IP
tailscale ip -4
# → 100.x.x.x
```

**On your laptop (Eddy):**

```sh
# Already on Tailscale? Just SSH in:
ssh <customer-username>@<tailscale-ip>
```

### Why Tailscale

- No port forwarding, no firewall changes
- End-to-end encrypted (WireGuard)
- Customer doesn't need to expose anything to the internet
- You can access from anywhere
- Free for personal use (up to 100 devices)
- Works behind NAT, corporate firewalls, etc.

### What to Tell the Customer

> "We're installing Tailscale, a secure VPN. It lets us remotely support your system if something breaks. It doesn't expose your Mac mini to the internet — it creates a private, encrypted tunnel between our machine and yours. You can revoke access anytime."

---

## Alternative: SSH + Reverse Tunnel

If Tailscale isn't an option, use a reverse SSH tunnel through a public relay.

### On-Site Setup

**On the customer's Mac mini:**

```sh
# Enable Remote Login
sudo systemsetup -setremotelogin on

# Set up a reverse tunnel to your relay server
# (requires a public server you control, e.g., agentdash.cloud)
autossh -M 0 -f -N \
  -o "ServerAliveInterval 30" \
  -o "ServerAliveCountMax 3" \
  -R 2222:localhost:22 \
  support@agentdash.cloud
```

**On your laptop:**

```sh
# SSH through the relay
ssh -p 2222 <customer-username>@agentdash.cloud
```

**Install as a persistent service:**

```sh
cat > ~/Library/LaunchAgents/com.agentdash.support-tunnel.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.agentdash.support-tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/autossh</string>
        <string>-M</string>
        <string>0</string>
        <string>-N</string>
        <string>-o</string>
        <string>ServerAliveInterval=30</string>
        <string>-o</string>
        <string>ServerAliveCountMax=3</string>
        <string>-R</string>
        <string>2222:localhost:22</string>
        <string>support@agentdash.cloud</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
</dict>
</plist>
EOF

launchctl load ~/Library/LaunchAgents/com.agentdash.support-tunnel.plist
```

---

## SSH Key Setup (Do This On-Site)

**Generate a support key:**

```sh
# On your laptop
ssh-keygen -t ed25519 -f ~/.ssh/agentdash-support -C "agentdash-support"
```

**Copy to the customer's Mac mini (while on-site):**

```sh
ssh-copy-id -i ~/.ssh/agentdash-support.pub <customer-username>@<mac-mini-ip>
```

**Test:**

```sh
ssh -i ~/.ssh/agentdash-support <customer-username>@<tailscale-ip>
```

---

## What You Can Do Over SSH

Once connected:

```sh
# Check AgentDash health
curl -fsS http://127.0.0.1:3100/api/health

# Restart AgentDash
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Check logs
tail -50 ~/.agentdash/logs/agentdash.log
tail -50 ~/.agentdash/logs/agentdash.err

# Update AgentDash
cd ~/agentdash && git pull --ff-only && pnpm install && pnpm build
launchctl kickstart -k gui/$(id -u)/ai.agentdash.agent

# Check agent runs
curl -s http://127.0.0.1:3100/api/companies/:companyId/dashboard

# Fix common issues
sudo pmset -a sleep 0          # prevent sleep
hermes -p ceo gateway restart  # restart iMessage agent
```

---

## Security Notes

1. **Never share the customer's SSH credentials** — use key-based auth only
2. **Document when you access** — note it in the customer's GitHub issue
3. **Only access for support** — don't browse files unrelated to the issue
4. **The customer can revoke access** — they just remove your key from `~/.ssh/authorized_keys` or turn off Tailscale
5. **Use a dedicated support key** — not your personal SSH key

---

## Quick Reference for Monday

During the MKThink install, do these 3 things for remote access:

```sh
# 1. Install Tailscale
brew install tailscale
sudo tailscale up

# 2. Enable SSH
sudo systemsetup -setremotelogin on

# 3. Add Eddy's key (from your laptop, while on-site)
ssh-copy-id <mkthink-username>@<mac-mini-lan-ip>
```

Then you can SSH in from anywhere via the Tailscale IP. No port forwarding, no firewall changes, no internet exposure.
