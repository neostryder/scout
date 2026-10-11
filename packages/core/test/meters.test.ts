import { test } from "node:test";
import assert from "node:assert/strict";
import { latestMeters, meterHistory, openCatalog, parseLinuxMeters, parseMacMeters, parseMeters, parseWindowsMeters, recordMeterReading, resourcesResponse, upsertMachine, type MeterReading } from "../src/index.ts";

const GIB = 1_073_741_824;

const MAC = `---SCOUT-MEM---
17179869184
10
---SCOUT-VM---
Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                4040.
Pages active:                            220000.
Pages inactive:                          200000.
Pages speculative:                         3000.
Pages wired down:                         90000.
Pages occupied by compressor:             50000.
---SCOUT-CPU---
CPU usage: 6.25% user, 9.37% sys, 84.37% idle
---SCOUT-DF---
Filesystem     1024-blocks      Used Available Capacity  Mounted on
/dev/disk3s1s1   482797652  15174980 291466076     5%    /
devfs                  219       219         0   100%    /dev
/dev/disk3s6     482797652   8388608 291466076     3%    /System/Volumes/VM
/dev/disk3s5     482797652 175000000 291466076    38%    /System/Volumes/Data
/dev/disk5s1     976490576 500000000 476490576    52%    /Volumes/Backup Drive
/dev/disk4s1       5000000   2000000   3000000    40%    /Volumes/Recovery
map auto_home          0         0         0   100%    /System/Volumes/Data/home
---SCOUT-NET---
Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                         100     0      50000      100     0      50000     0
en0        1500  <Link#6>    aa:bb:cc:dd:ee:ff  1000     0    5000000      800     0    2000000     -
en0        1500  192.168.2     192.168.2.154     1000     -    5000000      800     -    2000000     -
en1        1500  <Link#7>    aa:bb:cc:dd:ee:00   10     0      1000       10     0        500     -
---SCOUT-PS---
  101  250.0 204800 /Applications/Busy.app/Contents/MacOS/Busy
  102    1.0 819200 /usr/sbin/memhog
  103    0.0   1024 /sbin/launchd
`;

test("a Mac reading takes memory from vm_stat, CPU from top, the Data volume as the root disk, and physical interfaces", () => {
  const reading = parseMacMeters(MAC);
  assert.equal(reading.memTotalBytes, 17 * GIB - GIB);
  assert.equal(reading.memUsedBytes, (220000 + 90000 + 50000) * 16384);
  assert.equal(reading.cpuPct, 15.6);
  assert.deepEqual(reading.disks, [
    { mount: "/", usedBytes: 175_000_000 * 1024, totalBytes: (175_000_000 + 291_466_076) * 1024 },
    { mount: "/Volumes/Backup Drive", usedBytes: 500_000_000 * 1024, totalBytes: (500_000_000 + 476_490_576) * 1024 },
  ]);
  assert.equal(reading.netRxBytes, 5_001_000);
  assert.equal(reading.netTxBytes, 2_000_500);
  assert.deepEqual(reading.gpus, []);
  assert.deepEqual(reading.processes.map((p) => [p.pid, p.name, p.cpuPct]), [[101, "Busy", 25], [102, "memhog", 0.1], [103, "launchd", 0]]);
  assert.equal(reading.processes[1]!.memBytes, 819200 * 1024);
});

const LINUX = `---SCOUT-MEMINFO---
MemTotal:       32768000 kB
MemFree:         1000000 kB
MemAvailable:   16384000 kB
---SCOUT-STAT---
cpu  1000 0 500 8000 100 0 0 0 0 0
cpu  1100 0 550 8200 110 0 0 0 0 0
---SCOUT-DF---
Filesystem     1024-blocks      Used Available Capacity Mounted on
/dev/nvme0n1p2   100000000  40000000  55000000      43% /
/dev/nvme0n1p2   100000000  40000000  55000000      43% /var/lib/docker/overlay
/dev/loop3            1000      1000         0     100% /snap/core/1
/dev/sda1       500000000 250000000 225000000      53% /mnt/data
tmpfs             1000000         0   1000000       0% /dev/shm
---SCOUT-NET---
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:  900000   100    0    0    0     0          0         0   900000   100    0    0    0     0       0          0
  eth0: 4000000  2000    0    0    0     0          0         0  1000000  1500    0    0    0     0       0          0
docker0: 777777  2000    0    0    0     0          0         0   777777  1500    0    0    0     0       0          0
---SCOUT-GPU---
NVIDIA GeForce RTX 5080, 4, 1820, 16303
---SCOUT-PS---
  900 1048576 postgres
  901 524288 node
`;

