const { getDefaultConfig } = require('expo/metro-config');

// This package lives inside a pnpm workspace (see repo-root pnpm-workspace.yaml).
// pnpm installs every dependency — including this package's own, non-workspace
// npm packages — as a symlink into a shared content-addressable store
// (node_modules/.pnpm/*), not as a flat copy. Metro's default resolver does not
// follow symlinks, so without this it fails to resolve `expo`, `react-native`,
// etc. from mobile/node_modules the moment pnpm's install layout differs from
// npm/yarn's classic hoisted node_modules. `unstable_enableSymlinks` is the
// documented fix (Expo's own pnpm-monorepo guide) and is safe to enable even
// where it isn't strictly needed.
const config = getDefaultConfig(__dirname);

config.resolver.unstable_enableSymlinks = true;
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
