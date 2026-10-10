#!/usr/bin/env bash
# Benchmark "quiet mode" for the Ubuntu desktop (docs/08-UBUNTU-SETUP.md §3).
#   ./scripts/ubuntu-tune.sh [--swapoff] [--inhibit]   apply
#   ./scripts/ubuntu-tune.sh --revert                   undo everything applied
#   --swapoff   also disable swap for the session (memory results stay honest)
#   --inhibit   hold a systemd-inhibit lock (no sleep/idle) until --revert
# Previous values are saved in $STATE_FILE so --revert restores exactly them.
set -euo pipefail

STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/go-benchmarking"
STATE_FILE="$STATE_DIR/tune.state"
SYSCTL_FILE=/etc/sysctl.d/99-bench.conf
SYSCTLS=(net.core.somaxconn=65535 "net.ipv4.ip_local_port_range=1024 65535" net.ipv4.tcp_tw_reuse=1)
TIMERS=(apt-daily.timer apt-daily-upgrade.timer unattended-upgrades.service)
# GNOME keys: no suspend on AC, no idle blank/lock while a run is going.
GSETTINGS=(
  "org.gnome.settings-daemon.plugins.power sleep-inactive-ac-type 'nothing'"
  "org.gnome.desktop.session idle-delay uint32 0"
  "org.gnome.desktop.screensaver lock-enabled false"
)

log()  { printf '\033[34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

REVERT=0 SWAPOFF=0 INHIBIT=0
for arg in "$@"; do
  case "$arg" in
    --revert) REVERT=1 ;;
    --swapoff) SWAPOFF=1 ;;
    --inhibit) INHIBIT=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "unknown option: $arg (see --help)" ;;
  esac
done

[[ "$(uname -s)" == "Linux" ]] || die "quiet mode is for the Ubuntu server. On macOS: plug in, close apps, and treat numbers as unofficial."
(( EUID != 0 )) || die "run as your desktop user (sudo is used where needed) so GNOME settings apply to your session"
sudo -v

