# The .rpm of Ezzar's Daeva Companion, a fork of the A2Tools DPS Meter: the
# upstream spec (a2-tools-dps-meter.spec) under this fork's names; built by
# build-rpm.sh. Tauri builds the program and lays out its files (its own .rpm,
# unpacked into %{payload} by the workflow); this spec repackages them so the
# binary carries its packet-capture permission in the package itself (%caps)
# rather than from a setcap in a %post script.
#
# Why: rpm-ostree (Bazzite, Silverblue, Kinoite and the other image-based
# Fedoras) runs package scripts with most capabilities dropped, so a setcap
# there fails and the meter installs unable to capture. rpm, dnf, zypper and
# rpm-ostree all apply %caps themselves. See .github/workflows/arch-package.yml.
#
# Built with: rpmbuild -bb --define "pkgversion <v>" --define "payload <dir>"
#                      --define "filelist <file>"

%global debug_package %{nil}
# Ship the binary exactly as Tauri built it: no stripping or re-compressing.
%global __os_install_post %{nil}
%global _build_id_links none

Name:           daeva-companion
Version:        %{pkgversion}
Release:        1
Summary:        Ezzar's Daeva Companion - AION 2 DPS meter and combat overlays
License:        GPL-3.0-only
URL:            https://github.com/taengu/A2Tools-DPS-Meter
ExclusiveArch:  x86_64

# libpcap is loaded at runtime, so rpmbuild cannot find it among the binary's
# libraries; the rest (WebKitGTK, GTK) it adds by itself.
Requires:       libpcap.so.1()(64bit)

%description
AION 2 DPS meter with combat overlays (cooldown and buff bars, loss of control
and party debuff alerts, PvP, training runs, personal bests, dungeon runs, pet
souls, event alerts), running natively on Linux while the game runs under
Proton. A fork of the A2Tools DPS Meter.

%install
cp -a "%{payload}/." "%{buildroot}/"

%files -f %{filelist}
