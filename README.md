<!-- SPDX-FileCopyrightText: 2026 Stare contributors -->
<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

<div align="center">

<img src="packaging/gui/com.gundulabs.Gaze.svg" alt="Stare icon" width="120" />

# Stare

**Face unlock for Linux, with a dynamic island**

<img src="docs/public/stare-island.gif" alt="The island scanning, failing, retrying and succeeding" width="240" />

</div>

---

Stare is [Gaze](https://github.com/GunduLabs/gaze) with the look of
[Glance](https://github.com/jonnyoo/glance). Gaze does the face authentication
on Linux; Stare adds Glance's dynamic island on top of it, in Ubuntu orange.

While the camera looks for your face, a black pill drops from the top of the
screen and opens into the Face ID glyph. A match turns the glyph into a
spinning ring and a checkmark. A failed attempt dims the glyph and shakes it.

## What Stare changes

| | Gaze | Stare |
|---|---|---|
| Feedback while scanning | "(or look at the camera)" under the password field | The island, plus Gaze's hint |
| App icon | Gaze's scanner tile | The orange face glyph |
| Daemon, PAM module, CLI, settings app | Gaze | Unchanged |

Only what you see is rebranded. Binaries, the PAM module, the D-Bus name, the
extension UUID (`gaze@gundulabs.com`) and the package names are still Gaze's, so
Stare works with an installed Gaze and the [Gaze documentation](https://gaze.gundulabs.com)
applies as is. The settings window still calls itself Gaze.

## Where the island appears

| Where | Needs |
|---|---|
| GNOME lock screen | User install |
| GNOME password dialogs (polkit), for example when an app asks for admin rights | User install |
| `sudo` and `su` in a terminal | System install |
| GDM login screen | System install, and face login turned on for GDM |

On a face match the island draws its checkmark before the lock screen or login
screen goes away, so the unlock waits about 0.7 s for it (never more than
1.5 s). If the desktop's animations are turned off, nothing waits. A password
always unlocks at once, even while the camera is still looking.

## Install

Stare needs GNOME Shell 45 to 51 and a working Gaze install, including Gaze's
GNOME extension. See [Gaze's installation guide](https://gaze.gundulabs.com/guide/installation).

### User install

From a checkout of this repository:

```bash
scripts/stare-install.sh
```

Then log out and back in. The script copies the extension, the icon and the
launcher name into your user data directory. It needs no root access and
changes nothing under `/usr` or `/etc`. Your copy of the extension shadows the
one from the `gaze-gnome-extension` package, because both use the same UUID.

To go back to plain Gaze:

```bash
scripts/stare-install.sh uninstall
```

### System install

For the login screen and terminal prompts, install for the whole machine:

```bash
sudo scripts/stare-install.sh system
```

This:

- replaces the extension in `/usr/share/gnome-shell/extensions/gaze@gundulabs.com`, keeping Gaze's copy in `/var/lib/stare` so it can be put back;
- adds three `optional pam_exec.so` lines around Gaze in `/etc/pam.d/common-auth`, through `pam-auth-update`, which run `/usr/local/libexec/stare-island-pam`;
- installs a D-Bus policy so that only root can send the island's terminal events.

The PAM lines are `optional` and the helper always exits 0 within a second, so
they cannot change whether authentication succeeds. The helper only reports
for `sudo`, `sudo-i`, `su` and `su-l`, and the island only reacts to prompts
started by the logged-in user. The resulting stack looks like this:

```
auth  optional                    pam_exec.so ... stare-island-pam scan
auth  [success=4 default=ignore]  pam_gaze.so
auth  optional                    pam_exec.so ... stare-island-pam fail
auth  [success=2 default=ignore]  pam_unix.so nullok try_first_pass
auth  [success=1 default=ignore]  pam_sss.so use_first_pass
auth  requisite                   pam_deny.so
auth  required                    pam_permit.so
auth  optional                    pam_exec.so ... stare-island-pam done
```

GDM only scans faces if that is turned on in the extension's preferences
(`gnome-extensions prefs gaze@gundulabs.com`, **Enable face authentication at
GDM login**). Reboot after the system install so the login screen loads it.

To undo everything the system install did:

```bash
sudo scripts/stare-install.sh system-uninstall
```

When you update the Gaze packages, update Stare too: its extension replaces
Gaze's, so it has to match the installed daemon and PAM module. A Gaze package
upgrade puts Gaze's own extension back; run the system install again
afterwards. Stare is currently based on Gaze 0.5.1's extension.

## Development

The island lives in two files next to Gaze's extension:

- `integrations/gnome-shell/islandDrawing.js`: the state machine and the Cairo
  drawing. It has no GNOME imports, so it also runs under plain `gjs` and `node`.
- `integrations/gnome-shell/island.js`: the on-screen actor.
- `packaging/stare/`: the PAM helper, its `pam-auth-update` profiles and the D-Bus policy for terminal prompts.

`extension.js` drives the island from the messages Gaze's PAM module sends. The
island never takes part in authentication: every call into it is wrapped, and
the tests check that a throwing island leaves the login flow untouched.

```bash
node scripts/test-gnome.mjs          # extension hooks against GNOME Shell 45 to 51
node scripts/test-island.mjs         # island state machine
gjs -m scripts/render-island.js out  # render a full session to PNG frames
```

To pick up changes from Gaze:

```bash
git fetch upstream
git merge upstream/main
```

## Credits and license

- [Gaze](https://github.com/GunduLabs/gaze) by Gundu Labs, GPL-3.0-or-later. Everything that authenticates you is theirs.
- [Glance](https://github.com/jonnyoo/glance) by Jonathan Zhou, MIT. The island's design and the face glyph are recreated from it; no Glance code is included.

Stare is licensed under GPL-3.0-or-later. See [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

Face authentication with an ordinary webcam is a convenience, not a security
upgrade, so keep your password as the fallback. Stare changes nothing about how
Gaze decides who you are.