# gsettings needs the user's D-Bus session; over SSH point it at the running one.
if [[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" && -S "/run/user/$(id -u)/bus" ]]; then
  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$(id -u)/bus"
  export DBUS_SESSION_BUS_ADDRESS
fi

state_get() { [[ -f "$STATE_FILE" ]] && grep -m1 "^$1=" "$STATE_FILE" | cut -d= -f2- || true; }

# ---------------------------------------------------------------- revert ----
if (( REVERT )); then
  [[ -f "$STATE_FILE" ]] || warn "no saved state ($STATE_FILE): restoring Ubuntu defaults where possible"

  if have powerprofilesctl; then
    prof="$(state_get power_profile)"; prof="${prof:-balanced}"
    powerprofilesctl set "$prof" && log "power profile -> $prof"
  fi

  if have gsettings; then
    i=0
    for entry in "${GSETTINGS[@]}"; do
      read -r schema key _ <<<"$entry"
      old="$(state_get "gsettings_$i")"
      if [[ -n "$old" ]]; then
        # one argument, GVariant text, e.g. "uint32 300" or "'suspend'"
        gsettings set "$schema" "$key" "$old" 2>/dev/null || warn "could not restore $schema $key"
      else
        gsettings reset "$schema" "$key" 2>/dev/null || true
      fi
      i=$((i + 1))
    done
    log "GNOME power/idle settings restored"
  fi

  sudo systemctl start apt-daily.timer apt-daily-upgrade.timer 2>/dev/null || true
  # unattended-upgrades is a long-running service on Ubuntu; only start if enabled.
  if systemctl is-enabled --quiet unattended-upgrades 2>/dev/null; then
    sudo systemctl start unattended-upgrades || true
  fi
  log "apt timers / unattended-upgrades restarted"
  if have snap; then sudo snap refresh --unhold >/dev/null 2>&1 && log "snap refresh unheld" || true; fi

  if [[ -f "$SYSCTL_FILE" ]]; then
    sudo rm -f "$SYSCTL_FILE"
    for kv in "${SYSCTLS[@]}"; do
      k="${kv%%=*}" old="$(state_get "sysctl_$k")"
      [[ -z "$old" ]] || sudo sysctl -q -w "$k=$old"
    done
    log "removed $SYSCTL_FILE and restored previous sysctl values"
  fi

  if [[ "$(state_get swapoff)" == "1" ]]; then sudo swapon -a && log "swap re-enabled"; fi

  pid="$(state_get inhibit_pid)"
  if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then kill "$pid" && log "released systemd-inhibit lock"; fi

  rm -f "$STATE_FILE"
  log "quiet mode reverted"
  exit 0
fi

# ----------------------------------------------------------------- apply ----
mkdir -p "$STATE_DIR"
if [[ -f "$STATE_FILE" ]]; then
  log "quiet mode already applied (state in $STATE_FILE); re-applying settings, keeping original values"
else
  : >"$STATE_FILE"
fi
save() { grep -q "^$1=" "$STATE_FILE" || printf '%s=%s\n' "$1" "$2" >>"$STATE_FILE"; }

# Power profile: balanced scales the CPU frequency down between bursts.
if have powerprofilesctl; then
  save power_profile "$(powerprofilesctl get)"
  if powerprofilesctl set performance; then log "power profile -> performance"; else warn "could not set performance profile"; fi
else
  warn "powerprofilesctl not found (server install?): skipping power profile"
fi

# No suspend / screen lock mid-run.
if have gsettings; then
  i=0
  for entry in "${GSETTINGS[@]}"; do
    read -r schema key value <<<"$entry"
    if cur="$(gsettings get "$schema" "$key" 2>/dev/null)"; then
      save "gsettings_$i" "$cur"
      gsettings set "$schema" "$key" "$value" || warn "could not set $schema $key"
    else
      warn "gsettings $schema $key unavailable (no GNOME session?)"
    fi
    i=$((i + 1))
  done
  log "GNOME: no suspend on AC, no idle lock"
fi

# Pause background jobs that cause random CPU/disk spikes.
sudo systemctl stop "${TIMERS[@]}" 2>/dev/null || true
log "stopped ${TIMERS[*]}"
if have snap; then
  sudo snap refresh --hold=2h >/dev/null && log "snap auto-refresh held for 2h"
fi

# Network sysctls for high-concurrency runs (many sockets, fast reuse).
tmpconf="$(mktemp)"
{
  echo "# go-benchmarking quiet mode (scripts/ubuntu-tune.sh). Remove with: make untune-host"
  for kv in "${SYSCTLS[@]}"; do
    k="${kv%%=*}" v="${kv#*=}"
    save "sysctl_$k" "$(sysctl -n "$k" | tr '\t' ' ')"
    echo "$k = $v"
  done
} >"$tmpconf"
sudo install -m 0644 "$tmpconf" "$SYSCTL_FILE"
rm -f "$tmpconf"
sudo sysctl -q -p "$SYSCTL_FILE"
log "sysctls applied and persisted in $SYSCTL_FILE"

if (( SWAPOFF )); then
  if [[ -n "$(swapon --show --noheadings)" ]]; then
    sudo swapoff -a && save swapoff 1 && log "swap disabled until --revert (or reboot)"
  else
    log "no active swap"
  fi
fi

if (( INHIBIT )) && have systemd-inhibit; then
  if [[ -z "$(state_get inhibit_pid)" ]]; then
    nohup systemd-inhibit --what=sleep:idle --who=go-benchmarking --why="benchmark session" \
      sleep infinity >/dev/null 2>&1 &
    save inhibit_pid "$!"
    log "systemd-inhibit lock held (pid $!) until --revert"
  fi
fi

cat >&2 <<'MSG'
==> quiet mode ON. Manual checklist:
    - close heavy apps (IDE indexing, other browsers, video calls)
    - keep only one dashboard tab open, don't use the machine during a run
    - laptops: stay plugged in
    Revert with: make untune-host
MSG
