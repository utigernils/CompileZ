# CompileZ

A self-hosted firmware build and USB flash station for a local-network Intel NUC. Project selection is private to each browser tab. Socket.IO synchronizes build history, build-ID-specific output, upload jobs, hardware telemetry, and all-time statistics. Successful firmware is permanently archived independently of history. The frontend uses locally compiled Tailwind CSS, Lucide icons, and locally hosted fonts.

## Run locally

Use Node.js 22 LTS or newer:

```bash
npm ci
npm start
```

Open **http://localhost:3000** or **http://<server-LAN-IP>:3000**. No example projects are bundled. Select your own server-side project directory. The initial browser location is `PROJECT_PATH`, or the first allowed browse root; it need not itself be a buildable project.

Local PlatformIO builds also need PlatformIO installed. One option is:

```bash
python3 -m venv .venv
.venv/bin/python -m pip install platformio
PIO_COMMAND="$PWD/.venv/bin/pio" npm start
```

The Debian installer configures this executable automatically. A compiler installation and several GB of free disk space are needed for the initial ESP32 SDK/toolchain download.

## Set Up Your Firmware Project

### Create a server directory

After installing CompileZ with `setup.sh`, create a project owned by the service account. Run these commands on the NUC with an account permitted to use `sudo`:

```bash
SERVICE_USER="$(systemctl show compilez.service -p User --value)"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"
sudo install -d -o "$SERVICE_USER" -g "$SERVICE_GROUP" -m 0750 \
	/opt/compilez/spaces/nils/src
sudo -u "$SERVICE_USER" /opt/compilez/.venv/bin/pio project init \
	--project-dir /opt/compilez/spaces/nils \
	--board esp32dev --project-option 'framework=arduino'
```

Alternatively, copy or clone your existing firmware project into a server directory. It must contain `platformio.ini` at its root and sources such as `src/main.cpp`. The service account must have read, write, and directory-traversal permissions; building creates `.pio` directories inside the project. Do not use `chmod 777` or run CompileZ as root.

The default installer permits `/opt/compilez`, `/home`, and `/dev/shm`. For a project elsewhere, add its parent to `BROWSE_ROOTS` in `/etc/compilez.env` and restart the service. Use persistent storage for source projects; `/dev/shm` is temporary and disappears after reboot.

### Configure PlatformIO

Select `/opt/compilez/spaces/nils` in CompileZ's directory picker. The **Compiler config** editor opens that directory's `platformio.ini`. A minimal ESP32 Arduino configuration is:

```ini
[env:esp32dev]
platform = espressif32
board = esp32dev
framework = arduino
monitor_speed = 115200
lib_deps =
	bblanchon/ArduinoJson@7.4.2
```

Adjust the board, platform version, and libraries for your hardware, then click **SAVE CONFIG**. PlatformIO downloads the platform, toolchain, Arduino framework, and declared `lib_deps` on first use. ESP32 WiFi and WebServer are framework libraries and do not need separate `lib_deps` entries. `#include` directives do not reliably install arbitrary missing libraries; declare external dependencies explicitly.

The project layout should look like:

```text
/opt/compilez/spaces/nils/
	platformio.ini
	src/
		main.cpp
	include/                 optional project headers
	lib/                     optional local libraries
```

Add your application code to `src/main.cpp` using Git, your editor, SCP, or rsync. The dashboard edits compiler configuration, not C++ source files. A minimal source for checking the setup is:

```cpp
#include <Arduino.h>

void setup() {
	Serial.begin(115200);
}

void loop() {
	Serial.println("Firmware running");
	delay(1000);
}
```

### Build and download

Enter a build name, click **COMPILE**, and inspect the output for that Build ID. A successful firmware-producing build gets a firmware download link. No board needs to be connected to compile. Use the **Flash** tab to upload a previously saved image to a USB-connected board; compiling never automatically flashes a device.

## Flash saved firmware

