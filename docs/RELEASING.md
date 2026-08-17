# Releasing signed installers

Cincinnatus ships to people who have been told to be careful about downloading
things. An unsigned installer greets them with a Windows SmartScreen warning or
a macOS "cannot be opened because it is from an unidentified developer" block —
which, for this audience, is indistinguishable from the app being malware. So
release builds are signed, and the workflow **refuses to publish anything that
is not**.

## Where builds run

Builds run on the **discohonesdidit fork** of `VIthCents/Cincinnatus`, because
that is where the signing credentials live.

GitHub repository secrets **do not cross repositories** on a personal account.
Having them on another repo under the same account is not enough — they must be
added to the Cincinnatus fork's own **Settings → Secrets and variables →
Actions**. (An organisation would let you share them once; a personal account
will not.)

Signing is never required to build. Anyone who clones the repo, and any pull
request from any fork, runs `pnpm tauri build` and gets a working unsigned app.
The signing configuration lives in `src-tauri/tauri.release.conf.json`, which
the default build never reads.

## Secrets

Set these as **Secrets**:

| Name                         | What it is                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`            | Application (client) ID of the Entra app registration CI authenticates as       |
| `AZURE_TENANT_ID`            | Directory (tenant) ID                                                           |
| `AZURE_SUBSCRIPTION_ID`      | Subscription holding the Artifact Signing account                               |
| `APPLE_CERTIFICATE`          | Base64 of the Developer ID Application `.p12` (certificate **and** private key) |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting that `.p12`                                     |
| `APPLE_API_KEY_ID`           | Key ID of the App Store Connect API key                                         |
| `APPLE_API_ISSUER`           | App Store Connect issuer ID (a UUID)                                            |
| `APPLE_API_KEY_P8_BASE64`    | Base64 of `AuthKey_<KEYID>.p8`                                                  |

Set these as **Variables** — they are not secret, and keeping them out of the
secret store means they show up in logs where they are useful for debugging:

| Name                     | What it is                                                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `AZURE_SIGNING_ENDPOINT` | Region endpoint, e.g. `https://eus.codesigning.azure.net`                                                                                   |
| `AZURE_SIGNING_ACCOUNT`  | Artifact Signing account name                                                                                                               |
| `AZURE_SIGNING_PROFILE`  | Certificate profile name                                                                                                                    |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Daniel Kelley (ZF45F5247J)` — read from the issued certificate on 2026-08-16; must match its common name exactly |

## Azure: the names all changed

**Azure Trusted Signing was renamed Azure Artifact Signing** when it went GA on
2026-01-14. Anything written before then uses dead names:

| Old                                          | Current                                           |
| -------------------------------------------- | ------------------------------------------------- |
| Azure Trusted Signing                        | Azure **Artifact** Signing                        |
| `Azure/trusted-signing-action`               | `Azure/artifact-signing-action`                   |
| "Trusted Signing Certificate Profile Signer" | "**Artifact** Signing Certificate Profile Signer" |
| `trusted-signing-cli`                        | `artifact-signing-cli`                            |

The underlying resources are unchanged — still the `Microsoft.CodeSigning`
provider and `*.codesigning.azure.net` endpoints.

The Entra app registration needs the **Artifact Signing Certificate Profile
Signer** role on the signing account, and a **federated credential** for this
repository so `azure/login@v3` can use OIDC. No client secret is stored
anywhere.

### Why signtool rather than the action

`azure/artifact-signing-action` signs files that already exist on disk. Used on
its own it signs the NSIS installer and leaves `Cincinnatus.exe` **unsigned
inside it**. Driving signing through `signCommand` means the bundler signs every
binary as it produces it — the app, the uninstaller, and the installer.

`artifact-signing-cli` is what the Tauri docs show, but it hard-requires a
client secret and cannot use OIDC, so it is not used here.

## Apple

The **App Store Connect API key** route is used rather than Apple ID plus
app-specific password: it does not expire on a password change and does not
break when the account has two-factor prompts.

Two things worth knowing, both of which cost time to discover:

- **`APPLE_API_KEY` is the Key ID, not key material.** The actual key is a file
  path in `APPLE_API_KEY_PATH`.
- **`KEYCHAIN_PASSWORD` appears in Tauri's own documentation as a required
  secret and is read nowhere** in `tauri`, `tauri-cli`, `tauri-bundler` or
  `tauri-macos-sign`. It exists only for the manual `security create-keychain`
  step in that document's sample YAML. We let the bundler import the `.p12`
  itself and do not create a keychain.

### The disk image needs notarizing by hand

Tauri notarizes and staples the `.app` but only **signs** the `.dmg`
(tauri-apps/tauri#7533). Since macOS 10.15, an un-notarized disk image
distributed under Developer ID is refused — and the `.dmg` is the file a person
actually double-clicks. The workflow runs `notarytool submit` and
`stapler staple` on it explicitly.

## Why the verification step exists

**The bundler does not fail when signing is misconfigured.** It warns and exits 0. Without the verification steps, a release would ship unsigned and nobody
would find out until a veteran saw a security warning. Both jobs assert:

- Windows: every `.exe` has a `Valid` Authenticode signature.
- macOS: `codesign --verify --deep --strict`, `spctl --assess` reporting both
  _accepted_ and _Notarized Developer ID_, and `stapler validate` on the app and
  the disk image.

## Keychain items and the signing identity

macOS binds keychain item ACLs to the signing identity. Cincinnatus stores API
keys in the OS keychain, so **the Developer ID identity must stay the same
across releases** — if it changes, every stored key is invalidated and the app
asks the user for their Mac login password on next launch, which reads as
malware to this audience.

## Releasing

Tag and push:

```
git tag v0.1.0 && git push origin v0.1.0
```

The workflow builds both platforms and opens a **draft** release. It is
deliberately not published automatically: someone installs both artifacts on a
clean machine and confirms the app opens before anyone is asked to download one.

## Not set up yet

**Automatic updates.** The plumbing is deliberately absent while the app is
still changing. Turning it on means an update check on launch, which is new
recurring egress to github.com — and SPEC §3 and PRIVACY.md currently promise
that the only things leaving the machine are search terms to job APIs and
Anthropic calls when the user has supplied a key. That promise has to be amended
in plain words, and the check should probably be opt-in, before any code is
written. See `docs/DECISIONS.md`.

## Azure: done, and the values it issued

Completed 2026-08-16. Organization identity validation passed and the account is
issuing certificates, so the multi-week step below is **history, not a to-do** —
it is kept because it has to be repeated if the account is ever rebuilt.

| Variable                 | Value                                  |
| ------------------------ | -------------------------------------- |
| `AZURE_SIGNING_ENDPOINT` | `https://eus.codesigning.azure.net/`   |
| `AZURE_SIGNING_ACCOUNT`  | `Euterpe`                              |
| `AZURE_SIGNING_PROFILE`  | `Euterpe`                              |
| `AZURE_SUBSCRIPTION_ID`  | `6bff6c6f-7536-43f7-9cd0-0451c70f7088` |

