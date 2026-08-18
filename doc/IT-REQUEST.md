# What to ask MKThink IT for

One visit, three things, all routine. They are listed in dependency order —
each makes the next one possible.

Everything below is about a Mac Mini already sitting in your server room,
currently at **10.50.10.129**, serving an internal web app on port 3112.
It is not exposed to the internet and does not need to be.

---

## The ask, in one paragraph

> We have an on-premise server on your network — a Mac Mini in the server room —
> running an internal web app for a small group at MKThink. To finish the setup
> we need three things: a **DHCP reservation** so its address stops moving, an
> **internal DNS A record** pointing a name at it, and a **TLS server
> certificate issued from your internal CA** for that name. We have the CSR
> ready; you never see our private key. Nothing needs to change on anyone's
> laptop, because your machines already trust your own CA.

---

## 1. DHCP reservation

**Why:** the lease is ~22 hours. When the address changes, the server stops
accepting requests on the new one until someone reconfigures it by hand — it
returns `403` and looks broken.

| | |
|---|---|
| MAC to reserve — wired `en0` | `1c:f6:4c:69:c6:9d` ← ask for this |
| MAC to reserve — Wi-Fi `en1` | `1c:f6:4c:68:d0:2d` (hardware address) |
| Current address | 10.50.10.129, on `en1` |
| Ask | reserve it, or assign a static |

**Do not give them `02:e3:44:1e:93:58`.** That is what `ifconfig en1` reports
today, but the `02:` prefix marks it as a macOS **private/randomised** Wi-Fi
address, not the hardware one — corrected 2026-08-18. A reservation bound to it
works until macOS rotates it, and then the address moves and the hostname guard
starts returning 403: the failure this whole section exists to prevent, arriving
weeks late and looking like nothing. If we stay on Wi-Fi, disable Private Wi-Fi
Address for that network first so the reservation binds to `1c:f6:4c:68:d0:2d`.

Ethernet has no randomisation at all, which is one more reason to prefer it for a
machine in a rack. `en0` had no cable attached as of 2026-08-18. A USB 2.5G LAN
adapter is also present (`en8`, `84:5c:31:47:29:8d`). Decide which interface it
lives on **before** they create the reservation, so it is done once.

## 2. Internal DNS A record

**Why:** without a name, the only way in is a raw IP that changes, and a
certificate cannot sensibly be issued for it.

Their resolver is at **10.30.65.2**.

| | |
|---|---|
| Proposed name | `agentdash.mkthink.com` |
| Points to | the reserved address above |
| Scope | internal only — this must not resolve publicly |

`mkthink.com` is externally hosted (185.230.63.x), so this is a split-horizon
record: the name resolves to a private address inside the network and does not
exist outside it.

**Split-horizon is already in place** — verified 2026-08-18: that resolver is
`mk-wpa-dc01.mkthink.net`, a Windows DC, and it answers **authoritatively** for
`mkthink.com` (`aa` flag, SOA `mk-wpa-dc01.mkthink.net hostmaster.mkthink.net`)
as well as for their internal AD zone `mkthink.net`. So we are asking for one
more record in a zone they already maintain, not a new zone. `agentdash.mkthink.com`
does not resolve today, internally or publicly.

Because the internal AD zone is `mkthink.net`, offer **`agentdash.mkthink.net`**
as an equally good alternative — some teams keep the internal `.com` zone as a
strict mirror of public records. Any name works; we reissue the CSR in one
command, so offering both up front avoids a round-trip.

## 3. TLS certificate from MKThink's internal CA

**Why this and not our own certificate.** Today the server uses a self-issued
(mkcert) certificate, so every browser shows a warning. That warning cannot be
dismissed permanently by a normal user on an MDM-managed Mac — Apple removed
silent CLI trust, so adding a root prompts for admin credentials no matter how
the file arrives. The realistic options are:

| option | each person does | what it costs IT |
|---|---|---|
| **A. Issue a cert from MKThink's CA** ← preferred | nothing | sign one CSR |
| **B. Push our root CA via MDM profile** | nothing | build + push a profile, and trust an external root |
| **C. Leave it** | click through a warning every time | nothing, and it teaches four people to ignore certificate warnings |

**A is less work than B and asks them to trust nothing new.**

### The CSR

Already generated, sitting on the machine:

```
~/.config/agentdash/tls/agentdash.mkthink.com.csr
```

```
Subject : CN=agentdash.mkthink.com, O=MKThink, OU=AgentDash
SANs    : DNS:agentdash.mkthink.com, IP:10.50.10.129
Key     : RSA 2048
EKU     : serverAuth
```

Worth saying when you hand it over, because it is always the first question:
**a CSR contains no private key.** The key was generated on the server, has mode
600, and never leaves it.

Their resolver is a Windows domain controller, so they are very likely running AD
Certificate Services. Name the **Web Server** template explicitly when you ask —
it turns a vague "issue us a certificate" into a two-minute task for a Windows
admin. Ask for the issuing chain alongside the certificate.

If they want a different name, regenerate in one command:

```bash
./deploy/make-csr.sh <their-name> 10.50.10.129
```

### When the signed certificate comes back

```bash
# Save as ~/.config/agentdash/tls/<fqdn>.crt
# If they send a chain too, append it AFTER the server cert in the same file.
# Then point Caddy at the pair, reload, and verify with a real client:
curl -sS -o /dev/null -w '%{http_code}\n' https://<fqdn>:3112/api/health
```

A `200` **without** `-k` or `--cacert` is the whole test. It means the system
trust store accepted it — exactly what every laptop will do.

---

## Until then

The app is reachable over plain HTTP at `http://mkmini.local:3102`, which is
what the sign-in email tells people to use. It works and shows no warnings, but
session cookies travel in clear on the internal LAN — so it is a stopgap, not
the end state, and it is the reason this request is worth making today rather
than next month.

## Not part of this request

Tailscale is installed and working for remote support. It does not need
anything from IT, and it is not how MKThink staff reach the app — they use the
internal address above.
