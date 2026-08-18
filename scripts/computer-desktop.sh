#!/usr/bin/env bash
# multibot: how the bot's desktop LOOKS.
#
# Stock XFCE looks like a 2008 Linux install: grey wallpaper, home/filesystem
# icons scattered on the desktop, a panel stuffed with applets nobody asked for.
# This writes a deliberately bare setup instead — black wallpaper, no desktop
# icons, one small dock with exactly three things: terminal, browser, files.
#
# Written as xfconf XML rather than driven through `xfconf-query`, because these
# have to exist BEFORE xfce4-session starts: xfconfd loads them once at session
# start and would otherwise overwrite anything set afterwards.
#
# Runs once. Delete the marker to re-apply after changing this file.
set -uo pipefail

CFG="${XDG_CONFIG_HOME:-$HOME/.config}"
XFCONF="$CFG/xfce4/xfconf/xfce-perchannel-xml"
PANEL="$CFG/xfce4/panel"
MARKER="$CFG/xfce4/.multibot-desktop-v1"

[ -f "$MARKER" ] && exit 0

mkdir -p "$XFCONF" "$PANEL/launcher-1" "$PANEL/launcher-2" "$PANEL/launcher-3" "$CFG/gtk-3.0"

term_exec="xfce4-terminal"
command -v xfce4-terminal >/dev/null 2>&1 || term_exec="xterm"
files_exec="thunar"
command -v thunar >/dev/null 2>&1 || files_exec="$term_exec"
browser_exec="${PREFIX:-/usr}/lib/chromium/chrome"
[ -x "$browser_exec" ] || browser_exec="chromium-browser"

# --- the three launchers -----------------------------------------------------
cat > "$PANEL/launcher-1/mb-terminal.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Terminal
Icon=utilities-terminal
Exec=$term_exec
Categories=System;
EOF

cat > "$PANEL/launcher-2/mb-browser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Browser
Icon=web-browser
Exec=$browser_exec --no-sandbox --disable-dev-shm-usage --disable-gpu --user-data-dir=$HOME/.multibot-computer/chrome
Categories=Network;
EOF

cat > "$PANEL/launcher-3/mb-files.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Files
Icon=system-file-manager
Exec=$files_exec
Categories=System;
EOF

# --- black desktop, no icons -------------------------------------------------
# image-style 0 = no wallpaper image, color-style 0 = solid colour, and rgba1 is
# that colour. desktop-icons/style 0 = nothing on the desktop at all.
cat > "$XFCONF/xfce4-desktop.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-desktop" version="1.0">
  <property name="backdrop" type="empty">
    <property name="screen0" type="empty">
      <property name="monitorVNC-0" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="0"/>
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0"/>
            <value type="double" value="0"/>
            <value type="double" value="0"/>
            <value type="double" value="1"/>
          </property>
        </property>
      </property>
      <property name="monitor0" type="empty">
        <property name="workspace0" type="empty">
          <property name="image-style" type="int" value="0"/>
          <property name="color-style" type="int" value="0"/>
          <property name="rgba1" type="array">
            <value type="double" value="0"/>
            <value type="double" value="0"/>
            <value type="double" value="0"/>
            <value type="double" value="1"/>
          </property>
        </property>
      </property>
    </property>
  </property>
  <property name="desktop-icons" type="empty">
    <property name="style" type="int" value="0"/>
    <property name="file-icons" type="empty">
      <property name="show-home" type="bool" value="false"/>
      <property name="show-filesystem" type="bool" value="false"/>
      <property name="show-removable" type="bool" value="false"/>
      <property name="show-trash" type="bool" value="false"/>
    </property>
  </property>
  <property name="desktop-menu" type="empty">
    <property name="show" type="bool" value="true"/>
  </property>
</channel>
EOF

# --- one small dock, centred at the bottom -----------------------------------
# length 1 with length-adjust keeps it hugging its three icons instead of
# stretching across the screen; p=8 anchors it bottom-centre.
cat > "$XFCONF/xfce4-panel.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfce4-panel" version="1.0">
  <property name="configver" type="int" value="2"/>
  <property name="panels" type="array">
    <value type="int" value="1"/>
    <property name="dark-mode" type="bool" value="true"/>
    <property name="panel-1" type="empty">
      <property name="position" type="string" value="p=10;x=0;y=0"/>
      <property name="length" type="uint" value="1"/>
      <property name="length-adjust" type="bool" value="true"/>
      <property name="position-locked" type="bool" value="true"/>
      <property name="size" type="uint" value="48"/>
      <property name="icon-size" type="uint" value="32"/>
      <property name="mode" type="uint" value="0"/>
      <property name="autohide-behavior" type="uint" value="0"/>
      <property name="background-style" type="uint" value="1"/>
      <property name="background-rgba" type="array">
        <value type="double" value="0.09"/>
        <value type="double" value="0.09"/>
        <value type="double" value="0.11"/>
        <value type="double" value="0.92"/>
      </property>
      <property name="plugin-ids" type="array">
        <value type="int" value="1"/>
        <value type="int" value="2"/>
        <value type="int" value="3"/>
      </property>
    </property>
  </property>
  <property name="plugins" type="empty">
    <property name="plugin-1" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="mb-terminal.desktop"/>
      </property>
    </property>
    <property name="plugin-2" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="mb-browser.desktop"/>
      </property>
    </property>
    <property name="plugin-3" type="string" value="launcher">
      <property name="items" type="array">
        <value type="string" value="mb-files.desktop"/>
      </property>
    </property>
  </property>
</channel>
EOF

# --- dark widgets ------------------------------------------------------------
# Termux ships no dark GTK theme, but GTK3 carries a dark Adwaita variant
# internally, reachable through prefer-dark rather than a theme package.
cat > "$XFCONF/xsettings.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xsettings" version="1.0">
  <property name="Net" type="empty">
    <property name="ThemeName" type="string" value="Adwaita"/>
    <property name="IconThemeName" type="string" value="Adwaita"/>
    <property name="EnableEventSounds" type="bool" value="false"/>
  </property>
  <property name="Gtk" type="empty">
    <property name="FontName" type="string" value="Sans 10"/>
    <property name="CursorThemeSize" type="int" value="24"/>
  </property>
</channel>
EOF

cat > "$CFG/gtk-3.0/settings.ini" <<'EOF'
[Settings]
gtk-application-prefer-dark-theme=1
gtk-theme-name=Adwaita
gtk-icon-theme-name=Adwaita
EOF

# --- window frames: no shadows or fades, they only cost VNC bandwidth ---------
cat > "$XFCONF/xfwm4.xml" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<channel name="xfwm4" version="1.0">
  <property name="general" type="empty">
    <property name="theme" type="string" value="Default"/>
    <property name="use_compositing" type="bool" value="false"/>
    <property name="show_frame_shadow" type="bool" value="false"/>
    <property name="workspace_count" type="int" value="1"/>
  </property>
</channel>
EOF

touch "$MARKER"
exit 0
