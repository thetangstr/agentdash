# The message to send MKThink IT

Paste-ready. Attach `~/.config/agentdash/tls/agentdash.mkthink.com.csr`.

Everything below was verified against their network from the Mini on
2026-08-18 — see "What we already know about their setup" at the bottom for
what was probed and why it shapes the ask.

---

**Subject:** Mac Mini in the server room — DHCP reservation, one DNS record, one TLS cert

Hi <name>,

We have an on-premise server on your network — a Mac Mini in the server room,
currently at **10.50.10.129** — running an internal web app for a small group at
MKThink. It's finished and working; what's left is three pieces of network
housekeeping that only you can do. They're listed in dependency order, and none
of them require anything to change on anybody's laptop.

The machine is not exposed to the internet and doesn't need to be. No perimeter
firewall changes, no inbound NAT, no public DNS.

## 1. A network home and a fixed address

Right now it's on Wi-Fi with a DHCP lease of about 22 hours. When the address
moves, the app stops answering on the new one until we reconfigure it by hand —
it returns `403` and looks broken when it's actually healthy.

**Preferred:** a wired Ethernet port on an internal VLAN (not guest — guest
SSIDs usually isolate clients from each other, which would stop staff reaching
it at all), plus a DHCP reservation or static assignment.

| interface | MAC | note |
|---|---|---|
| `en0` — built-in Ethernet | `1c:f6:4c:69:c6:9d` | **use this one** if you can give us a wired port |
| `en1` — Wi-Fi | `1c:f6:4c:68:d0:2d` | hardware address; fallback if wired isn't possible |

One warning worth flagging so the reservation doesn't quietly fail: macOS
currently presents a **randomised** Wi-Fi address on your network
(`02:e3:44:1e:93:58`) rather than the hardware one. If we end up on Wi-Fi we'll
turn that off so the reservation binds to `1c:f6:4c:68:d0:2d` and stays bound.
Please don't reserve against the `02:…` address — it rotates.

Access needed from three laptops (Titus, Sam, Megan) on TCP **3102, 3112**.

## 2. One internal DNS A record

Without a name there's no way in except a raw IP that moves, and a certificate
can't sensibly be issued for one.

| | |
|---|---|
| Name | `agentdash.mkthink.com` |
| Points to | the reserved address from (1) |
| Scope | internal only — must not resolve publicly |

I can see your DC (`mk-wpa-dc01`, 10.30.65.2) already serves an authoritative
internal `mkthink.com` zone alongside `mkthink.net`, so this should be a single
record in a zone you already maintain.

If you'd rather keep the internal `.com` zone as a clean mirror of your public
records, **`agentdash.mkthink.net` works just as well** — or any name you
prefer. Just tell us which and we'll reissue the request in (3); it's one
command on our side.

**One thing that matters more than it looks: the record has to resolve for VPN
users too.** Our main user works over FortiClient from outside the office. We
have already confirmed that **routing over the VPN works** — he can reach the
server at its raw IP from the VPN today. The only thing missing is the name:
`mkmini.local` is an mDNS name, which is link-local by design and cannot cross a
tunnel, so it dies the moment the VPN comes up. If VPN clients are handed
10.30.65.2 as their resolver, this record fixes that outright and nothing else is
needed. If they're handed a different resolver, or the split-tunnel config
excludes 10.50.10.0/24 from DNS, please let us know — that's the one detail that
would change the answer.

## 3. A TLS server certificate from your internal CA

Today the server uses a self-issued certificate, so every browser shows a
warning. We can't fix that from our end in a way that works on your fleet: on a
managed Mac, a non-admin user can't add a trusted root at all — Apple removed
silent CLI trust, so the keychain prompts for admin credentials no matter how
the file arrives.

The clean answer is a certificate signed by your own CA, because your machines
already trust it and nothing new gets trusted anywhere.

**The CSR is attached.** A CSR contains no private key — the key was generated
on the server, is mode 600, and never leaves it.

```
Subject : CN=agentdash.mkthink.com, O=MKThink, OU=AgentDash
SANs    : DNS:agentdash.mkthink.com, IP:10.50.10.129
Key     : RSA 2048 (deliberately, not EC — some CAs still reject EC CSRs)
Usage   : Digital Signature, Key Encipherment / serverAuth
```