The **Flash** tab uploads archived images directly from the **compiler machine**, not through browser Web Serial. USB discovery currently supports Linux `/dev/ttyUSB*` and `/dev/ttyACM*` devices. Connect the board with a data-capable cable, refresh the USB selector, then select saved firmware and its matching upload tool. The saved-image selector includes binaries from builds whose history was deleted or pruned. Firmware/USB selection and form edits stay local to your browser; upload jobs and output are shared.

- **ESP / esptool:** choose the chip (`auto`, `esp8266`, `esp32`, `esp32s3`, etc.), baud rate, image layout and offset. Merged images default to `0x0`; verify the image's intended base address. Unmerged or legacy images require an explicit layout/offset selection. A normal ESP32 `firmware.bin` is usually application-only at `0x10000` and cannot provision a blank board without matching bootloader/partition data. ESP8266 images usually start at `0x0`. The layout selector does **not** merge or convert images; CompileZ archives merged binaries if your project produces one.
- **Arduino AVR / avrdude:** choose the AVR part, serial bootloader/programmer and baud. Uno: `m328p` / `arduino` / `115200`; older Nano bootloader: `m328p` / `arduino` / `57600`; Mega: `m2560` / `wiring` / `115200`. `.hex` archives are read as Intel HEX and `.bin` as raw binary. Flash memory is written and verified; fuses and EEPROM are not changed. Non-AVR Arduino families (such as SAMD, RP2040 and Renesas) are not supported by this mode.
- **Additional parameters:** esptool accepts `--before`, `--after`, `--connect-attempts`, `--spi-connection`, `--flash_mode`, `--flash_freq`, `--flash_size`, `--compress` and `--no-compress`. Example: `--before default_reset --after hard_reset --flash_mode dio --flash_freq 40m --flash_size detect`. Values can be space-separated or use `--option=value`. AVR accepts `-v`, `-D`, `-B <bitclock>` and `-i <delay>`. Parameters are validated arguments, not shell commands; arbitrary commands, additional images, memory/fuse writes and overrides of dedicated fields are rejected.
- ESP uploads always attempt the RAM stub first. A failed attempt retries **once** with `--no-stub`. Missing executables, process termination, cancellation and shutdown do not trigger a retry. A second failure is shown explicitly in the upload output.
- Only one upload runs at a time across all clients, independently of compiler workers. Close other serial monitors/tools first. Confirm the selected image, port, board and offset before overwriting firmware. Hold BOOT/reset into the bootloader if your board cannot enter it automatically.
- **Stop** terminates the upload process group, escalating after 2.5 seconds. Uploads have a ten-minute timeout. A stopped, failed or interrupted upload can leave incomplete firmware: reflash before using the device. Do not disconnect USB during an upload.

The latest ten upload jobs, with up to 400 log chunks (8 KB each), are saved alongside build history. Restarted active uploads become `interrupted` and are never resumed automatically. These jobs do not affect build statistics.

### Upload tools and USB permissions

Rerunning the Debian installer installs esptool 4.x and avrdude, adds the service account to `dialout`, and restarts the service. For an existing manual Linux installation:

```bash
.venv/bin/python -m pip install 'esptool>=4.8,<5'
sudo apt-get install avrdude
# Replace compilez with the actual account running the server.
sudo usermod -a -G dialout compilez
```

Restart the service (or log out/in for an interactive account) after changing groups. Export `ESPTOOL_COMMAND="$PWD/.venv/bin/esptool.py"` when running locally with that virtual environment. `AVRDUDE_COMMAND` defaults to `avrdude` on the server's PATH. esptool 4.x is required for the supported underscore-style command/parameter names; do not point this setting at an incompatible CLI. Permission errors are reported before starting an upload. Some boards need vendor-specific udev rules; do not fix permissions with `chmod 777` or run the service as root.

## Build your project

