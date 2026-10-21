#!/bin/bash
# Build Ezzar's Daeva Companion's .rpm for Fedora and the image-based Fedoras
# (Bazzite, Silverblue, Kinoite), the way .github/workflows/arch-package.yml
# builds upstream's: Tauri lays out the files, and daeva-companion.spec
# repackages them so the binary carries its packet-capture permission (%caps;
# rpm-ostree drops capabilities from %post scripts). Run from anywhere, in a
# Fedora toolbox/distrobox with the build dependencies (docs/linux.md) and
# rpm-build, cpio. The package lands in out/.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
version=$(grep -m1 '^version' src-tauri/Cargo.toml | cut -d'"' -f2)
# tauri.linux.conf.json names the hotkeys helper under src-tauri/target, so
# build there whatever CARGO_TARGET_DIR says.
export CARGO_TARGET_DIR="$root/src-tauri/target"
target=$CARGO_TARGET_DIR
product="Ezzar's Daeva Companion"

# Files a clean checkout lacks (gitignored mirrors of src/data).
mkdir -p public/i18n public/data public/src/data
cp -r src/data/i18n/* public/i18n/
cp src/data/skill_icons.json src/data/dot_skill_ids.json public/data/
cp src/data/skill_icons.json src/data/dot_skill_ids.json public/src/data/

npm ci --no-audit --no-fund
# The hotkeys helper first: tauri.linux.conf.json packs it next to the meter.
cargo build --release --manifest-path src-tauri/Cargo.toml --bin daeva-companion-hotkeys
rm -rf "$target/release/bundle/rpm"
npx tauri build --bundles rpm

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/payload"
(cd "$work/payload" && rpm2cpio "$target"/release/bundle/rpm/*.rpm | cpio -idm --quiet)
(
  cd "$work/payload"
  find "./usr/lib/$product" -type d | sed 's|^\.||; s|.*|%dir "&"|'
  find . \( -type f -o -type l \) | sed 's|^\.||' | while IFS= read -r f; do
    if [ "$f" = /usr/bin/daeva-companion ]; then
      printf '%%caps(cap_net_raw=ep) "%s"\n' "$f"
    else
      printf '"%s"\n' "$f"
    fi
  done
) > "$work/files.txt"
rpmbuild -bb packaging/linux/daeva-companion.spec \
  --define "_topdir $work/rpmbuild" \
  --define "pkgversion $version" \
  --define "payload $work/payload" \
  --define "filelist $work/files.txt"
mkdir -p out
out="out/daeva-companion-${version}-1.x86_64.rpm"
cp "$work"/rpmbuild/RPMS/x86_64/*.rpm "$out"
rpm -qp --filecaps "$out" | grep -q cap_net_raw
echo "Built $out"
