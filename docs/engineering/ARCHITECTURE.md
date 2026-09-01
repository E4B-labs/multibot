# Desktop architecture

This document records the current boundaries. Changes should fit these boundaries or explain why a boundary must move.

## Application layers

- `src/` is the React/Vite renderer UI. It communicates with the desktop shell through the exposed preload API and existing application services.
- `electron/` is the Electron main process, preload bridge, updater integration, and packaging/runtime boundary. Treat IPC, filesystem access, process spawning, and update logic as security-sensitive.
- `server/` contains the Node-side local harness and supporting server behavior used by the desktop application.
- `engine/` is the optional Python engine boundary. Changes here can affect host execution, authentication, process lifecycle, and cross-platform behavior.
- `packages/webui-core/` contains shared TypeScript WebView/UI code used where the desktop and mobile clients intentionally share behavior. Keep platform-specific behavior at the client boundary.
- `scripts/` contains build, release, validation, and repository automation. Prefer existing scripts over new one-off commands.
- `electron-builder.yml`, package manifests, and lockfiles define packaging and dependency inputs.

## Data and security boundaries

Host credentials, authentication tokens, IPC messages, remote host connections, local engine access, and updater URLs are trust boundaries. Validate inputs at those boundaries, avoid logging secrets, and preserve the existing loopback/authentication protections.

Renderer code must not gain unrestricted filesystem or process access. Main-process or engine changes require tests that cover the affected boundary.

## Build and release boundaries

The renderer is bundled by Vite; Electron packaging produces platform artifacts. Generated output and build directories are not hand-edited or committed unless the repository already treats them as source. Release publication is a separate maintainer operation to `E4B-labs/multibot-desktop-releases`; do not create production releases from an ordinary feature PR.
