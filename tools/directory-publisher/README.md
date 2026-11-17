# Publishing the static room directory

The room directory is **plain signed JSON on ordinary static hosting** — there is
no database behind it, ever. This tool only *writes the tree*; uploading is an
explicit owner action using one of the adapters below (a static host cannot be
assumed to accept arbitrary writes).

## 1. Build the tree

```bat
bun tools\directory-publisher\build.ts --from rooms --out room-directory
```

Every manifest is signature-verified before it is published; the build refuses
to emit anything if any file fails verification.

## 2. Upload — pick one adapter

### GitHub Pages
The tree is committed to the repo; Pages serves it as-is.

```bat
git add room-directory
git commit -m "publish room directory"
git push
:: (with Pages configured to serve from the branch — see repo settings)
```

Directory URL: `https://<user>.github.io/<repo>/room-directory/index.json`

### Netlify
```bat
npx netlify-cli deploy --dir room-directory --prod
```

### Cloudflare Pages
```bat
npx wrangler pages deploy room-directory --project-name pixolark-directory
```

### Self-hosted (nginx / any static file server)
Copy the folder wherever the server serves static files:

```bat
xcopy /E /I room-directory \\static-host\www\room-directory\
```

## 3. Register the mirrors

Point the client at the published URL(s) — `VITE_DIRECTORY_URL` (app env) lists
mirror base URLs, and `--mirror` on the build command records them inside
`index.json` so other clients can discover fallbacks. Multiple independent
mirrors are fine: clients verify every manifest signature themselves, so a
mirror cannot forge rooms, only serve stale ones (expiry bounds staleness).

## 4. Republishing (owners)

To change a room (name, category, region, coordinator URLs, policy), the OWNER
re-signs the manifest with the room's signing key and republishes the whole
directory:

```bat
bun tools\room-manifest-generator\generate.ts --roomId 123456 --name "New Name" --key keys\123456.owner.pkcs8.b64 --out rooms\123456.json
bun tools\directory-publisher\build.ts
```

Expired manifests are ignored by clients even if a mirror still serves them.
A removed room simply disappears from the tree on the next publish.
