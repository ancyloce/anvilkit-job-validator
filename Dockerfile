# anvilkit-validator: the trusted validator Job image (delivery.md P10d, P0.8).
# DEVELOPMENT_ONLY: it carries the reviewed fixed component, the profiles,
# the protected host fixtures, the prebuilt host bundles, the locked
# toolchain and the pinned Playwright Chromium headless shell; it runs the
# chain on that fixed source or, only under a Job profile that binds source,
# on the launch's source archive. The trusted process starts as UID 0 in its
# container with SETUID, SETGID and SETPCAP only (the harness Job template)
# and runs the build, the SSR render child and the browser steps as UID
# 10001 and the protected SSR harness as UID 10003 through setpriv (numeric
# UIDs; 10003 needs no passwd entry); the stop of every step runs /bin/sh's
# kill builtin under each step UID. The browser step is Playwright's headless
# shell, every request answered by the worker itself.
#
# Debian rather than Alpine: Playwright ships its Chromium builds for glibc
# distributions only, and the pinned Playwright installs the exact build it
# was released with together with its system dependencies (--with-deps).
#
# Build contexts: this directory, plus the contracts sources as a named
# context (the schemas the Job validates its own outputs against):
#   docker build --build-context contracts=../../contracts -t anvilkit-validator .
FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de AS build
WORKDIR /src
RUN npm install -g pnpm@12.3.4
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.build.json ./
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY src ./src
RUN pnpm run build
# The host bundles (one React, one ReactDOM, one Puck, the compiled protected
# host script), built here by trusted code from this locked install: the
# image's filesystem is read-only, so the trusted process must find them
# built for exactly these profiles, this host script and this toolchain.
COPY profiles ./profiles
COPY fixtures/host ./fixtures/host
COPY --from=contracts components/component.schema.json /anvilkit/contracts/components/component.schema.json
COPY --from=contracts jobs/job.schema.json /anvilkit/contracts/jobs/job.schema.json
RUN ANVILKIT_VALIDATOR_CONTRACTS_DIR=/anvilkit/contracts node dist/host-bundles.js
# The launch's own Job profile (B-21): the Job reads profileId, jobKind,
# candidateCode and bindsSource of the validator profiles from
# jobs/profiles.json. The image carries that projection, never the document
# itself: its image digests pin this very image, so embedding them would
# change the image every time it is re-pinned.
COPY --from=contracts jobs/profiles.json /tmp/contracts-profiles.json
RUN node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=d.profiles.filter((x)=>x.jobKind==="validator").map((x)=>Object.assign({profileId:x.profileId,jobKind:x.jobKind,candidateCode:x.candidateCode},x.bindsSource===undefined?{}:{bindsSource:x.bindsSource}));process.stdout.write(JSON.stringify({schemaVersion:d.schemaVersion,profiles:p})+"\n")' < /tmp/contracts-profiles.json > /src/job-profiles.json

FROM node:24.19.0-trixie-slim@sha256:ab3eebe934147fee049b5eb83c570f68c849a13c930bdfa482de99fcdfa3b3de
# Debian 13 (P0.8, AC7): bookworm's sqlite, zlib, glib and perl-base
# findings had no fixed version there; perl-base is upgraded to the fixed
# point release (CVE-2026-13221/42496/8376), pinned. libxml2's
# CVE-2026-6653 has no fixed version in Debian 13; it arrives through
# Chromium's libgbm1 -> mesa-libgallium -> libllvm19 and stays a recorded
# finding. The Job runs node and the baked toolchain only: the base's
# package managers (npm with its bundled tar, npx, corepack, yarn) are
# removed, nothing installs at run time.
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux ca-certificates \
 && apt-get install -y --no-install-recommends --only-upgrade perl-base=5.40.1-6+deb13u1 \
 && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-* \
 && groupadd -g 10001 candidate && useradd -M -u 10001 -g 10001 -s /usr/sbin/nologin candidate \
 && mkdir -p /anvilkit/validator /anvilkit/contracts/components /anvilkit/contracts/jobs /anvilkit/verdict /workspace /run/anvilkit /etc/anvilkit/anvilkit-validator
WORKDIR /anvilkit/validator
COPY --from=build /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist
COPY --from=build /src/fixtures/host/browser/dist ./fixtures/host/browser/dist
COPY package.json ./package.json
COPY profiles ./profiles
COPY fixtures/host/ssr.mjs ./fixtures/host/ssr.mjs
COPY fixtures/host/browser/index.html fixtures/host/browser/host.tsx fixtures/host/browser/observer.js ./fixtures/host/browser/
COPY fixtures/component/hero ./fixtures/component/hero
COPY --from=contracts components/component.schema.json /anvilkit/contracts/components/component.schema.json
COPY --from=contracts jobs/job.schema.json /anvilkit/contracts/jobs/job.schema.json
COPY --from=build /src/job-profiles.json /anvilkit/contracts/jobs/profiles.json
COPY --chmod=0600 config.yaml /etc/anvilkit/anvilkit-validator/config.yaml
# The browser of the host check: the Chromium headless shell of exactly this
# Playwright release with its system dependencies, under a root-owned,
# world-readable directory the step identity can execute (the step's own
# HOME and TMPDIR are a scratch directory nothing is read from). Chromium's
# own sandbox runs wherever the runtime gives the step identity a user
# namespace; the development foundation's seccomp profile does not, and the
# browser report then records that it ran without (G-04).
ENV PLAYWRIGHT_BROWSERS_PATH=/anvilkit/ms-playwright
RUN ./node_modules/.bin/playwright install --with-deps --only-shell chromium \
 && rm -rf /var/lib/apt/lists/* \
 && chmod -R a+rX /anvilkit/ms-playwright
# The candidate identity reads the toolchain, the browser and the protected
# host fixtures it executes (root-owned, unwritable; their digests are
# pinned by the validator profile and rechecked before and after every run);
# the reviewed source, the profiles, the contracts and the configuration are
# root-only, and the build step sees the source only through the trusted
# staged copy.
RUN chmod -R a+rX /anvilkit/validator/node_modules /anvilkit/validator/dist /anvilkit/validator/package.json /anvilkit/validator/fixtures/host \
 && chmod 0700 /anvilkit/validator/profiles /anvilkit/validator/fixtures/component /anvilkit/contracts /etc/anvilkit/anvilkit-validator \
 && chmod 0711 /anvilkit/validator/fixtures
ENV ANVILKIT_VALIDATOR_CONFIG=/etc/anvilkit/anvilkit-validator/config.yaml \
    ANVILKIT_VALIDATOR_CONTRACTS_DIR=/anvilkit/contracts \
    NODE_ENV=production
USER 0:0
ENTRYPOINT ["/usr/local/bin/node", "/anvilkit/validator/dist/job.js"]
