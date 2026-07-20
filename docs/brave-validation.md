# Brave extension validation

Use this runbook for authentic local extension checks. It was verified with Brave 1.92.141 (Chromium 150) on macOS. Recheck `chrome-devtools-axi --help` and Brave's current command-line behavior after a browser upgrade; do not silently substitute Chrome when Brave is the target.

## Start a fresh inspectable Brave

Run from the repository root. Use a new profile and port for every validation so another Brave instance cannot absorb the launch. The mock-keychain flags prevent a fresh headful profile from stopping at a macOS `NSAlert` before its DevTools endpoint starts.

```sh
ROOT=$(pwd -P)
VALIDATION_DIR="$ROOT/.brave-validation"
PROFILE="$VALIDATION_DIR/profile"
PORT=9337
BRAVE='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'

rm -rf "$VALIDATION_DIR"
mkdir -p "$PROFILE"
"$BRAVE" \
  --user-data-dir="$PROFILE" \
  --remote-debugging-port="$PORT" \
  --remote-debugging-address=127.0.0.1 \
  '--remote-allow-origins=*' \
  --use-mock-keychain \
  --password-store=basic \
  --no-first-run \
  --no-default-browser-check \
  --disable-search-engine-choice-screen \
  --disable-background-networking \
  --disable-component-update \
  --disable-sync \
  --disable-features=DisableLoadExtensionCommandLineSwitch \
  --disable-extensions-except="$ROOT" \
  --load-extension="$ROOT" \
  --allow-file-access-from-files \
  --enable-logging=stderr \
  --v=1 \
  --new-window about:blank \
  >"$VALIDATION_DIR/brave.stdout" \
  2>"$VALIDATION_DIR/brave.stderr" &
BRAVE_PID=$!
echo "$BRAVE_PID" > "$VALIDATION_DIR/brave.pid"

for attempt in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/json/version" > "$VALIDATION_DIR/version.json"; then
    break
  fi
  if [ "$attempt" -eq 60 ]; then
    echo "Brave DevTools endpoint did not start" >&2
    exit 1
  fi
  sleep 0.5
done
```

`DisableLoadExtensionCommandLineSwitch` is needed by current Chromium builds that otherwise suppress command-line extension loading. `--allow-file-access-from-files` is paired with the extension's `file:///*` host permission for local fixture validation.

## Authenticate the process and extension

Verify the PID really is the fresh Brave executable and received the profile and extension flags:

```sh
ps -p "$BRAVE_PID" -o pid=,ppid=,command=
cat "$VALIDATION_DIR/version.json"
```

The DevTools product string can say `Chrome/<chromium-version>` even when the authenticated PID is `/Applications/Brave Browser.app/...`; the PID command is the browser identity evidence.

Attach `chrome-devtools-axi` to that exact endpoint with a lane-unique session:

```sh
export CHROME_DEVTOOLS_AXI_SESSION=pdf-resume-validation
export CHROME_DEVTOOLS_AXI_BROWSER_URL="http://127.0.0.1:$PORT"
chrome-devtools-axi open chrome://extensions-internals
chrome-devtools-axi wait 1000
chrome-devtools-axi eval '() => { const items=JSON.parse(document.body.innerText); const item=items.find(entry => entry.name === "pdf-resume"); return item && { id:item.id, path:item.path, location:item.location, manifest_version:item.manifest_version, registry_status:item.registry_status, disable_reasons:item.disable_reasons, permissions:item.permissions }; }'
```

Require the repository path, `COMMAND_LINE`, manifest version 3, `ENABLED`, no disable reasons, the expected API permissions, and only `file:///*` host access. Save the returned extension ID. On an extension page, prove local-file access is enabled with:

```js
await chrome.extension.isAllowedFileSchemeAccess()
```

It must return `true` before local-PDF results are accepted.

## Diagnose a missing extension

Do not infer that `--load-extension` is unsupported merely because the extension is absent from `chrome://extensions-internals`. First inspect the log:

```sh
grep -i 'Extension error' "$VALIDATION_DIR/brave.stderr"
```

A rejected manifest is omitted from the internals page. This previously looked like a headless extension-loading failure until verbose logging exposed an insecure MV3 `worker-src blob:` value. Also, a fresh headful profile without `--use-mock-keychain --password-store=basic` can pause in a hidden keychain-related `NSAlert`, making the remote-debugging port appear broken.

## Validate and clean up

Use only `chrome-devtools-axi` for navigation, interaction, accessibility snapshots, console inspection, and network inspection. For a local PDF, verify all pages render, page navigation, zoom, find, enabled open/print/save controls, packaged worker/resource URLs, no console errors, and no remote or failed requests. Verify missing, malformed, remote, and non-PDF inputs produce the local accessible error without a file or remote request.

Stop only this lane's bridge and authenticated Brave PID, then remove every generated fixture and profile:

```sh
chrome-devtools-axi stop
kill "$BRAVE_PID"
wait "$BRAVE_PID" 2>/dev/null || true
rm -rf "$VALIDATION_DIR"
```