test("a Linux reading takes CPU from two /proc/stat lines and skips loop, bind, container, and virtual interfaces", () => {
  const reading = parseLinuxMeters(LINUX);
  assert.equal(reading.memTotalBytes, 32_768_000 * 1024);
  assert.equal(reading.memUsedBytes, 16_384_000 * 1024);
  assert.equal(reading.cpuPct, 41.7);
  assert.deepEqual(reading.disks.map((d) => d.mount), ["/", "/mnt/data"]);
  assert.equal(reading.disks[0]!.totalBytes, 95_000_000 * 1024);
  assert.equal(reading.netRxBytes, 4_000_000);
  assert.equal(reading.netTxBytes, 1_000_000);
  assert.deepEqual(reading.gpus, [{ name: "NVIDIA GeForce RTX 5080", utilPct: 4, vramUsedBytes: 1820 * 1_048_576, vramTotalBytes: 16303 * 1_048_576 }]);
  assert.deepEqual(reading.processes.map((p) => [p.name, p.cpuPct]), [["postgres", null], ["node", null]]);
});

const WINDOWS = JSON.stringify({
  cpu: 12, cores: 16, memTotal: 64 * GIB, memFree: 40 * GIB, rx: 9_000_000, tx: 3_000_000,
  disks: [{ mount: "C:", total: 1_000_000_000_000, free: 400_000_000_000 }, { mount: "D:", total: 0, free: 0 }],
  gpu: "NVIDIA GeForce RTX 5080, 31, 7000, 16303",
  procs: [
    { id: 100, name: "node#2", cpu: 320, mem: 800_000_000 },
    { id: 0, name: "Idle", cpu: 1500, mem: 0 },
    { id: 200, name: "chrome", cpu: 16, mem: 4_000_000_000 },
  ],
});

test("a Windows reading divides per-core process CPU by the core count, drops the idle process, and accepts a one-item list as a bare object", () => {
  const reading = parseWindowsMeters(WINDOWS);
  assert.equal(reading.cpuPct, 12);
  assert.equal(reading.memUsedBytes, 24 * GIB);
  assert.deepEqual(reading.disks, [{ mount: "C:", usedBytes: 600_000_000_000, totalBytes: 1_000_000_000_000 }]);
  assert.deepEqual(reading.gpus, [{ name: "NVIDIA GeForce RTX 5080", utilPct: 31, vramUsedBytes: 7000 * 1_048_576, vramTotalBytes: 16303 * 1_048_576 }]);
  assert.deepEqual(reading.processes.map((p) => [p.pid, p.name, p.cpuPct]), [[100, "node", 20], [200, "chrome", 1]]);
  const single = parseWindowsMeters(JSON.stringify({ cpu: 5, cores: 4, memTotal: GIB, memFree: GIB / 2, disks: { mount: "C:", total: 100, free: 40 }, procs: { id: 7, name: "x", cpu: 4, mem: 10 } }));
  assert.equal(single.disks.length, 1);
  assert.equal(single.processes[0]!.cpuPct, 1);
});

test("unreadable output throws a plain error and the OS switch picks the right parser", () => {
  assert.throws(() => parseWindowsMeters("not json"), /could not be read/);
  assert.throws(() => parseMacMeters(""), /could not be read/);
  assert.throws(() => parseLinuxMeters("---SCOUT-PS---\n"), /could not be read/);
  assert.equal(parseMeters("macos", MAC).cpuPct, 15.6);
  assert.equal(parseMeters("windows", WINDOWS).cpuPct, 12);
  assert.equal(parseMeters("linux", LINUX).cpuPct, 41.7);
});

const reading = (rx: number, tx: number, cpu = 10): MeterReading => ({ cpuPct: cpu, memUsedBytes: 1, memTotalBytes: 2, disks: [], gpus: [], netRxBytes: rx, netTxBytes: tx, processes: [] });

test("network rates come from the previous sample and a counter reset gives no rate", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  const T0 = Date.parse("2026-10-11T00:00:00.000Z");
  const at = (seconds: number): string => new Date(T0 + seconds * 1000).toISOString();
  assert.equal(recordMeterReading(db, "hub", reading(1_000, 500), at(0)).netRxBps, null);
  const second = recordMeterReading(db, "hub", reading(11_000, 2_500), at(10));
  assert.equal(second.netRxBps, 1_000);
  assert.equal(second.netTxBps, 200);
  const reboot = recordMeterReading(db, "hub", reading(100, 50), at(20));
  assert.equal(reboot.netRxBps, null);
  assert.equal(recordMeterReading(db, "mini", reading(5, 5), at(20)).netRxBps, null);
  assert.deepEqual(latestMeters(db).map((s) => [s.machineId, s.at]), [["hub", at(20)], ["mini", at(20)]]);
  assert.deepEqual(meterHistory(db, "hub", at(0)).map((s) => s.at), [at(0), at(10), at(20)]);
  assert.deepEqual(meterHistory(db, "hub", at(5), 1).map((s) => s.at), [at(20)]);
});

