# Heavy ESP32 build workload

A real PlatformIO Arduino project for `esp32dev`, intended to load the compiler rather than add artificial build delays. No upload or connected ESP32 is required to compile it.

## Generate and build

From the CompileZ repository root:

```bash
npm run example:heavy
pio run --project-dir example-heavy-project
```

Or select this project's absolute server path in CompileZ, enter a build name, and compile **after generating the sources**. The generator needs only Node.js. PlatformIO, the ESP32 platform, and libraries are installed separately; the Debian installer already installs PlatformIO. Allow several GB of free disk space for SDK extraction, packages, object files, and each project's build directory. First-time dependency downloads need internet access and should not be included in a compile-speed benchmark.

The default generator creates **192 `.cpp`/`.h` pairs**, plus a registry, containing **12,288 distinct math functions** and approximately **33 MB of source**. Generated files are intentionally ignored by Git; rerun the generator after cloning. It uses a seeded PRNG, so results are repeatable. It leaves unchanged files untouched, preserving normal incremental builds.

Each translation unit includes substantial C++ standard headers and compiles many externally visible, non-inlined floating-point math functions at `-O2`. The registry references four functions per unit; the linker discards the remaining unused function sections so the result can fit the ESP32 flash partition. Compilation still parses, optimizes, and emits those functions. There are no compiler sleeps or minimum-duration timers.

`platformio.ini` pins the ESP32 platform and ArduinoJson, TFT_eSPI, and FastLED. WiFi and WebServer come with the ESP32 Arduino framework and do **not** belong in `lib_deps`. The entry point uses these libraries and the generated registry. Display and LED hardware are not initialized, and WiFi is disabled by default. This is a compiler benchmark, not a ready-to-use display/server application.

## Target a 15-30 second full build

Exact duration depends on CPU, compiler jobs, disk, library cache, thermals, and concurrent builds. **15-30 seconds is a calibration target, not a guaranteed duration.** On the NUC, measure a full build after packages have already downloaded:

```bash
pio run --project-dir example-heavy-project --target clean
time pio run --project-dir example-heavy-project
```

If it finishes too quickly, increase translation units or function complexity:

```bash
npm run example:heavy -- --units 320 --functions 96 --operations 64 --seed 2027
```

If it takes too long, start smaller:

```bash
npm run example:heavy -- --units 96 --functions 32 --operations 32
```

Changing `--seed` changes every math unit and triggers real recompilation on the next build while retaining downloaded packages and library caches. Repeating the same generator options does not force a rebuild. Use a new seed or PlatformIO's clean target before every full-load measurement. `--units` allows 1-512, `--functions` 1-256, and `--operations` 1-256; extreme combinations can generate very large projects.

## Test concurrent users

CompileZ intentionally serializes builds of the **same canonical directory**, because their `.pio` objects and firmware outputs would otherwise collide. To exercise five workers, generate five independent directories:

```bash
npm run example:heavy -- --copies 5
```

This prepares the base project and:

```text
example-heavy-project/copies/worker-01/
example-heavy-project/copies/worker-02/
example-heavy-project/copies/worker-03/
example-heavy-project/copies/worker-04/
example-heavy-project/copies/worker-05/
```

Each copy has its own config, sources, seed, `.pio` directory, and firmware. Copies and generated sources are ignored by Git. Regeneration overwrites generated math files; `--copies` also refreshes the copied config and entry point, so keep your own experiments elsewhere.

Set the running server's `MAX_CONCURRENT_BUILDS=5` and restart it when no jobs are active. For systemd, edit `/etc/compilez.env`, not `.env.example`. For a local server:

```bash
MAX_CONCURRENT_BUILDS=5 npm start
```

Multiple browser clients can select different worker directories and submit named builds. The global selected path is shared, but every submitted build captures its own path. Existing jobs do not switch directories when another client browses elsewhere. Select each Build ID in the queue to inspect its independent log stream and download.

Before a simultaneous timing run, warm the shared PlatformIO package cache with one successful build; concurrent first-ever package installations are not a clean compiler benchmark. PlatformIO itself may serialize shared package-manager work. Five firmware builds can also start many compiler subprocesses each, so monitor RAM and disk; 32 GB is substantial but not unlimited. More workers do not automatically make an individual build faster.

## Verification

The automated server test submits twelve builds simultaneously across five workers with three Socket.IO clients. It verifies bounded concurrency, unique IDs, API responsiveness, per-ID stdout/stderr isolation, successful artifact contents, one cancellation, one failure, and all-client completion updates. The generator is tested for deterministic output, incremental behavior, tuning, and stale-unit cleanup; generated C++ also passes a host compiler syntax check.

Full ESP32 compilation and NUC timing must be measured on a machine with sufficient SDK disk space. In the development environment, ESP32 SDK extraction exhausted available disk space before compilation, so no successful cross-compile or 15-30 second timing result is claimed.