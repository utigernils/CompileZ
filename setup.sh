#!/usr/bin/env bash
set -Eeuo pipefail
trap 'printf "\nCompileZ setup failed at line %s. Check the error above.\n" "$LINENO" >&2' ERR

if [[ "$EUID" -ne 0 ]]; then
  printf 'Run this installer as root: sudo bash setup.sh\n' >&2
  exit 1
fi

SOURCE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_DIR="${INSTALL_DIR:-/opt/compilez}"
SERVICE_USER="${COMPILEZ_USER:-${SUDO_USER:-compilez}}"
DATA_DIR="/var/lib/compilez"
ENV_FILE="/etc/compilez.env"

if [[ "$SERVICE_USER" == root || ! "$SERVICE_USER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]]; then
  printf 'COMPILEZ_USER must be a valid non-root account.\n' >&2
  exit 1
fi
if [[ ! "$INSTALL_DIR" =~ ^/[a-zA-Z0-9/_-]+$ || "$INSTALL_DIR" == / || "$INSTALL_DIR" == /home || "$INSTALL_DIR" == /opt || "$INSTALL_DIR" == /usr || "$INSTALL_DIR" == /var ]]; then
  printf 'INSTALL_DIR must be a dedicated absolute application directory without spaces.\n' >&2
  exit 1
fi
if [[ ! -f /etc/os-release ]]; then
  printf 'This installer requires Debian 12 or a compatible Debian system.\n' >&2
  exit 1
fi
source /etc/os-release
if [[ "${ID:-}" != debian ]]; then
  printf 'This installer targets Debian 12. Detected: %s\n' "${PRETTY_NAME:-unknown}" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
printf '\n[1/6] Installing system dependencies...\n'
apt-get update
apt-get install -y ca-certificates curl gnupg build-essential python3 python3-venv python3-pip git pkg-config lm-sensors rsync openssl util-linux avrdude

printf '\n[2/6] Installing Node.js 22 LTS...\n'
if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(".")[0])')" -lt 22 ]]; then
  install -d -m 0755 /usr/share/keyrings
  curl --fail --silent --show-error --location https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes --output /usr/share/keyrings/nodesource.gpg
  printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' > /etc/apt/sources.list.d/nodesource.list
  apt-get update
  apt-get install -y nodejs
fi
if ! command -v npm >/dev/null 2>&1; then apt-get install -y npm; fi
node --version
npm --version

printf '\n[3/6] Preparing service account and application...\n'
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd --system --user-group --create-home --home-dir "$DATA_DIR" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
usermod -a -G dialout "$SERVICE_USER"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_DIR" "$DATA_DIR"
install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 "$INSTALL_DIR/spaces"
if [[ "$(realpath "$SOURCE_DIR")" != "$(realpath "$INSTALL_DIR")" ]]; then
  rsync -a --exclude=node_modules --exclude=.data --exclude=.git --exclude=.env --exclude=.venv --exclude=test-results "$SOURCE_DIR/" "$INSTALL_DIR/"
fi
chown -R "$SERVICE_USER:$SERVICE_GROUP" "$INSTALL_DIR" "$DATA_DIR"

printf '\n[4/6] Installing application and PlatformIO dependencies...\n'
cd "$INSTALL_DIR"
if [[ -f package-lock.json ]]; then
  runuser -u "$SERVICE_USER" -- npm ci --no-audit --no-fund
else
  runuser -u "$SERVICE_USER" -- npm install --no-audit --no-fund
fi
runuser -u "$SERVICE_USER" -- python3 -m venv "$INSTALL_DIR/.venv"
runuser -u "$SERVICE_USER" -- "$INSTALL_DIR/.venv/bin/python" -m pip install --upgrade pip platformio 'esptool>=4.8,<5'

printf '\n[5/6] Writing environment and systemd service...\n'
if [[ ! -e "$ENV_FILE" ]]; then
  TOKEN="$(openssl rand -hex 24)"
  cat > "$ENV_FILE" <<ENVIRONMENT
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
MAX_CONCURRENT_BUILDS=2
DATA_DIR=$DATA_DIR
PROJECT_PATH=$INSTALL_DIR/spaces
BROWSE_ROOTS=$INSTALL_DIR,/home,/dev/shm
PIO_COMMAND=$INSTALL_DIR/.venv/bin/pio
ESPTOOL_COMMAND=$INSTALL_DIR/.venv/bin/esptool.py
AVRDUDE_COMMAND=/usr/bin/avrdude
COMPILEZ_TOKEN=$TOKEN
ENVIRONMENT
  unset TOKEN
fi
chown "root:$SERVICE_GROUP" "$ENV_FILE"
chmod 0640 "$ENV_FILE"

cat > /etc/systemd/system/compilez.service <<SERVICE
[Unit]
Description=CompileZ local network compiler dashboard
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
User=$SERVICE_USER
Group=$SERVICE_GROUP
WorkingDirectory=$INSTALL_DIR
EnvironmentFile=$ENV_FILE
Environment="PATH=$INSTALL_DIR/.venv/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
ExecStart=/usr/bin/node $INSTALL_DIR/server.js
Restart=on-failure
RestartSec=3
KillMode=control-group
KillSignal=SIGTERM
TimeoutStopSec=15
UMask=0027
NoNewPrivileges=true
Nice=-10
CPUWeight=10000
IOWeight=1000
IOSchedulingClass=best-effort
IOSchedulingPriority=0
LimitNOFILE=infinity
LimitMEMLOCK=infinity
LimitNPROC=infinity
TasksMax=infinity
MemoryMax=infinity
StandardOutput=journal
StandardError=journal
SyslogIdentifier=compilez

[Install]
WantedBy=multi-user.target
SERVICE

printf '\n[6/6] Enabling and starting CompileZ...\n'
systemctl daemon-reload
systemctl enable compilez.service
systemctl restart compilez.service
systemctl --no-pager --full status compilez.service
printf '\nCompileZ is running at http://<NUC-IP>:3000\n'
printf 'Login username: compilez\n'
printf 'Read COMPILEZ_TOKEN locally from %s for the password.\n' "$ENV_FILE"
printf 'Config: %s | Logs: journalctl -u compilez -f\n' "$ENV_FILE"
printf 'Allow TCP port 3000 only on your trusted LAN. Use HTTPS for untrusted networks.\n'