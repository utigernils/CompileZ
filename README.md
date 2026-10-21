# CompileZ

A shared, self-hosted firmware build station for a local-network Intel NUC. Express runs the compiler processes; Socket.IO synchronizes the project path, queue, build status, per-build output, and hardware telemetry. The vanilla frontend uses locally compiled Tailwind CSS, Lucide icons, Space Grotesk, and IBM Plex Mono. No CDN or internet connection is required to use the installed dashboard.

## Run locally

Use Node.js 22 LTS or newer:

```bash
npm ci
npm start
```

Open **http://localhost:3000** or **http://<server-LAN-IP>:3000**. The included `examples/signal-node` project runs immediately and creates a 64 KB test `.bin`. It is a reference binary pipeline, not flashable device firmware. There are no fabricated builds or hardware readings in the dashboard.

## Build your project

Browse the **server's** filesystem or enter an absolute path, then enter a required **Build name** before clicking Compile. Names are trimmed and limited to 100 characters. The server also rejects missing names, including requests sent outside the UI. Pressing Enter submits the same validated form. Paths are validated against `BROWSE_ROOTS`, including symlink resolution. The path is synchronized when committed by changing focus, selecting a directory, or submitting a build. A remote path update is authoritative, including while another client is editing.

- A project with `platformio.ini` runs `pio run` (takes precedence).
- Otherwise a project with `compile.sh` runs `/bin/bash compile.sh` in that directory.
- Other directories remain browsable but cannot be compiled.
- Scripts must run in the foreground and exit nonzero when compilation fails. Do not daemonize the compiler. For a custom toolchain, put its command in `compile.sh`.
- Two workers run concurrently by default. Each build snapshots its project directory at submission. Builds for the **same canonical directory** are serialized to prevent shared output collisions; different directories run in parallel.
- Stop terminates only that build's process group with `SIGTERM`, escalating to `SIGKILL` after 2.5 seconds. Cancelling a queued build does not affect a worker.
- Output is kept per build and streamed independently. Selecting a build changes only your local terminal view. A reconnect retrieves the latest shared state and the selected build's log tail.
- History shows the custom name, local start timestamp, and elapsed duration. Exact start/end timestamps are stored as UTC ISO timestamps and available in the timestamp tooltip and state API. Queued builds show "Not started" until a worker starts them.
- The trash icon deletes a finished build after confirmation, removing its logs and copied firmware from all clients. Running and queued builds cannot be deleted; cancel them first. Deleting history never subtracts from all-time statistics.

### All-time statistics

The **Dashboard** and **Stats** tabs switch your local view without interrupting builds. Every client receives updated global statistics when builds finish. Metrics include total builds, cumulative build time, longest and average build time, successful/failed counts and percentages, and the most compiled canonical project directory.

Statistics are written atomically to `stats.json` in `DATA_DIR` (normally `.data/stats.json`, or `/var/lib/compilez/stats.json` under systemd). This file is independent of the 50-entry history, so totals survive history deletion, pruning, and restart. On first upgrade, retained finished history is imported once; builds that were already deleted or pruned before this feature cannot be recovered. Old entries use their project name until new named builds are submitted.

Total builds counts finished attempts, including cancelled and interrupted builds. Time excludes queue wait and sums each attempt's start-to-finish elapsed time; a build cancelled before starting contributes zero time. Average time is cumulative time divided by total finished attempts. Success/failure percentages use only successful and failed attempts, with cancelled/interrupted counts shown separately. Interrupted builds use the recovery timestamp as their recorded end because the exact interruption time cannot be recovered after an abrupt outage. The most compiled project counts finished attempts, with ties resolved by path order. Malformed statistics files stop startup rather than silently resetting all-time data; preserve and repair the file if that happens.

### Edit compiler config

The **Compiler config** editor loads `platformio.ini` from the globally selected project directory. A missing file opens an empty editor; selecting a directory never creates a file by itself. **SAVE CONFIG** atomically writes the raw text to that project's file, confirms the save, and broadcasts the saved text to every connected client viewing that project. Unsaved typing stays local. A shared project change, reconnect, or another client's save replaces local unsaved text with the authoritative file and shows a notification.

