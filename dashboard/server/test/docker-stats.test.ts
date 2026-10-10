import { describe, expect, it } from 'vitest';
import { cpuPercent, memUsedBytes, toContainerStats } from '../src/platform/docker-stats.js';
import { limitsFromHostConfig } from '../src/platform/compose.js';
import { parseQuantity } from '../src/platform/quantity.js';

const s = (cpu: number, sys: number, online = 4) => ({ cpu_stats: { cpu_usage: { total_usage: cpu }, system_cpu_usage: sys, online_cpus: online } });

describe('docker stats cpu%', () => {
  it('matches the docker CLI formula across two one-shot samples', () => {
    // 0.5 s of container CPU over 1 s wall on a 4-CPU host (system delta = 4 s) → 50 % (half a core)
    expect(cpuPercent(s(1.5e9, 104e9), s(1e9, 100e9))).toBe(50);
    // 2 full cores busy
    expect(cpuPercent(s(3e9, 104e9), s(1e9, 100e9))).toBe(200);
  });
  it('uses precpu_stats when no previous sample is given', () => {
    expect(cpuPercent({ ...s(2e9, 108e9, 8), precpu_stats: { cpu_usage: { total_usage: 1e9 }, system_cpu_usage: 100e9 } })).toBe(100);
  });
  it('null for one-shot payloads with empty precpu and no previous sample', () => {
    expect(cpuPercent({ ...s(2e9, 108e9), precpu_stats: { cpu_usage: { total_usage: 0 } } })).toBeNull();
  });
  it('null when the system counter did not advance', () => {
    expect(cpuPercent(s(2e9, 100e9), s(1e9, 100e9))).toBeNull();
  });
  it('falls back to percpu length when online_cpus is missing', () => {
    const cur = { cpu_stats: { cpu_usage: { total_usage: 2e9, percpu_usage: [0, 0] }, system_cpu_usage: 102e9 } };
    expect(cpuPercent(cur, s(1e9, 100e9))).toBe(100);
  });
});

describe('docker stats memory/net', () => {
  it('subtracts inactive_file (cgroup v2) and total_inactive_file (v1)', () => {
    expect(memUsedBytes({ memory_stats: { usage: 100, stats: { inactive_file: 30 } } })).toBe(70);
    expect(memUsedBytes({ memory_stats: { usage: 100, stats: { total_inactive_file: 40 } } })).toBe(60);
    expect(memUsedBytes({ memory_stats: { usage: 100 } })).toBe(100);
    expect(memUsedBytes({})).toBeNull();
  });
  it('builds ContainerStats with MB and summed networks', () => {
    const st = toContainerStats({
      ...s(2e9, 104e9),
      memory_stats: { usage: 300 * 1048576, limit: 1024 * 1048576, stats: { inactive_file: 100 * 1048576 } },
      networks: { eth0: { rx_bytes: 10, tx_bytes: 20 }, eth1: { rx_bytes: 1, tx_bytes: 2 } },
    }, s(1e9, 100e9));
    expect(st).toEqual({ cpu_pct: 100, mem_mb: 200, mem_limit_mb: 1024, net_rx_bytes: 11, net_tx_bytes: 22 });
  });
});

describe('limits', () => {
  it('reads NanoCpus / CpuQuota / Memory / CpusetCpus', () => {
    expect(limitsFromHostConfig({ NanoCpus: 2e9, Memory: 1073741824, CpusetCpus: '2-3' })).toEqual({ cpus: 2, memory_bytes: 1073741824, cpuset: '2-3' });
    expect(limitsFromHostConfig({ CpuQuota: 150000, CpuPeriod: 100000 })).toEqual({ cpus: 1.5, memory_bytes: null, cpuset: null });
    expect(limitsFromHostConfig(undefined)).toEqual({ cpus: null, memory_bytes: null, cpuset: null });
  });
  it('parses k8s quantities', () => {
    expect(parseQuantity('250m')).toBeCloseTo(0.25);
    expect(parseQuantity('2')).toBe(2);
    expect(parseQuantity('123456789n')).toBeCloseTo(0.123456789);
    expect(parseQuantity('1Gi')).toBe(1073741824);
    expect(parseQuantity('512Mi')).toBe(536870912);
    expect(parseQuantity('2048Ki')).toBe(2097152);
    expect(parseQuantity('1e3')).toBe(1000);
    expect(parseQuantity('bogus')).toBeNull();
  });
});
