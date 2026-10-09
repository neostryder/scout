// Guest detection. Guests (VMs, sandboxes, container runtimes) are found from the host's process list only, and a
// guest's own CLI is called only while that guest is already running. Calling a guest's CLI while it is stopped
// can start it or open its first-run and update windows on the desktop.

export type GuestType = "colima" | "docker-desktop";

/** The shell text that lists the command lines of processes that identify a running guest. Read-only. */
export const GUEST_PS_SCRIPT = "ps -axo command= | grep -E 'limactl hostagent|com\\.docker\\.backend' | grep -v grep";

/** Which guest runtimes are running, from the output of GUEST_PS_SCRIPT. */
export function runningGuests(psOutput: string): GuestType[] {
  const found = new Set<GuestType>();
  for (const line of psOutput.split("\n")) {
    if (line.includes("limactl hostagent")) found.add("colima");
    if (line.includes("com.docker.backend")) found.add("docker-desktop");
  }
  return [...found];
}