Certificate subject, which is the authority for `bundle.publisher` in
`tauri.conf.json`:

```
CN=Hawkseye Corp., O=Hawkseye Corp., L=Poughkeepsie, S=New York, C=US
```

**It is "Hawkseye Corp.", not "Hawkseye Inc".** The trailing period is part of
the name. `publisher` was set to the wrong one from an early draft of this file
and is now corrected; if these two ever disagree, the installer shows one name
and the signature shows another, which is the exact thing signing is meant to
stop.

Identity validation id `b93ec44b-7e83-4cba-98aa-7cf7d71af150`.

**The certificates are deliberately short-lived** — roughly three days, rotating
daily. That is how Artifact Signing works and it is not a problem to fix: the
signature stays valid after the certificate expires _because it is
timestamped_. `release.yml` already passes `/tr`, and it must keep doing so —
without a timestamp every installer would stop validating within days.

## Azure one-time setup, for rebuilding the account from scratch

Already done for the current account. One step has a lead time measured in weeks.

1. Register the `Microsoft.CodeSigning` resource provider on a **pay-as-you-go
   or Enterprise Agreement** subscription. Free, trial and sponsored
   subscriptions are rejected.
2. Assign yourself **Artifact Signing Identity Verifier** and run Organization
   identity validation for Hawkseye Corp. **Budget 1–20 business days.** It
   cannot be expedited, and the confirmation email link expires after 7 days —
   miss it and validation starts over.
3. Assign the CI service principal **Artifact Signing Certificate Profile
   Signer**, scoped to the certificate profile rather than the subscription:

   ```
   az role assignment create \
     --assignee <sp-object-id> \
     --role "Artifact Signing Certificate Profile Signer" \
     --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CodeSigning/codeSigningAccounts/<account>/certificateProfiles/<profile>"
   ```

4. On the Entra app registration, add a **federated credential** for this
   repository and the `refs/tags/v*` ref, so `azure/login@v3` can authenticate
   without a stored secret.

### A note on SmartScreen

A new certificate starts with no reputation. For the first weeks, some people
downloading the installer will still see a SmartScreen prompt — quieter than the
unsigned one, and it names Hawkseye Corp. rather than "Unknown publisher", but it
is not silent immediately. Reputation accrues with downloads. Worth knowing
before anyone concludes signing did not work.
