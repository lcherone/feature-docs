# Feature Docs

Feature Docs is a local Playwright documentation generator for Soho Home pages. It crawls configured pages, captures page and field screenshots, extracts forms and controls, maps URLs back to likely PHP controllers/models/XML fields, and writes human-readable feature Markdown with the screenshots and code references kept together.

This tool lives under `.vscode/` like Vision Loop and does not change application runtime code.

## Setup

```sh
cd .vscode/feature-docs
npm install
```

If `.vscode/vision-loop` already has dependencies installed, the runner can reuse those local modules when this folder has not run `npm install` yet.

The runner does not require `OPENAI_API_KEY`. It produces deterministic docs and an `agent-context.md` handoff file from Playwright captures plus local code analysis. Codex then uses those artifacts and the referenced source files to refine field-level documentation.

## Configure

```sh
cp config.example.json config.json
```

Edit `config.json`:

- `siteName`: Display name used in generated docs.
- `baseUrl`: Site root, such as `https://dev.soho-home.local`.
- `publicBaseUrl`: Public site root used for the client-facing URL printed under each page title.
- `startUrls`: Entry pages to document.
- `codeDocs`: Optional developer/agent code-analysis notes. By default Feature Docs writes these to `.vscode/code-docs`. Existing code-doc files are reused when their referenced controller, model, XML, provider, and related source files have not changed.
- `crawl.maxPages`: Safety limit for discovered pages.
- `crawl.expandCrud`: When enabled, focused CP runs follow one representative create/edit link for the same CRUD feature when that link is visible to the configured admin user.
- `crawl.clientVisibleCrudOnly`: Enabled for CP by default. This prevents D3R-backed runs from documenting D3R-only pages, skips inaccessible routes, and only discovers related CP action pages from links visible in the browser session.
- `crawl.dedupeDynamicRoutes`: Keeps one representative page for dynamic routes such as `/edit/:identifier`, so listings do not generate a separate document for every product/order/item URL.
- `crawl.discoverControllerActions`: Uses provider route patterns and visible page links to find safe related actions for the same controller while skipping destructive or side-effect actions.
- `crawl.linkSelector`: Which links may be followed. The default follows navigation-style links only.
- `crawl.includePatterns` and `crawl.excludePatterns`: Regex strings matched against each link path.
- `auth`: Use `"anonymous"` for public pages. Use `{ "type": "admin", "emailEnv": "FEATURE_DOCS_ADMIN_EMAIL" }` for `/cp`; the email should be a non-D3R client-facing superuser/admin account.
- `routeSource`: Optional local action for seeding URLs, such as the CP SiteTree/admin-tabs route JSON action.
- `humanDocs`: Controls how many fields are promoted into the main feature narrative. Client-facing docs hide posted field names, storage details, source references, generated timestamps, and full field tables unless the related `include*` options are enabled.
- `viewports[].zoom`: Optional CSS zoom applied before screenshots. CP defaults to `1100x768` at `0.75` zoom with `fullPage` disabled, so screenshots stay compact for documentation.
- `fieldScreenshotPaddingPx`: Adds breathing room around individual field screenshots so labels and controls are not clipped tightly.
- `codeAnalysis.providerGlobs`: Provider files scanned for controller and model aliases.

## Run

```sh
cd .vscode/feature-docs
npm run docs
```

Useful focused runs:

```sh
npm run docs -- --url /cp/customer-care --max-pages 1
npm run docs -- --max-pages 5
npm run docs -- --output customer-care-admin
npm run routes:cp
npm run docs:cp
npm run docs:sample
```

For `/cp` runs, Feature Docs uses the same local-only signed auth middleware as Vision Loop. It toggles the hook in `src/Provider.php` for the run, sets a signed `vision_loop_auth` cookie in Playwright, and disables the hook again at shutdown.

CP documentation is generated from a client-facing admin view, not a D3R view. Set `FEATURE_DOCS_ADMIN_EMAIL` to a non-D3R superuser/admin before running `npm run docs:cp`. In the default CP config, a D3R email fails early, hidden SiteTree routes are not seeded, routes that return login/access-denied pages are skipped, and create/edit/view child pages are only followed when the configured admin can see the link on the captured page.

The default CP config excludes `/cp/styleguide-admin` because those component/demo pages are not client feature documentation.

During a run, Feature Docs builds the source-code index once and reuses one Playwright browser context per viewport. That keeps large CP crawls faster while still opening a fresh page for each captured feature.

When a listing exposes safe create, edit, or view links, the crawler prioritises one representative related page immediately after the listing. Captured sibling pages are linked from the listing's Related Pages section, kept out of the home index, and recorded in `summary.json` so publishing can place them underneath the listing page.

`npm run routes:cp` reads the D3R site tree directly and prints CP routes as JSON. It also harvests CP admin tab links from `config/admin_tabs.php` and provider `getAdminTabs()` registrations. If dynamic SiteTree expansion cannot reach MySQL from PHP CLI, the JSON includes a warning and still returns the admin tab routes. `config.cp.example.json` uses the same action as a `routeSource` with visible SiteTree nodes only, so the crawler can seed itself from CP route JSON instead of starting from only `/cp`.

## Output

Each run writes a self-contained folder:

```text
.vscode/feature-docs/docs/<run-name>/
├── index.md
├── agent-context.md
├── summary.json
└── pages/
    └── <page-slug>/
        ├── README.md
        └── images/
            ├── page-desktop.png
            └── field-001-name.png
```

`index.md` summarises the feature and links every generated page document. `agent-context.md` groups every page by URL, route key, screenshot, fields, likely controller/action, matched route pattern, model alias/class, model XML file, and source file references for Codex follow-up. Page documents are written as client-facing feature documentation: overview, page screenshot, usage steps, CRUD workflow coverage where detected, key settings with relevant screenshots, and page actions. Technical references and full field tables are opt-in.

Each page README includes breadcrumb navigation back to the run `index.md`. This keeps the local markdown tree close to the Confluence page tree: one parent overview page with child pages for the captured screens/actions.

When code analysis is enabled, Feature Docs also writes `.vscode/code-docs/index.md` and one code note per analysed page. These notes are not client-facing docs; they capture what the generator inferred from controllers, models, XML fields, route metadata, and nearby referenced classes so a developer or AI agent can quickly understand the feature before changing it.

## Confluence Sync

The sync script publishes a generated run folder into Confluence as a parent page plus child pages. It creates missing pages, updates existing pages with the next Confluence version number, retries once on version conflicts, uploads referenced screenshots as page attachments, and converts local markdown links into Confluence page links.

```sh
cd .vscode/feature-docs
npm run confluence:sync -- --docs docs/discount-permission-settings-docs --dry-run
npm run confluence:sync -- --docs docs/discount-permission-settings-docs --config confluence.json
```

Use `confluence.example.json` as the starting point. Credentials can also be supplied with `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN`, and `CONFLUENCE_SPACE_KEY`. `parentPageId` is optional; when set, the feature overview page is created or updated below that existing Confluence page.

## Jira Later

The first version only generates local Markdown. The `summary.json` file records page URLs, document paths, screenshots, and titles so a later `jira-sync` command can create or update Jira pages when API credentials and project mapping are provided.
