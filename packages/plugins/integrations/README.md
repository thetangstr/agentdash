# AgentDash Integration Plugin Manifests

This directory contains plugin manifest files for AgentDash's third-party integration plugins. Each subdirectory represents a connector plugin that bridges AgentDash with an external service.

## Available Integrations

| Plugin | ID | Description |
|---|---|---|
| **Slack** | `igt.integration-slack` | Agent presence in Slack channels, escalation routing, approval notifications |
| **GitHub** | `igt.integration-github` | PR sync, CI status tracking, code review automation, bidirectional issue sync |
| **Linear** | `igt.integration-linear` | Bidirectional issue sync, status mapping, comment mirroring |

## Structure

Each integration directory contains:

- `manifest.json` -- Plugin manifest declaring identity, capabilities, webhooks, scheduled jobs, and instance configuration schema.

Full worker implementations (the plugin code that runs inside the Paperclip runtime) are coming in a future phase.

## Installing a Plugin

1. Copy the plugin directory into your Paperclip plugin registry or reference it from your project configuration.
2. In the AgentDash admin UI, navigate to **Settings > Plugins** and enable the integration.
3. Fill in the required instance configuration fields (API keys, webhook secrets, etc.). Secret values should be stored via the platform secret manager and referenced by secret ref strings.
4. Save the configuration. The host will validate the config against `instanceConfigSchema` and start the plugin worker.

## Capabilities

These plugins use the `sync.registerMapping`, `sync.getMapping`, and `sync.getMappingByPaperclipId` RPC methods (added to the Plugin SDK protocol in Phase 8) to maintain entity mappings between external services and AgentDash. The `measurements.record` RPC is available for plugins that need to push metric data.

## Development

To build a new integration plugin, create a new directory here with a `manifest.json` following the same pattern. The manifest schema is defined by `PaperclipPluginManifestV1` in `@paperclipai/shared`.
