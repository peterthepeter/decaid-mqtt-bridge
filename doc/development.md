# Development

## Build and test

```sh
npm install
npm run build
npm test
npm run test:integ
npm run check
```

`npm run build` bundles `src/` and MQTT.js into
`mqtt.reaplugin/plugin.js`. The built file is committed so Decaid can install
the plugin directly from a branch. CI verifies that the committed bundle is up
to date and repackages it for releases.

## Integration tests

`npm run test:integ` runs the built plugin bundle inside a sandboxed VM that
mirrors the Decaid plugin runtime. It provides `host.transport` over real TCP
sockets, host-owned `fetch`, asynchronous storage events, permission gating,
and transport limits.

The plugin is tested against a purpose-built in-process MQTT broker and a
simulated Decaid REST and WebSocket API on ephemeral loopback ports. No external
broker, machine, or Decaid installation is required.

The suite covers:

- MQTT 5 connection and MQTT 3.1.1 fallback
- Client ID, keepalive, authentication, subscriptions, QoS 1, and last will
- State format and publish triggers
- Activity-aware heartbeat cadence
- Live shot weight and completed-shot records
- Water levels and profile selection
- Supported, unknown, and invalid commands
- Broker outage, restart, reconnect, and abnormal client termination
- Plugin unload and resource cleanup

On-device TLS using the platform trust store is not covered by the integration
harness. Unit and integration tests otherwise exercise the shipping bundle.

## Release process

Before publishing a plugin update:

1. Update the version consistently in `package.json`, `package-lock.json`,
   `mqtt.reaplugin/manifest.json`, `src/discovery.js`, `README.md`, and
   `CHANGELOG.md`.
2. Run `npm test`, `npm run build`, `npm run check`, and the integration tests.
3. Commit the source, documentation, built bundle, and version change together.
4. Push `main` once.
5. Create and push an annotated `vX.Y.Z` tag matching the manifest version.

The version tag runs validation and creates the release archive and GitHub
release.

## Alternative installation methods

The GitHub release method in the main README is recommended for normal use.

### Install from a branch

```http
POST http://<tablet>:8080/api/v1/plugins/install/github-branch
```

```json
{"repo": "peterthepeter/decaid-mqtt-bridge"}
```

### Install a local build

Run `npm run build`, zip the `mqtt.reaplugin/` directory, and install the ZIP
from Decaid's plugin settings screen. Alternatively, copy the directory into
the app's plugin folder in a development environment.
