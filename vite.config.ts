import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs, so the build works from a project page subpath
  // (github.io/runhack/) as well as from a domain root.
  base: './',
  // `host: true` exposes the dev server on the LAN so a phone on the same
  // Wi-Fi can play it; GPS mode still needs HTTPS or localhost.
  server: { host: true },
  preview: { host: true },
});
