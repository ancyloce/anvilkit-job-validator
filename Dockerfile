# anvilkit-validator: the trusted validator Job image (delivery.md P10d).
# DEVELOPMENT_ONLY: it carries the reviewed fixed component, the profiles,
# the protected host fixtures, the prebuilt host bundles, the locked
# toolchain and the pinned Playwright Chromium headless shell; it runs the
# chain on that fixed source only (no candidate input). The trusted process
# starts as UID 0 in its container with SETUID, SETGID and SETPCAP only (the
# harness Job template) and runs the build, SSR and browser steps as UID
# 10001 through setpriv; the browser step is Playwright's headless shell on
# the loopback interface of the Pod's network namespace.
#
# Debian rather than Alpine: Playwright ships its Chromium builds for glibc
# distributions only, and the pinned Playwright installs the exact build it
# was released with together with its system dependencies (--with-deps).
#
# Build contexts: this directory, plus the contracts sources as a named
# context (the schemas the Job validates its own outputs against):
#   docker build --build-context contracts=../../contracts -t anvilkit-validator .
FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df AS build
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

FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
RUN apt-get update \
 && apt-get install -y --no-install-recommends util-linux ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd -g 10001 candidate && useradd -M -u 10001 -g 10001 -s /usr/sbin/nologin candidate \
 && npm install -g pnpm@12.3.4 \
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
COPY --chmod=0600 config.yaml /etc/anvilkit/anvilkit-validator/config.yaml
# The browser of the host check: the Chromium headless shell of exactly this
# Playwright release with its system dependencies, under a root-owned,
# world-readable directory the step identity can execute (the step's own
# HOME and TMPDIR are its evidence directory; no Chromium sandbox, no
# network but the loopback interface).
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