Files are limited to 64 KB and config symlinks are rejected. Saves include the revision originally loaded, so simultaneous or externally modified files cannot be silently overwritten; use the reload icon to retrieve the latest file after a conflict. Saving does not restart an active build. Creating `platformio.ini` in a script-only project switches future builds to PlatformIO, as described above.

Downloads are copied into build-ID-specific storage before the next same-directory build starts. Firmware is discovered at `firmware.bin`, `build/firmware.bin`, `dist/firmware.bin`, or `.pio/build/<environment>/firmware.bin`. Successful builds without firmware remain completed but have no download. Old firmware and firmware symlinked outside the project are not offered. With multiple PlatformIO environments, the most recently modified firmware is selected; use separate project directories when separate environment artifacts are required.

The queue is capped at 32 outstanding jobs. The last 50 builds and up to 400 output chunks (8 KB each) per build persist to disk; large output chunks are truncated. This is a bounded terminal tail, not an unlimited audit log. Entries dropped from history also lose their stored artifact. On restart, unfinished builds become `interrupted` and are not silently rerun. History writes are atomic and debounced, so an abrupt power failure can lose the most recent update.

## Debian 12 installation

On the NUC, from this project directory:

```bash
sudo bash setup.sh
```

The installer installs system build dependencies, Node.js 22/npm, and PlatformIO in a Python virtual environment. It deploys the application to `/opt/compilez`, runs `npm ci` (or `npm install` without a lockfile), builds local CSS, creates `/etc/compilez.env`, then creates, enables, and starts `compilez.service`.

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
| `PROJECT_PATH` | bundled example | Initial project on first start |
| `BROWSE_ROOTS` | application directory, `/home`, `/dev/shm` | Comma-separated allowed existing directories |
| `MAX_CONCURRENT_BUILDS` | `2` | 1 to 16 workers; same-path builds still serialize |
| `DATA_DIR` | `.data` in application directory | History and copied firmware |
| `PIO_COMMAND` | `pio` | PlatformIO executable, no shell arguments |
| `COMPILEZ_TOKEN` | unset in local development | Optional HTTP Basic password; username `compilez` |

The previously selected path is restored from history when still allowed. Environment variables must be exported to Node; `.env.example` is a reference, not automatically loaded. For local development with a configuration file, use `node --env-file=.env server.js` on Node 22. The systemd installation reads `/etc/compilez.env` instead.

## Security boundary

**This is a trusted-code execution service, not a compiler sandbox.** Anyone with dashboard access can execute a selected project's build script with the service account's permissions. Directory restrictions limit the picker and submitted working directories, not what compiler scripts can read/write. Review projects before building and do not expose the service to the internet. Direct `npm start` has no authentication unless `COMPILEZ_TOKEN` is set. Installed deployments enable authentication by default. HTTP Basic credentials need HTTPS outside a trusted network; use a TLS reverse proxy for such access. Same-origin checks protect browser mutations and Socket.IO connections; they are not a replacement for authentication. Do not run the service as root.

## Development and checks

```bash
npm test
npm run check
npm run build:css
npm audit
```

`npm run dev` restarts Node on backend edits. Run `npm run build:css` after changing frontend classes or CSS. Tests use temporary directories, real child processes, and two Socket.IO clients. The installer requires root, network access, APT, and systemd; syntax validation does not substitute for testing deployment on an actual Debian NUC.

## Structure

```text
server.js                    Express, Socket.IO, compiler workers, telemetry
public/index.html            Dashboard and dialogs
public/app.js                Real-time vanilla frontend
public/styles.css            Tailwind source and dashboard styling
public/fonts/                Self-hosted fonts and licenses
examples/signal-node/        Runnable reference binary pipeline
test/server.test.js          Server integration tests
setup.sh                     Debian provisioning and systemd setup
.env.example                 Environment reference
```