Browse the **server's** filesystem or enter an absolute path, then enter a required **Build name** before clicking Compile. Names are trimmed and limited to 100 characters. Selection is stored in this tab's session storage and is never broadcast to other users or tabs. Reloading the same tab restores its path if still valid. Every build request explicitly captures the selected canonical path. Selecting or building another project cannot redirect someone else's current or future submissions.

- A project with `platformio.ini` runs `pio run --target clean`, then `pio run` on every submission, even when the code is unchanged. A failed or cancelled clean phase does not start compilation. No manual clean command is needed. This forces real recompilation instead of reusing incremental objects; downloaded dependencies remain cached. Compilation can still fail because of source errors, permissions, missing tools, disk space, or network problems.
- Otherwise a project with `compile.sh` runs `/bin/bash compile.sh` in that directory.
- Other directories remain browsable but cannot be compiled.
- Scripts must run in the foreground and exit nonzero when compilation fails. Do not daemonize the compiler. For a custom toolchain, put its commands in `compile.sh`. CompileZ runs that script on every request and sets `COMPILEZ_CLEAN_BUILD=1`; the script must implement its toolchain's clean/rebuild command itself because arbitrary script output directories cannot be safely guessed.
- Two workers run concurrently by default. Each build snapshots its project directory at submission. Builds for the **same canonical directory** are serialized to prevent shared output collisions; different directories run in parallel.
- Stop terminates only that build's process group with `SIGTERM`, escalating to `SIGKILL` after 2.5 seconds. Cancelling a queued build does not affect a worker.
- Output is kept per build and streamed independently. Selecting a build changes only your local terminal view. A reconnect retrieves the latest shared state and the selected build's log tail.
- History shows the custom name, local start timestamp, and elapsed duration. Exact start/end timestamps are stored as UTC ISO timestamps and available in the timestamp tooltip and state API. Queued builds show "Not started" until a worker starts them.
- The trash icon deletes a finished history entry and its logs, but **does not delete saved firmware or statistics**. Running and queued builds cannot be deleted; cancel them first.

### All-time statistics

The **Compile**, **Flash** and **Stats** tabs switch your local view without interrupting builds or uploads. Every client receives updated global statistics when builds finish. Metrics include total builds, cumulative build time, longest and average build time, successful/failed counts and percentages, and the most compiled canonical project directory.

Statistics are written atomically to `stats.json` in `DATA_DIR` (normally `.data/stats.json`, or `/var/lib/compilez/stats.json` under systemd). This file is independent of the 50-entry history, so totals survive history deletion, pruning, and restart. On first upgrade, retained finished history is imported once; builds that were already deleted or pruned before this feature cannot be recovered. Old entries use their project name until new named builds are submitted.

Total builds counts finished attempts, including cancelled and interrupted builds. Time excludes queue wait and sums each attempt's start-to-finish elapsed time; a build cancelled before starting contributes zero time. Average time is cumulative time divided by total finished attempts. Success/failure percentages use only successful and failed attempts, with cancelled/interrupted counts shown separately. Interrupted builds use the recovery timestamp as their recorded end because the exact interruption time cannot be recovered after an abrupt outage. The most compiled project counts finished attempts, with ties resolved by path order. Malformed statistics files stop startup rather than silently resetting all-time data; preserve and repair the file if that happens.

### Edit compiler config

The **Compiler config** editor loads `platformio.ini` from your tab's selected directory. A missing file opens an empty editor; selecting a directory never creates a file by itself. **SAVE CONFIG** atomically writes the raw text to that project's file. Other users viewing the **same directory** see the saved contents, since it is the same physical file; users viewing other directories keep their own selection and text. Unsaved typing stays local. Changing your own project, reconnecting, or another client's save to the same project replaces unsaved text with the authoritative file and shows a notification.

Files are limited to 64 KB and config symlinks are rejected. Saves include the revision originally loaded, so simultaneous or externally modified files cannot be silently overwritten; use the reload icon to retrieve the latest file after a conflict. Saving does not restart an active build. Creating `platformio.ini` in a script-only project switches future builds to PlatformIO, as described above.

