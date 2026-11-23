# Cinema — Screening Room

A standalone GitHub Pages catalogue based on Suraj Dash's Cinema list.

The navigation preserves the original Notion placements: Watched and Watchlist, International and Indian, and each branch's media types. Filmmakers and IMDb lists are separate reference collections. A title may belong to more than one source collection; its memberships are preserved.

## Manual maintenance

There are no scheduled refreshes. Keep the source export private in `.cinema-source/notion-page.json`. To import a fresh, complete copy of the same Notion page, run `node scripts/import-notion.mjs`, then run the metadata enrichment script. Review the source audit and metadata results before publishing. Existing Notion source placements take precedence over external film classifications.

Only verified metadata with a matching IMDb identifier is used. The poster images remain linked to their original source. Unavailable images retain a visible title card. No film files are hosted.

## Preview and publish

This is a static website. Serve the repository with a local HTTP server for preview. All paths are relative so the site works under `/cinema/` on GitHub Pages. The public site is published from the main branch at the repository root, with `.nojekyll`.

