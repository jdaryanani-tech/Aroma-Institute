# Development Meta Lead Ads Page subscription

The webhook handler and Page-level subscription are separate steps. The
`GET /api/webhooks/meta/leadgen` challenge route proves only that Meta can
verify the callback token; it does not install the app on the Page. The helper
below checks and, when explicitly approved, adds the Page's `leadgen`
subscription without creating a lead or changing unrelated Page settings.

## Required configuration and permission

The helper reads only these existing Replit Secrets in memory:

- `META_PAGE_ID`
- `META_APP_ID`
- `META_PAGE_ACCESS_TOKEN`
- `META_GRAPH_API_VERSION`

Use a Page access token for the configured Page and app, with the
`pages_manage_metadata` permission required to manage Page webhook
subscriptions. The person/system user that issued the token must also have
Page access that permits managing integrations. Do not paste the token into
the command, source, logs, or chat.

## Safe usage

Default invocation is a GET-only preview:

```sh
npx tsx script/subscribe-meta-page.ts
```

It verifies that the Page access token resolves to the configured Page, then
checks whether the configured app is installed on that Page and has the
`leadgen` field. Output contains only booleans and a fixed allowlisted error
category. It never prints IDs, tokens, request URLs, or raw Graph responses.

Only after reviewing the preview, a separately approved apply requires both
the flag and exact confirmation:

```sh
AICHM_META_PAGE_SUBSCRIBE_CONFIRM=SUBSCRIBE_LEADGEN_FOR_CONFIGURED_DEVELOPMENT_PAGE \
  npx tsx script/subscribe-meta-page.ts --subscribe-page-leadgen
```

Apply re-verifies Page identity and the current subscription. If `leadgen` is
already present for the configured app, it does not POST. Otherwise it posts
the `leadgen` field (preserving any other fields already subscribed for that
app), then GET-verifies the result. It does not change other Page settings,
send test leads, or write CRM data.

The only Graph API requests are HTTPS requests to the configured version:
`GET /me?fields=id`, `GET /{page-id}/subscribed_apps`, and—only in guarded
apply when needed—`POST /{page-id}/subscribed_apps`. GET credentials are not
logged; the POST access token is sent in the form body, not the URL. Redirects
are rejected and failures are reduced to safe categories.

Page app subscription state is not inferred from the webhook challenge route.
The helper is the explicit check for that state. It does not create campaigns,
ads, leads, or subscriptions to any other Page fields.