### Saved firmware and storage

Every successful firmware-producing build gets an independent archived copy before the next build for that directory starts. Firmware is discovered in the project root, `build/`, `dist/`, or `.pio/build/<environment>/`. Supported names are `firmware.bin`, `firmware.hex`, `firmware.merged.bin`, `merged-flash.bin` and `merged.bin`. The newest matching file is archived, preferring merged images on equal modification times. A valid successful build's image is not rejected merely because its modification time is old. Symlinks outside the project are still rejected. With multiple environments, use separate projects if you need individually selectable environment artifacts. Successful builds that produce no supported firmware image have no download. Existing archives are not automatically converted to merged images.

With the default systemd installation:

```text
/opt/compilez/spaces/nils/.pio/build/esp32dev/firmware.bin  current project output
/var/lib/compilez/artifacts/<Build-ID>.bin                permanent build copy
/var/lib/compilez/artifacts/<Build-ID>.json               archive metadata
```

Local development uses `.data/artifacts/` unless `DATA_DIR` is set. AVR archives retain the `.hex` extension instead of `.bin`. Rebuilding can replace or clean the project's `.pio` output, but not the archived Build-ID copies. **Old binaries remain saved when history entries are deleted, pruned, or the server restarts.** Open **Stats > Saved firmware** to download them or **Flash** to upload them even after they disappear from the build queue. Existing `.bin`/`.hex` files without metadata are also listed by ID. Files already deleted by older releases cannot be recovered by this update.

There is no automatic archive expiry. Back up `DATA_DIR` and monitor free disk space. Only an administrator manually removing archive files deletes them. The archive is shared with authorized dashboard users, not private per-user storage.

The queue is capped at 32 outstanding jobs. The last 50 builds and up to 400 output chunks (8 KB each) per build persist to disk; large output chunks are truncated. This bounds history/logs only, not the firmware archive. On restart, unfinished builds become `interrupted` and are not silently rerun. History writes are atomic and debounced, so an abrupt power failure can lose the most recent update.

## Debian 12 installation

On the NUC, from this project directory:

```bash
sudo bash setup.sh
```

The installer installs system build dependencies, avrdude, Node.js 22/npm, and PlatformIO plus esptool 4.x in a Python virtual environment. It grants the service account `dialout` membership for USB serial access. It deploys the application to `/opt/compilez`, runs `npm ci` (or `npm install` without a lockfile), builds local CSS, creates `/etc/compilez.env`, then creates, enables, and starts `compilez.service`.

The service runs as the invoking `sudo` user, or a dedicated `compilez` user when installed directly as root. Override with `sudo COMPILEZ_USER=builder bash setup.sh`. That account needs read/write/traverse access to the selected projects and their parent directories. The installer does not change ownership of your project directories. Rerunning setup preserves the environment file and build history. `INSTALL_DIR` may specify a dedicated installation directory without spaces.

Authentication is enabled by the installer with a random password stored in `/etc/compilez.env`. Log in as **compilez**, using the `COMPILEZ_TOKEN` value as the password. Read it directly on the server; do not put credentials into URLs. Restart the service after editing this file:

```bash
sudo systemctl restart compilez
sudo systemctl status compilez
sudo journalctl -u compilez -f
```

Open **http://<NUC-IP>:3000**. Allow TCP port 3000 only from your trusted LAN if a firewall is enabled. The installer does not change firewall rules. PlatformIO may need internet access on first use to download a project's toolchain and dependencies. CPU temperature displays `--` when the NUC/kernel does not expose a usable sensor; it is never invented. Telemetry is sampled every two seconds.

### Resource tuning

