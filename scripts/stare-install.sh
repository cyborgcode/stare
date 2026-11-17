#!/bin/sh
# SPDX-FileCopyrightText: 2026 Stare contributors
# SPDX-License-Identifier: GPL-3.0-or-later

# Installs Stare on top of an existing Gaze install.
#
#   scripts/stare-install.sh [install]      for your user: the GNOME Shell
#       extension (it shadows Gaze's copy, which shares its UUID), the app
#       icon and the launcher name. Lock screen and password dialogs.
#   scripts/stare-install.sh uninstall
#   sudo scripts/stare-install.sh system    for the whole machine: also the
#       GDM login screen, and sudo/su in a terminal (three optional pam_exec
#       lines around Gaze in /etc/pam.d/common-auth, via pam-auth-update).
#   sudo scripts/stare-install.sh system-uninstall
set -eu

repo=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
uuid=gaze@gundulabs.com
gnome_files="extension.js island.js islandDrawing.js metadata.json prefs.js"
pam_profiles="stare-island-begin stare-island-fail stare-island-done"

system_extension=/usr/share/gnome-shell/extensions/$uuid
backup=/var/lib/stare/gaze-extension
helper=/usr/local/libexec/stare-island-pam
bus_policy=/etc/dbus-1/system.d/io.github.stare.Island.conf
pam_configs=/usr/share/pam-configs
common_auth=/etc/pam.d/common-auth

is_stare_extension() { grep -qs '"name": "Stare"' "$1/metadata.json"; }

copy_extension() {
    mkdir -p "$1"
    for file in $gnome_files; do
        install -m 0644 "$repo/integrations/gnome-shell/$file" "$1/$file"
    done
}

user_install() {
    data=${XDG_DATA_HOME:-$HOME/.local/share}
    extension=$data/gnome-shell/extensions/$uuid
    icon=$data/icons/hicolor/scalable/apps/com.gundulabs.Gaze.svg
    launcher=$data/applications/com.gundulabs.Gaze.desktop

    case $1 in
    install)
        if ! gsettings list-schemas 2>/dev/null | grep -qx org.gnome.shell.extensions.gaze; then
            echo "Gaze's GNOME extension is not installed. Install Gaze first: https://gaze.gundulabs.com/guide/installation" >&2
            exit 1
        fi
        if [ -e "$extension" ] && ! is_stare_extension "$extension"; then
            echo "$extension exists and is not Stare. Move it away, then run this again." >&2
            exit 1
        fi
        copy_extension "$extension"
        mkdir -p "$(dirname "$icon")"
        install -m 0644 "$repo/packaging/gui/com.gundulabs.Gaze.svg" "$icon"
        if command -v gaze-gui >/dev/null 2>&1; then
            mkdir -p "$(dirname "$launcher")"
            install -m 0644 "$repo/packaging/gui/com.gundulabs.Gaze.desktop" "$launcher"
        fi
        echo "Stare is installed for $(id -un). Log out and back in to load it."
        ;;
    uninstall)
        if [ -e "$extension" ]; then
            if ! is_stare_extension "$extension"; then
                echo "$extension is not Stare; leaving it alone." >&2
                exit 1
            fi
            rm -r "$extension"
        fi
        if grep -qs 'Stare app icon' "$icon"; then rm "$icon"; fi
        if grep -qs '^Name=Stare$' "$launcher"; then rm "$launcher"; fi
        echo "Stare is removed. Log out and back in to return to Gaze's own extension."
        ;;
    esac
}

require_root() {
    if [ "$(id -u)" -ne 0 ]; then
        echo "This needs root: sudo $0 $1" >&2
        exit 1
    fi
}

system_install() {
    require_root system
    if [ ! -f "$system_extension/metadata.json" ]; then
        echo "Gaze's GNOME extension is not installed in $system_extension. Install gaze-gnome-extension first." >&2
        exit 1
    fi
    if ! command -v pam-auth-update >/dev/null 2>&1; then
        echo "pam-auth-update is missing: terminal support needs Debian or Ubuntu's PAM tooling." >&2
        exit 1
    fi

    # Keep Gaze's own extension so system-uninstall can put it back.
    if ! is_stare_extension "$system_extension"; then
        rm -rf "$backup"
        mkdir -p "$backup"
        cp -a "$system_extension/." "$backup/"
    fi
    copy_extension "$system_extension"

    install -D -m 0755 "$repo/packaging/stare/stare-island-pam" "$helper"
    install -D -m 0644 "$repo/packaging/stare/io.github.stare.Island.conf" "$bus_policy"
    for profile in $pam_profiles; do
        install -m 0644 "$repo/packaging/stare/pam-configs/$profile" "$pam_configs/$profile"
    done
    # pam-auth-update refuses, and changes nothing, if common-auth was edited by hand.
    DEBIAN_FRONTEND=noninteractive pam-auth-update --enable $pam_profiles || true
    if ! grep -qs stare-island-pam "$common_auth"; then
        echo "pam-auth-update did not add the terminal hooks to $common_auth, so sudo will not show the island." >&2
        echo "The rest of Stare is installed. Run 'sudo pam-auth-update' to see why." >&2
    fi

    # The system copy now serves every session; a per-user copy would shadow it.
    if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ]; then
        home=$(getent passwd "$SUDO_USER" | cut -d: -f6)
        user_extension=$home/.local/share/gnome-shell/extensions/$uuid
        if is_stare_extension "$user_extension"; then rm -r "$user_extension"; fi
    fi

    echo "Stare is installed for every user, the login screen and sudo/su."
    echo "Log out and back in (or reboot for the login screen) to load it."
    echo "The login screen only scans faces if it is turned on: gnome-extensions prefs $uuid"
}

system_uninstall() {
    require_root system-uninstall
    if command -v pam-auth-update >/dev/null 2>&1; then
        DEBIAN_FRONTEND=noninteractive pam-auth-update --remove $pam_profiles || true
    fi
    if grep -qs stare-island-pam "$common_auth"; then
        echo "$common_auth still runs stare-island-pam; run 'sudo pam-auth-update' to clean it up." >&2
        echo "Those lines are optional, so authentication keeps working without the helper." >&2
    fi
    for profile in $pam_profiles; do rm -f "$pam_configs/$profile"; done
    rm -f "$helper" "$bus_policy"

    if [ -f "$backup/metadata.json" ] && is_stare_extension "$system_extension"; then
        for file in $gnome_files; do rm -f "$system_extension/$file"; done
        cp -a "$backup/." "$system_extension/"
        rm -rf "$backup"
    fi
    echo "Stare is removed from the system. Log out and back in to return to Gaze."
}

case ${1:-install} in
install | uninstall) user_install "${1:-install}" ;;
system) system_install ;;
system-uninstall) system_uninstall ;;
*)
    echo "usage: $0 [install|uninstall|system|system-uninstall]" >&2
    exit 2
    ;;
esac
