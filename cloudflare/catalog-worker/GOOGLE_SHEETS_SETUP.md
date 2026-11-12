# NAPL — Google Sheets + Cloudflare setup

This change makes the **Community Ports** Google Sheet the catalog source of truth. The catalog Worker reads and writes the sheet through the Google Sheets API. Cloudflare KV is an optional read cache for the public catalog. D1 remains in place for visits, popularity, reports and other community data.

## 1. Google service account

1. In Google Cloud Console, create or select a project.
2. Enable **Google Sheets API**.
3. Create a service account and generate a JSON key.
4. Share the spreadsheet with the service account email as **Editor**.
5. Do not commit the JSON key or private key to this repository.

The spreadsheet ID already defaults to the ID used by the previous published CSV. The tab defaults to `Community Ports`.

## 2. Worker secrets

From `cloudflare/catalog-worker`, configure:

```sh
npx wrangler secret put SHEETS_SERVICE_ACCOUNT_EMAIL
npx wrangler secret put SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY
npx wrangler secret put GITHUB_TOKEN
npx wrangler secret put IMPORT_SECRET
```

- `SHEETS_SERVICE_ACCOUNT_EMAIL`: service account email from Google Cloud.
- `SHEETS_SERVICE_ACCOUNT_PRIVATE_KEY`: the complete PEM private key, including BEGIN/END lines. Wrangler accepts multiline input; if stored as escaped newlines, the Worker normalizes `\\n`.
- `GITHUB_TOKEN`: existing GitHub token used for releases/tags.
- `IMPORT_SECRET`: existing Admin bearer secret.

Optional variables can be added to `wrangler.toml`:
- `SHEETS_SPREADSHEET_ID`: defaults to the current NAPL spreadsheet ID.
- `SHEETS_TAB_NAME`: defaults to `Community Ports`.

Required sheet headers include `GAME`, `PORTS_ID`, `URL`, `VERSION`, and `LAST UPDATE`. Other existing columns are read by their header names.

## 3. Optional KV catalog cache

1. Create a KV namespace in Cloudflare, for example `NAPL_CATALOG_CACHE`.
2. Add its namespace ID to `cloudflare/catalog-worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "CATALOG_KV"
id = "YOUR_REAL_NAMESPACE_ID"
```

Do not use the example ID literally.

Without this binding, the public `/catalog` endpoint temporarily falls back to the existing D1 catalog. Once the binding exists, call the protected endpoint below to seed the cache. The Worker will continue to use D1 only if the KV key is not yet populated.

## 4. First synchronization

Deploy the Worker, then call:

```http
POST /admin/sync-catalog-cache
Authorization: Bearer YOUR_IMPORT_SECRET
```

The response reports game, port and platform counts. Check that these counts and representative records match the Sheet before relying on the cache.

## 5. GitHub release updates

The Admin action **Update GitHub releases** now:
- Reads repository URLs from the Sheet, not D1.
- Deduplicates repositories.
- Checks 12 repositories per Worker request.
- Writes VERSION and LAST UPDATE directly to the corresponding Sheet rows using one Google Sheets batch update per block.
- Preserves existing values when no valid release/tag date or version is found.
- Refreshes KV after the final manual block when KV is configured.

The scheduled Worker runs every 15 minutes and advances a small cursor stored in D1. D1 is used only for this one progress record, not to read or write catalog rows. At 12 repositories per run, a full pass over roughly 500 repositories takes about 42 scheduled runs (about 10.5 hours). A failed run does not advance the cursor.

## 6. Admin catalog management

The Admin list, save and delete endpoints now read and write the Google Sheet. Existing D1 visit totals are read only to display visit counts in Admin. Saving/deleting a port does not delete D1 visit history, votes, device compatibility reports or rating data.

The Developer maintenance action fills only blank DEVELOPER cells for GitHub URLs. Existing manual developer values are preserved.

LaunchBox and Steam metadata buttons were removed from this Admin screen because their older Worker implementations write to D1. Continue using the existing Apps Script automations for those sources until they are migrated to write to Sheets.

## 7. Safe rollout order

1. Configure Google API credentials and share the sheet.
2. Deploy the Worker.
3. Test Admin login and verify the port/game counts.
4. Test one existing port edit, one new port append, and one port deletion only after backing up the sheet.
5. Run GitHub release updates on the Admin page and inspect a few matching rows.
6. Create/bind KV and run the cache synchronization endpoint.
7. Check the public home page, search, game pages, ratings, visits, popularity and compatibility.
8. Keep D1 catalog tables untouched until the new catalog path has been verified for several days.

## Important limitations during this transition

- The existing D1 catalog is deliberately retained as a fallback and rollback source.
- LaunchBox/Steam update routines still target D1 and must not be used from old direct endpoints once Sheets is authoritative. The Admin UI no longer exposes those actions.
- Device compatibility, ratings, votes, visits and popularity remain on their existing Cloudflare databases/services.
- A Sheets API credential or KV binding is not created by a GitHub commit. Those Cloudflare/Google Console setup steps are required before the new paths can run.
