# Skills

Skills are auto-activated contextual knowledge that agents load when working in specific domains.

## Adding a Skill

Create a directory under `.claude/skills/` with a `skill.md` file:

```
.claude/skills/
+-- my-skill/
    +-- skill.md
```

## Example Skill Structure

See the pm-requirements example in the commands/pm.md for how PM requirements elaboration works as an integrated capability.

## Common Skills to Add

| Skill | Purpose | When to Add |
|-------|---------|-------------|
| `pm-requirements` | Requirements elaboration framework | Always |
| `pre-ship-validator` | Security/migration checks before PR | For security-sensitive projects |
| `pricing-promo` | Pricing/promo changes across stack | For SaaS with payments |
| `e2e-testing` | E2E test patterns and fixtures | For projects with Playwright |