test("samples older than seven days are pruned when a new one lands", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  recordMeterReading(db, "hub", reading(1, 1), "2026-10-01T00:00:00.000Z");
  recordMeterReading(db, "hub", reading(2, 2), "2026-10-09T00:00:00.000Z");
  assert.deepEqual(meterHistory(db, "hub", "2026-09-01T00:00:00.000Z").map((s) => s.at), ["2026-10-09T00:00:00.000Z"]);
});

test("the resources response names each machine, computes percentages, ranks the top users, and thins the series", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
  const base = Date.parse("2026-10-11T00:00:00.000Z");
  for (let i = 0; i < 100; i++) {
    recordMeterReading(db, "hub", { ...reading(i * 1000, i * 500, i), memUsedBytes: 25, memTotalBytes: 100, disks: [{ mount: "C:", usedBytes: 60, totalBytes: 240 }], gpus: [{ name: "GPU", utilPct: 3, vramUsedBytes: 4, vramTotalBytes: 16 }],
      processes: [{ pid: 1, name: "a", cpuPct: 1, memBytes: 30 }, { pid: 2, name: "b", cpuPct: 9, memBytes: 10 }] }, new Date(base + i * 10_000).toISOString());
  }
  const now = new Date(base + 99 * 10_000 + 5_000).toISOString();
  const { machines } = resourcesResponse(db, now);
  assert.equal(machines.length, 1);
  const eru = machines[0]!;
  assert.equal(eru.name, "Eru");
  assert.equal(eru.ageSeconds, 5);
  assert.equal(eru.mem!.pct, 25);
  assert.equal(eru.disks[0]!.pct, 25);
  assert.equal(eru.gpus[0]!.vramPct, 25);
  assert.deepEqual(eru.top.cpu.map((p) => p.name), ["b", "a"]);
  assert.deepEqual(eru.top.mem.map((p) => p.name), ["a", "b"]);
  assert.equal(eru.series.length, 60);
  assert.equal(eru.series.at(-1)!.at, new Date(base + 99 * 10_000).toISOString());
  assert.equal(eru.net.rxBps, 100);
});

test("a biggest-user row takes the name and kind of the running service or open listener that owns its pid", (t) => {
  const db = openCatalog(":memory:");
  t.after(() => db.close());
  upsertMachine(db, { id: "hub", name: "Eru", os: "windows", kind: "host" });
  const seen = "2026-10-11T00:00:00.000Z";
  db.prepare("INSERT INTO services (machine_id, kind, domain, name, display_name, state, pid, first_seen_at, last_seen_at) VALUES ('hub','windows-service','system','Cogitator','Cogitator gateway','running',10,?,?)").run(seen, seen);
  db.prepare("INSERT INTO services (machine_id, kind, domain, name, state, pid, first_seen_at, last_seen_at) VALUES ('hub','windows-service','system','OldOne','stopped',11,?,?)").run(seen, seen);
  db.prepare("INSERT INTO listeners (machine_id, port, protocol, address, bind, pid, process_name, script_path, first_seen_at, last_seen_at) VALUES ('hub',4870,'tcp','127.0.0.1','loopback',20,'node','C:/Repositories/scout/packages/hub/src/main.ts',?,?)").run(seen, seen);
  db.prepare("INSERT INTO listeners (machine_id, port, protocol, address, bind, pid, process_name, first_seen_at, last_seen_at, gone_at) VALUES ('hub',9999,'tcp','127.0.0.1','loopback',30,'gone',?,?,?)").run(seen, seen, seen);
  recordMeterReading(db, "hub", { ...reading(1, 1), processes: [
    { pid: 10, name: "python", cpuPct: 50, memBytes: 5 }, { pid: 11, name: "other", cpuPct: 40, memBytes: 4 }, { pid: 20, name: "node", cpuPct: 30, memBytes: 3 }, { pid: 30, name: "gone", cpuPct: 20, memBytes: 2 }, { pid: 40, name: "plain", cpuPct: 10, memBytes: 1 },
  ] }, seen);
  const top = resourcesResponse(db, seen).machines[0]!.top.cpu;
  assert.deepEqual(top.map((p) => [p.name, p.label ?? null, p.kind ?? null]), [
    ["python", "Cogitator gateway", "service"],
    ["other", null, null],
    ["node", "main.ts on port 4870", "listener"],
    ["gone", null, null],
    ["plain", null, null],
  ]);
});
