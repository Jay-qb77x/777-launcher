# 777 Launcher

An Electron launcher with Discord sign-in, an Extras store, news, updates and tutorials.
Anyone can install it, and there is **no secret, server or database on your side to get hacked, leaked or billed**.

## How it works

```
User's PC                              Public internet (free)
─────────────────────                  ─────────────────────────────
777 Launcher  ── sign in (PKCE) ─────► Discord  (identify scope only)
     │
     ├── reads manifest.json ────────► GitHub repo   (news, updates, extras list)
     ├── downloads files ────────────► GitHub Releases (zips, verified by SHA-256)
     └── updates itself ─────────────► GitHub Releases (installer)
```

You publish content by editing one JSON file and uploading files to GitHub. There is no backend.

## What keeps you safe

| Risk | How it's handled |
| --- | --- |
| Leaked Discord client secret | No secret exists. Login uses OAuth2 **PKCE** as a Discord *Public Client*. |
| Users' Discord data | Only the `identify` scope. The token is used once, revoked, and discarded. Only username, ID and avatar URL are saved on the user's PC. |
| A hacked repo pushing malware | Downloads must match a SHA-256 in the manifest, come from allow-listed hosts only, and use allow-listed file types (no `.exe`, `.bat`, `.ps1`). The launcher never runs downloaded files. |
| Malicious web content in the app | `contextIsolation`, `sandbox`, no Node in the page, a strict Content-Security-Policy (`connect-src 'none'`), and the page can only call a handful of functions in `preload.js`. |
| Path tricks | Item IDs and file names are validated; files can only be written to `<userData>/extras/<id>/`. |
| Hosting bills | GitHub Releases and raw files are free. No servers to pay for. |
| Bad actors | Add their Discord user ID to `blockedUserIds` in `manifest.json`. |
| Server outage | The last manifest is cached, so the launcher still opens offline. |

## Setup (about 20 minutes)

### 1. Create the Discord application

1. Go to <https://discord.com/developers/applications> and click **New Application**.
2. Open **OAuth2**.
3. Copy the **Client ID** (also called Application ID). It is public and safe to put in the app.
4. **Do not copy or use the Client Secret.** This project doesn't need it. If you ever pasted it somewhere (including an old `.env`), click **Reset Secret** so the old one is dead.
5. Switch **Public Client** to **on**.
6. Under **Redirects**, add exactly: `http://127.0.0.1:53682/callback`
7. Don't add a bot. Nothing else is needed.

Open `config.js` and paste the Client ID into `discord.clientId`.

### 2. Try it locally

```bash
npm install
npm start
```

With `manifestUrl` empty, the launcher shows sample content so you can see the UI. Sign in with Discord to test the login.

### 3. Create the content repo

1. On GitHub, create a **public** repo called `777-launcher-content`.
2. Add `manifest.json` (copy `manifest.sample.json` from this project) and, optionally, a `thumbs/` folder with preview images.
3. Create a **Release** with the tag `files` and attach your zips (Rubber Bands Pack, Glass Colors, and so on).
4. For each file, run:
   ```bash
   npm run hash -- path/to/rubber-bands-pack.zip
   ```
   and paste the `size` and `sha256` into its entry in `manifest.json`.
5. Set each extra's `url` to
   `https://github.com/YOUR_GITHUB_USERNAME/777-launcher-content/releases/download/files/<fileName>`
6. Put the raw manifest URL in `config.js`:
   ```js
   manifestUrl: 'https://raw.githubusercontent.com/YOUR_GITHUB_USERNAME/777-launcher-content/main/manifest.json',
   ```

To add a new extra later: upload the file to the `files` release, run the hash command, add an entry to `manifest.json`, commit. Users see it the next time they open the launcher, with no new launcher version.

### 4. Release the launcher

1. In `package.json`, set `author`, `build.appId` and `build.publish.owner` (your GitHub username). The app repo should be named `777-launcher`.
2. Push this project to a public GitHub repo named `777-launcher`.
3. Tag a release:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
   GitHub Actions builds `777 Launcher Setup 1.0.0.exe` and attaches it to the Release. Share that link.
4. For later versions, bump `version` in `package.json`, then tag `v1.0.1` and so on. Installed launchers update themselves.

## Good to know

- **Windows SmartScreen.** Unsigned installers show "Windows protected your PC" (More info → Run anyway). It's normal for new indie apps. A code-signing certificate removes it later (SignPath is free for open-source projects; Azure Trusted Signing is another option).
- **Sign-in is identification, not a lock.** Files on public GitHub URLs can be downloaded by anyone who has the link. That's fine for free assets. If you ever sell or gate files, you'd need a small backend that checks the Discord account before handing out links.
- **Only redistribute assets you have the right to share.** That's the one risk code can't remove.
- **Privacy.** The launcher sends nothing to you. It talks only to Discord (sign-in) and GitHub (content and updates). Saved on the user's PC: Discord username/ID/avatar URL, the list of installed extras, and downloaded files.
- Run `npm update` now and then to keep Electron current for security fixes.

## Project layout

```
main.js            app window, IPC, auto-update
preload.js         the only bridge between the page and the main process
config.js          public settings (no secrets)
lib/auth.js        Discord PKCE sign-in
lib/content.js     manifest download + strict validation
lib/downloads.js   verified downloads
renderer/          the UI (index.html, styles.css, app.js)
manifest.sample.json   template for your content repo
tools/hash.js      prints size + sha256 for a file
.github/workflows/release.yml   builds and publishes the installer
```

## manifest.json fields

- `announcement`: `{ "text": "...", "level": "info" | "warn" }` or `null`
- `blockedUserIds`: array of Discord user ID strings
- `news`: `{ id, title, body, date }` (date as `YYYY-MM-DD`)
- `updates`: `{ version, title, date, notes[] }`
- `tutorials`: `{ id, title, description, duration, thumbnail, url }`
- `extras`: `{ id, name, category, description, version, size, date, thumbnail, fileName, url, sha256 }`
  - bump `version` when you replace a file and users will see an **Update** button
  - `thumbnail` must be an `https` image (GitHub raw URLs work)