If you're issuing from AD Certificate Services, the **Web Server** template is
what we need. Please send back the signed certificate plus your issuing chain.
Standard validity is fine; we have a renewal reminder either way.

Note the CSR pins **10.50.10.129** in the SAN. If the reservation in (1) lands
on a different address, send us the address and we'll reissue — again, one
command.

**If you'd rather not issue a certificate,** the alternative is pushing our own
root CA to those three laptops as a trusted-root configuration profile. It's a
public certificate, no private key. We're suggesting the certificate instead
because a trusted root can sign for *any* hostname and yours can't — it's less
for you to approve and less for you to carry.

Happy to do any of this alongside whoever picks it up, or to answer questions
first — whichever is less work for you.

Thanks,
Yang

---

## What we already know about their setup

Probed from the Mini on 2026-08-18, so the request doesn't ask for things that
already exist or propose things that can't work:

- **Resolver 10.30.65.2 is `mk-wpa-dc01.mkthink.net`** — a Windows domain
  controller, so DNS is AD-integrated and there is very likely an AD Certificate
  Services CA behind it. That's why the request names the **Web Server**
  template: it turns "issue us a cert" into a two-minute task for a Windows
  admin rather than an open question.
- **`mkthink.com` is already served authoritatively from that DC internally**
  (`aa` flag set, SOA `mk-wpa-dc01.mkthink.net hostmaster.mkthink.net`) while
  resolving publicly to 185.230.63.x. Split-horizon is already in place — we're
  asking for one more record in an existing zone, not a new zone.
- **`agentdash.mkthink.com` does not resolve today**, internally or publicly.
- **Their internal AD zone is `mkthink.net`**, which is why the message offers
  `agentdash.mkthink.net` as the alternative. Some teams keep the internal
  `.com` zone as a strict mirror of public records; offering both avoids a
  round-trip.
- **The Wi-Fi MAC in use is `02:e3:44:1e:93:58`, a macOS private/randomised
  address.** The hardware address is `1c:f6:4c:68:d0:2d`. A reservation against
  the randomised one works until macOS rotates it, which is exactly the kind of
  failure that arrives weeks later looking like nothing. Ethernet (`en0`,
  `1c:f6:4c:69:c6:9d`) has no randomisation at all — one more reason to prefer
  the wired port. `en0` has no cable attached as of 2026-08-18, so bring one.
- **A USB 2.5G LAN adapter is also present** (`en8`, `84:5c:31:47:29:8d`) if the
  built-in port is inconvenient. Re-checked 2026-08-31: `en8` is not attached
  today, and `en0` still has no cable.
- **Re-verified 2026-08-31, all still true:** address 10.50.10.129, lease 80000 s
  (22.2 h), Wi-Fi still presenting the randomised `02:e3:44:1e:93:58`,
  `agentdash.mkthink.com` still absent from the DC, and the DC still
  authoritative for `mkthink.com`. The CSR on disk matches the subject and SANs
  quoted above.
- **New on 2026-08-31 — the VPN is now the live problem, not a future one.** A
  VPN-pool client (10.212.134.x) reached the server on 2026-08-26 using
  `mkmini.local`, then stopped working. That was a cached mDNS record, TTL
  4500 s (~75 min), carried in from the office and expiring afterwards. So the
  current setup does not fail cleanly — it works for about an hour after someone
  leaves the office and then stops, which reads as flakiness rather than as a
  missing DNS record. This is the strongest argument for making the ask now.

## Before you send

- [ ] Fill in the recipient's name, and drop `<name>`.
- [ ] Attach `~/.config/agentdash/tls/agentdash.mkthink.com.csr`.
- [ ] Decide wired vs Wi-Fi if you have a view — the message asks for wired and
      gives Wi-Fi as fallback, which is safe to send as-is.

See [IT-REQUEST.md](IT-REQUEST.md) for the longer internal reasoning, and
[SOP-onsite.md](SOP-onsite.md) for what to run when the certificate comes back.
