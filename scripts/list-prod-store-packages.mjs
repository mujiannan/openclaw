import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";

const parsed = JSON.parse(fs.readFileSync(0, "utf8"));
const roots = Array.isArray(parsed) ? parsed : [parsed];
const specs = new Set();
const targetPlatform = {
  cpu: process.env.OPENCLAW_RUNTIME_CPU || process.arch,
  libc: process.env.OPENCLAW_RUNTIME_LIBC || (process.platform === "linux" ? "glibc" : undefined),
  os: process.env.OPENCLAW_RUNTIME_OS || process.platform,
};

function constraintAllows(values, target) {
  if (!Array.isArray(values) || values.length === 0 || !target) {
    return true;
  }
  const positives = values.filter((value) => typeof value === "string" && !value.startsWith("!"));
  const negatives = values
    .filter((value) => typeof value === "string" && value.startsWith("!"))
    .map((value) => value.slice(1));
  if (negatives.includes(target)) {
    return false;
  }
  return positives.length === 0 || positives.includes(target);
}

function packageSupportsTarget(pkg) {
  return (
    constraintAllows(pkg?.cpu, targetPlatform.cpu) &&
    constraintAllows(pkg?.libc, targetPlatform.libc) &&
    constraintAllows(pkg?.os, targetPlatform.os)
  );
}

function packageSpec(name, version) {
  if (!name || !version || typeof version !== "string") {
    return undefined;
  }
  const normalizedVersion = version.replace(/\(.+\)$/, "");
  if (
    normalizedVersion.startsWith("file:") ||
    normalizedVersion.startsWith("link:") ||
    normalizedVersion.startsWith("workspace:")
  ) {
    return undefined;
  }
  return `${name}@${normalizedVersion}`;
}

function packageSpecFromLockfileKey(key) {
  if (typeof key !== "string") {
    return undefined;
  }
  const normalizedKey = (key.startsWith("/") ? key.slice(1) : key).replace(/\(.+\)$/, "");
  const separator = normalizedKey.lastIndexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  return packageSpec(normalizedKey.slice(0, separator), normalizedKey.slice(separator + 1));
}

function visitListNode(node) {
  for (const dep of Object.values(node.dependencies ?? {})) {
    const name = dep.from || dep.name;
    const spec = packageSpec(name, dep.version);
    if (spec && dep.resolved?.startsWith("https://registry.npmjs.org/")) {
      specs.add(spec);
    }
    visitListNode(dep);
  }
}

function readLockfile() {
  const lockfilePath = path.join(process.cwd(), "pnpm-lock.yaml");
  if (!fs.existsSync(lockfilePath)) {
    return undefined;
  }
  return parse(fs.readFileSync(lockfilePath, "utf8"));
}

function addLockfilePackages(lockfile) {
  for (const [key, pkg] of Object.entries(lockfile?.packages ?? {})) {
    const spec = packageSpecFromLockfileKey(key);
    if (spec && packageSupportsTarget(pkg)) {
      specs.add(spec);
    }
  }
}

function addSnapshotClosure(lockfile) {
  const snapshots = lockfile?.snapshots;
  const packages = lockfile?.packages;
  if (!snapshots || !packages) {
    return;
  }
  const pending = [...specs];
  const visited = new Set();
  while (pending.length > 0) {
    const spec = pending.pop();
    if (!spec || visited.has(spec)) {
      continue;
    }
    visited.add(spec);
    const snapshot = snapshots[spec];
    if (!snapshot) {
      continue;
    }
    for (const [name, version] of Object.entries(snapshot.dependencies ?? {})) {
      const depSpec = packageSpec(name, typeof version === "string" ? version : version?.version);
      if (!depSpec || !packages[depSpec] || specs.has(depSpec) || !packageSupportsTarget(packages[depSpec])) {
        continue;
      }
      specs.add(depSpec);
      pending.push(depSpec);
    }
  }
}

for (const root of roots) {
  visitListNode(root);
}
const lockfile = readLockfile();
for (const spec of [...specs]) {
  const pkg = lockfile?.packages?.[spec];
  if (pkg && !packageSupportsTarget(pkg)) {
    specs.delete(spec);
  }
}
addSnapshotClosure(lockfile);
addLockfilePackages(lockfile);

process.stdout.write([...specs].toSorted((a, b) => a.localeCompare(b)).join("\n"));
