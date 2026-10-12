import type { Adapter, DependencyAdapter, UsageAdapter } from "@scout/core";
import { brewAdapter, caskAdapter } from "@scout/adapter-homebrew";
import { adapter as macapp } from "@scout/adapter-macapp";
import { adapter as pkgutil } from "@scout/adapter-pkgutil";
import { adapter as launchd } from "@scout/adapter-launchd";
import { adapter as npmglobal } from "@scout/adapter-npmglobal";
import { adapter as winregistry } from "@scout/adapter-winregistry";
import { adapter as winappx } from "@scout/adapter-winappx";
import { adapter as winservices } from "@scout/adapter-winservices";
import { adapter as winwinget } from "@scout/adapter-winwinget";
import { adapter as dockerimages } from "@scout/adapter-dockerimages";
import { adapter as dpkg } from "@scout/adapter-dpkg";
import { adapter as pacman } from "@scout/adapter-pacman";
import { wslAdapter, sbxAdapter } from "@scout/adapter-winguests";
import { adapter as pyruntimes } from "@scout/adapter-pyruntimes";
import { adapter as uvtools } from "@scout/adapter-uvtools";
import { adapter as pipxenv } from "@scout/adapter-pipxenv";
import { adapter as gobin } from "@scout/adapter-gobin";
import { adapter as localbin } from "@scout/adapter-localbin";
import { adapter as projectsel } from "@scout/adapter-projectsel";
import { adapter as noderuntime } from "@scout/adapter-noderuntime";
import { brewDepsAdapter, npmEnginesAdapter, pyvenvAdapter, wingetDepsAdapter } from "@scout/adapter-deps";
import { processesAdapter as linuxProcesses } from "@scout/adapter-linuxusage";
import { spotlightAdapter, processesAdapter as macProcesses } from "@scout/adapter-macusage";
import { userassistAdapter, processesAdapter as winProcesses } from "@scout/adapter-winusage";

/** Every adapter Scout knows. A machine runs the ones whose `os` includes its own. */
export const ADAPTERS: Adapter[] = [
  brewAdapter,
  caskAdapter,
  macapp,
  pkgutil,
  launchd,
  npmglobal,
  winregistry,
  winappx,
  winservices,
  winwinget,
  wslAdapter,
  sbxAdapter,
  pyruntimes,
  uvtools,
  pipxenv,
  gobin,
  localbin,
  projectsel,
  noderuntime,
  dpkg,
  pacman,
];

/** Sources with one instance per machine use location "". Homebrew has one per prefix. */
export const PER_PREFIX = new Set(["brew", "cask"]);

/** Adapters that read a guest: `host` ones run their CLI on the host and describe the guest, `linux` ones run inside it. */
export const GUEST_ADAPTERS: { host: Adapter[]; linux: Adapter[] } = {
  host: [dockerimages],
  linux: [dpkg, pacman],
};

/** Sources whose CLI may start a background service when it is not already up. They run only while this process exists. */
export const PROCESS_GATES: Record<string, string> = { sbx: "sbx" };

/** Usage readers, run after the inventory so their readings can be matched to installs. */
export const USAGE_ADAPTERS: UsageAdapter[] = [spotlightAdapter, macProcesses, userassistAdapter, winProcesses];

/** Usage readers that run inside a Linux guest, only while the guest is already running. File access times wait for package-to-file ownership from the dpkg adapter. */
export const GUEST_USAGE_ADAPTERS: UsageAdapter[] = [linuxProcesses];

/** Dependency readers, run after the inventory so each fact can be bound to the installs it names. */
export const DEPENDENCY_ADAPTERS: DependencyAdapter[] = [brewDepsAdapter, npmEnginesAdapter, pyvenvAdapter, wingetDepsAdapter];

export { LISTENER_ADAPTERS, SERVICE_ADAPTERS } from "@scout/ops";
