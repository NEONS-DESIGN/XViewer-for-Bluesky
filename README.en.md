<div align="center">

<img src="src/icons/icon-128.png" width="96" alt="The XViewer for Bluesky icon" />

# XViewer for Bluesky

**A browser extension that shows a Bluesky profile's media as a thumbnail grid, and lets you read post details, reply and like without closing the image**

[![version](https://img.shields.io/github/package-json/v/NEONS-DESIGN/XViewer-for-Bluesky?color=006aff)](package.json)
[![license](https://img.shields.io/github/license/NEONS-DESIGN/XViewer-for-Bluesky?color=006aff)](LICENSE)
![manifest](https://img.shields.io/badge/manifest-v3-006aff)
![tests](https://img.shields.io/badge/tests-passing-006aff)

**[Website](https://xvbluesky.neonsdesign.com/en/)** ・
[Privacy policy](https://xvbluesky.neonsdesign.com/en/privacy.html) ・
[日本語](README.md)

</div>

---

> [!NOTE]
> This document is a translation of [README.md](README.md) for reference.
> **The extension's interface is currently in Japanese only.** (See [Languages](#languages))

---

> [!IMPORTANT]
> **This is an unofficial extension built on Bluesky's (AT Protocol) public API.**
> **It is not an application created or distributed by Bluesky Social PBC.**
> It is not affiliated with, endorsed by, or supported by Bluesky Social PBC in any way.
> You are responsible for anything that results from using it.

---

## What this is

A Bluesky profile's Media tab becomes **a grid of square thumbnails**.
Open an image and the post's text, date and counts appear on the right, where you can reply, repost, like or bookmark right away.
Clicking the image itself no longer closes it, so you won't be thrown back to the list halfway through.

![An image open in the lightbox, with the post details panel on the right](site/assets/img/shot-lightbox.webp)

## Features

### Media grid

![A profile's Media tab shown as a thumbnail grid](site/assets/img/shot-grid.webp)

| | |
| --- | --- |
| **Grid view** | Replaces a profile's Media tab with a three-column grid of square thumbnails, built from data fetched from the AT Protocol public API (`getAuthorFeed` on `public.api.bsky.app`). One tile per post; posts with several images get an icon on the first image. Videos are left to the Videos tab |
| **Loading more** | More posts are fetched only when you scroll to the bottom. Nothing is prefetched. Moving to another account leaves none of the previous account's images behind |
| **Opens in Bluesky's lightbox** | Clicking a tile opens Bluesky's own lightbox, so zooming and moving between images work just like they do in Bluesky |
| **NSFW blur** | Labeled images are blurred, just like in Bluesky. A setting removes the blur and warning text from grid tiles (off by default; warnings shown by Bluesky itself are left alone) |

### Lightbox

When you open an image, a post details panel appears on the right. It works wherever you open an image on bsky.app, not only from the grid.

<img src="site/assets/img/shot-panel.webp" width="380" alt="A close-up of the post details panel, showing the author, text, date, counts and action buttons (labels in Japanese)" />

| | |
| --- | --- |
| **Post details** | The author, text, date, the reply / repost / like counts and an "Open post" button. Links, mentions and hashtags in the text work too. The panel can be collapsed |
| **React without closing** | Reply, repost, quote, like and bookmark without closing the image. The button changes the moment you press it; if the request fails it goes back and tells you in one line. Reply and quote open Bluesky's own composer on top of the lightbox. The buttons are not shown when you are signed out |
| **Clicking the image keeps it open** | Clicking the image itself no longer closes the lightbox, and the pointer turns into a hand only over buttons you can press. Click the dark area around it to close. The close button moves to the top left, with the image options next to it |

For sign-in, it only borrows the authenticated client that Bluesky keeps in the page, and never touches the tokens in `localStorage`.
What can be done through the borrowed client is limited to adding and removing your own likes, reposts and bookmarks, and fetching posts.

### Other

| | |
| --- | --- |
| **Navigation buttons** | Adds fixed "Videos / Media / Posts / Back to top" buttons at the bottom right of a profile. The button for the tab you are on is hidden, and "Back to top" appears once you scroll |
| **Debug mode** | Logs tab detection, the grid starting and stopping, and fetching to the console (`[XViewer][debug]`), and writes the internal state to the `data-bsky-ext-state` attribute on the `html` element (off by default) |
| **Themes** | The panel follows Bluesky's dark / dim / light theme. The settings popup has its own switch |

## Browsers

Chromium-based browsers that support Manifest V3 (Chrome / Brave / Edge, etc.). **Chrome 120 or later** is required.
(It uses `"world": "MAIN"` for content scripts, `color-mix()` and CSS nesting)
It can also be built for Firefox (Firefox 140 or later), but only as a temporary add-on, and it has not yet been tested much there.
Safari is not supported.

## Languages

The extension's interface (popup, panel and buttons) is currently **Japanese only**.
It works whatever language you use Bluesky in, but the parts the extension adds are shown in Japanese.

## Install

The extension is not on any store yet. Load it in one of the following ways.

### From the release zip

1. Download the latest `XViewer.for.Bluesky_x.y.z.zip` from [Releases](https://github.com/NEONS-DESIGN/XViewer-for-Bluesky/releases/latest) and unzip it
2. Open `chrome://extensions/` (`brave://extensions/` on Brave, `edge://extensions/` on Edge)
3. Turn on **Developer mode** at the top right
4. Click **Load unpacked**
5. Choose the unzipped folder

To update, unzip the new version over the old one into the same folder, press the reload button on the extension's card, then reload your bsky.app tabs.
If you delete the unzipped folder, the extension can no longer be loaded.

### Building from source

Node.js 24.2 or later is required.

```bash
git clone https://github.com/NEONS-DESIGN/XViewer-for-Bluesky.git
cd XViewer-for-Bluesky
npm install
npm run build
```

**Chromium-based browsers**

1. Open `chrome://extensions/`
2. Turn on **Developer mode** at the top right
3. Click **Load unpacked**
4. Choose the generated **`dist/`** folder

Choose `dist/`, not `src/` or the repository root. Only the build output works.

**Firefox**

1. Open `about:debugging` and choose **This Firefox**
2. Click **Load Temporary Add-on** and choose **`dist-firefox/manifest.json`**

Temporary add-ons are removed when Firefox closes.

## Usage

Open a **profile** on bsky.app (`https://bsky.app/profile/{handle}`) and either press "Media" at the bottom right or open the Media tab.
The post details panel appears wherever you open an image on bsky.app. (Home, post pages, search results, etc.)

### Settings

Open them from the toolbar icon. There are two tabs, Settings and License; each section of Settings has on/off switches.
Changes take effect right away, without reloading.
Options marked `↳` belong to the option above them and can't be changed while the parent is off. (Pressing one shows why)
A child keeps its setting, and comes back as it was when the parent is turned on again.
The License tab shows the disclaimer and the notices for bundled third-party work.
The option names below are translations; the popup shows them in Japanese.

| Group | Option | Default | What it does |
| --- | --- | --- | --- |
| Media grid | Show media grid | On | Replaces a profile's Media tab with a grid of square thumbnails. Turn it off to get Bluesky's own view back |
| Media grid | ↳ Remove NSFW blur | Off | Removes the blur and warning text from grid tiles so a single click opens them. Warnings shown by Bluesky itself are left alone |
| Lightbox | Show post details | On | Shows the text, date and counts on the right when you open an image. Works for images outside the grid too. Not shown when the window is narrow |
| Lightbox | ↳ Reply and like | On | Adds reply, repost, quote, like and bookmark buttons to the panel. When off, only the buttons go away and the panel stays |
| Lightbox | Don't close on image click | On | Keeps the lightbox open when you click the image itself, and leaves the hand pointer only on buttons. Moves the close button to the top left, with the image options next to it |
| Developer | Debug mode | Off | Logs tab detection, the grid starting and stopping, and fetching to the console, and writes the internal state to an attribute on the `html` element. Useful when reporting a bug |

The popup's color theme can be switched between dark and light with the button at the top right. It follows your OS at first,
and stays on your choice once you switch. ("Reset settings" returns it to following the OS)
"Reset settings" restores every option and the theme to their defaults after a confirmation.

## Notes

- **This is an unofficial extension.** It is built on Bluesky's (AT Protocol) public API and is not an application
  created or distributed by Bluesky Social PBC. It has no connection with the company
- **Use it at your own risk.** Neither the author nor Bluesky Social PBC is responsible for any damage caused by using this extension
- **Each like, repost or bookmark you press is sent to Bluesky from your account.**
  Likes and reposts are public, just as when you use Bluesky directly
- **Replies and quotes are posted only when you send them from Bluesky's own composer.**
  The extension never deletes posts, follows, blocks or sends DMs
- **Removing the NSFW blur affects only the grid tiles.** It never changes Bluesky's own content settings or the warnings Bluesky shows
- **It has no way to collect images.** There is no downloading and no bulk automation.
  It only fetches the posts of the profile you are viewing and the post of the image you open
- **Posts are fetched only when you scroll to the bottom, with no prefetching.** Requests to the public API
  are made one at a time, with a pause between them
- **Changes on Bluesky's side may stop it from working.** If Bluesky's page structure changes, the grid or the panel may stop appearing
- It has not yet been tested on labeler accounts (accounts without a Media tab), while signed out, or at phone-sized widths

## Bug reports, questions and requests

Please send bug reports, questions and feature requests to **[Issues](https://github.com/NEONS-DESIGN/XViewer-for-Bluesky/issues)**. You are welcome to write in English.
For a bug, turning on "Debug mode" in the popup and including what it prints to the console makes the cause much easier to find.
(Before pasting, check that it does not contain your own account identifier or similar)

## Development

| Command | What it does |
| --- | --- |
| `npm run build` | Builds `dist/` for Chromium-based browsers and `dist-firefox/` for Firefox |
| `npm run build:chrome` / `npm run build:firefox` | Builds only one of them |
| `npm run watch` | Build in watch mode (JS only; run `npm run build` after changing CSS, HTML or icons) |
| `npm test` | Runs the tests with `node --test` |
| `npm run build:icons` | Generates the extension icon PNGs (the output is committed) |
| `npm run build:symbols` | Generates the icon shapes for the popup and panel (`src/common/icon-shapes.js`) from Material Symbols (the output is committed) |
| `npm run build:site-langs` | Rewrites the language lists on every website page (hreflang / language menu / footer) and `site/sitemap.xml` from the table in `scripts/site-langs.mjs` |

The source lives in `src/` as ES Modules and is bundled with esbuild. There are only devDependencies and no runtime dependencies.
The single source of the version is `version` in `package.json`; the build writes it into `dist/manifest.json` and `dist-firefox/manifest.json`.
The single source of the minimum browser versions (the esbuild target, `minimum_chrome_version`, and Firefox's `strict_min_version`) is `scripts/targets.mjs`.

After changing the code, always do these three things, or your change will look as if it had no effect.

1. Run `npm run build`
2. Press the reload button on the extension's card
3. Reload the bsky.app tab (`inject.js` runs in the page's world, so a new version only loads after the tab is reloaded)

Tests use only Node's built-in test runner (`node:test`). They cover the pure functions for parsing, formatting and decisions,
the popup (including rendering into a fake DOM), and the build tools. DOM work in the content script, changes to Bluesky's layout,
and the bridge are checked on the real bsky.app.

The extension icons (`src/icons/`) are generated by `npm run build:icons`. Don't edit them in an image editor;
change `GEOMETRY` in `scripts/icon-svg.mjs` and regenerate them. The background color matches the popup's accent color.

`site/` is the source of the [website](https://xvbluesky.neonsdesign.com/en/). It has no build step.
Pushing to `main` makes `.github/workflows/pages.yml` publish only `site/` to GitHub Pages.
To check it locally, run `python -m http.server 8000 --directory site` and open `http://localhost:8000/`.
(Opened via `file://`, `en/` does not resolve to `en/index.html`)
The language lists are not written by hand on each page; rewrite them with `npm run build:site-langs`. Don't remove the markers (such as `<!-- lang:head -->`).

[XViewer for Pixiv](https://github.com/NEONS-DESIGN/XViewer-for-Pixiv) is a sister project that shares the same build approach and popup design.

## License

[MIT License](LICENSE)

For the third-party work bundled with this extension, see [`NOTICE`](NOTICE). The text of the Apache License 2.0 is included in [`LICENSES/`](LICENSES).
