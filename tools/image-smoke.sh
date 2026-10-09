#!/bin/sh
# Smoke check of a built anvilkit-validator image (no network, no sidecar):
# the package state P0.8 AC7 relies on — libgbm1 repacked without its DRI
# backend, no Mesa gallium driver, LLVM, libxml2, GL stack or Xvfb, dpkg
# consistent, no package manager of the Node base — every library the
# Chromium headless shell links resolvable, and, under the Job's capability
# set (SETUID, SETGID and SETPCAP only) and the image's step identities
# (setpriv: UID 10001 for the build, the SSR render and the browser, 10003
# for the SSR harness), a complete certification of the reviewed fixed
# component with both mandatory host checks, the browser check in the
# image's own Chromium. It proves the image's layout and that its browser
# runs without the removed libraries, not any runtime isolation.
#
#   sh tools/image-smoke.sh <image>
set -eu
image=${1:?usage: image-smoke.sh <image>}
caps="--cap-drop ALL --cap-add SETUID --cap-add SETGID --cap-add SETPCAP"

echo "package state"
docker run --rm --network none --entrypoint sh "$image" -c '
  set -e
  for p in libxml2 libllvm19 mesa-libgallium libgl1-mesa-dri libglx-mesa0 libgl1 xvfb; do
    if dpkg-query -W -f="\${Status}\n" "$p" 2>/dev/null | grep -q " installed"; then echo "$p is installed"; exit 1; fi
  done
  v=$(dpkg-query -W -f="\${Version}" libgbm1)
  case "$v" in *+anvilkit1) ;; *) echo "libgbm1 $v is not the repacked package"; exit 1 ;; esac
  test ! -e /usr/lib/x86_64-linux-gnu/gbm/dri_gbm.so
  if ldd /anvilkit/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell | grep "not found"; then exit 1; fi
  apt-get check >/dev/null
  for b in npm npx corepack yarn pnpm; do if command -v "$b" >/dev/null; then echo "$b is present"; exit 1; fi; done'
echo ok

echo "a complete certification in the image under the Job's capabilities and step identities"
# shellcheck disable=SC2086
out=$(docker run --rm --network none $caps --tmpfs /tmp:rw,exec,mode=1777 --entrypoint /usr/local/bin/node -w /anvilkit/validator "$image" \
  dist/cli.js /anvilkit/validator/fixtures/component/hero --source-revision 1 --out /tmp/out --step-identity setpriv)
echo "$out"
echo "$out" | grep -q '"verdict":"certified"' || { echo "not certified"; exit 1; }
echo "$out" | grep -q '"complete":true' || { echo "not a complete certification"; exit 1; }
echo ok

echo "image smoke: PASS"
