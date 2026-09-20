'use strict';

/**
 * EVERYTHING IN THIS FILE IS PUBLIC. It ships inside the installer and anyone
 * can read it. Never put a client secret, token, webhook URL or API key here.
 * (Nothing in this project needs one.)
 */
module.exports = {
  appName: '777 Launcher',

  discord: {
    // Discord Developer Portal -> your application -> "Application ID".
    // This is a public identifier, not a secret.
    clientId: '1551310361809002536',

    // Must match a Redirect URI you add in the portal:
    //   http://127.0.0.1:53682/callback
    redirectPort: 53682,

    // Read-only basic profile (username + avatar). Do not add more scopes.
    scopes: ['identify'],
  },

  // true  = users must sign in with Discord before using the launcher.
  // false = sign-in is optional.
  requireLogin: true,

  // Public URL of your manifest.json (see README). Leave empty to preview the
  // launcher with the bundled manifest.sample.json.
  // Example:
  // 'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/777-launcher-content/main/manifest.json'
  manifestUrl: 'https://raw.githubusercontent.com/Jay-qb77x/777-launcher-content/main/manifest.json',

  // Downloads are only allowed from these hosts (and their subdomains).
  // GitHub Releases redirects to *.githubusercontent.com, so both are listed.
  allowedDownloadHosts: ['github.com', 'githubusercontent.com'],

  // Files with any other extension are rejected, so a bad manifest can never
  // push an .exe / .bat / .ps1 to your users through the launcher.
  allowedExtensions: [
    '.zip', '.7z', '.rar',
    '.png', '.jpg', '.jpeg', '.webp', '.dds', '.tga', '.psd',
    '.fbx', '.obj', '.glb', '.gltf', '.blend',
    '.json', '.txt', '.pdf',
  ],

  // Hard cap per download.
  maxDownloadBytes: 1024 * 1024 * 1024, // 1 GB
};