The generated service includes `Nice=-10`, `CPUWeight=10000`, `IOWeight=1000`, best-effort I/O priority 0, `LimitNOFILE=infinity`, `LimitMEMLOCK=infinity`, `LimitNPROC=infinity`, `TasksMax=infinity`, and `MemoryMax=infinity`. Compiler children inherit the service's priority and limits. Kernel and hardware limits still apply. These settings remove service-level resource ceilings but cannot guarantee the fastest possible compilation; toolchain parallelism, thermals, disk, RAM, and competing workloads matter. Start with two workers and adjust to the NUC's RAM and CPU capacity.

Real-time scheduling (`rr`) is intentionally not used: it can starve essential services. High CPU/I/O priority and unlimited memory can still reduce responsiveness or trigger the OOM killer under load. Lower priority, worker count, or resource limits for a multi-purpose server.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Listen interface |
| `PORT` | `3000` | HTTP and Socket.IO port |
| `PROJECT_PATH` | first browse root | Initial location for tabs with no saved selection; installer uses `/opt/compilez/spaces` |
| `BROWSE_ROOTS` | application directory, `/home`, `/dev/shm` | Comma-separated allowed existing directories |
| `MAX_CONCURRENT_BUILDS` | `2` | 1 to 16 workers; same-path builds still serialize |
| `DATA_DIR` | `.data` in application directory | History and copied firmware |
| `PIO_COMMAND` | `pio` | PlatformIO executable, no shell arguments |
| `ESPTOOL_COMMAND` | `esptool.py` | esptool 4.x executable for ESP uploads, no shell arguments |
| `AVRDUDE_COMMAND` | `avrdude` | AVR uploader executable, no shell arguments |
| `COMPILEZ_TOKEN` | unset in local development | Optional HTTP Basic password; username `compilez` |

Selections are never restored from shared server history. `PROJECT_PATH` provides only a default; a tab's own valid saved path takes precedence. An unavailable default falls back to the first browse root. Environment variables must be exported to Node; `.env.example` is a reference, not automatically loaded. For local development with a configuration file, use `node --env-file=.env server.js` on Node 22. The systemd installation reads `/etc/compilez.env` instead. Existing installations keep their environment file on upgrade; replace old defaults pointing at removed projects with your real project or `/opt/compilez/spaces`.

If a build reports `spawn pio ENOENT`, verify `/opt/compilez/.venv/bin/pio --version` and set `PIO_COMMAND=/opt/compilez/.venv/bin/pio` in the actual service environment. Restart the service after changing environment variables. A shell's `PATH` may differ from systemd's.

## Security boundary

**This is a trusted-code execution service, not a compiler sandbox.** Anyone with dashboard access can execute a selected project's build script with the service account's permissions, and can overwrite firmware on connected USB serial devices. Directory restrictions limit the picker and submitted working directories, not what compiler scripts can read/write. Review projects and firmware before building/flashing and do not expose the service to the internet. Direct `npm start` has no authentication unless `COMPILEZ_TOKEN` is set. Installed deployments enable authentication by default. HTTP Basic credentials need HTTPS outside a trusted network; use a TLS reverse proxy for such access. Same-origin checks protect browser mutations and Socket.IO connections; they are not a replacement for authentication. Do not run the service as root.

## Development and checks

```bash
npm test
npm run check
npm run build:css
npm audit
```

`npm run dev` restarts Node on backend edits. Run `npm run build:css` after changing frontend classes or CSS. Tests use temporary directories, real child processes, and multiple Socket.IO clients. The concurrency stress test submits twelve builds simultaneously to five workers, checks per-Build-ID stdout/stderr and firmware isolation on three clients, cancels one job, and lets another fail without stopping the others. The installer requires root, network access, APT, and systemd; syntax validation does not substitute for testing deployment on an actual Debian NUC.

## Structure

```text
server.js                    Express, Socket.IO, compiler workers, telemetry
public/index.html            Dashboard and dialogs
public/app.js                Real-time vanilla frontend
public/styles.css            Tailwind source and dashboard styling
public/fonts/                Self-hosted fonts and licenses
test/server.test.js          Server integration tests
setup.sh                     Debian provisioning and systemd setup
.env.example                 Environment reference
```