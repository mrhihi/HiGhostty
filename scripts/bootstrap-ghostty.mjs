import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  cpSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
if (process.platform !== "darwin")
  throw new Error("HiGhostty only supports macOS");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache =
  process.env.HIGHOSTTY_BUILD_CACHE || "/private/tmp/highostty-native-build";
const vendor = path.join(repo, "src-tauri/vendor");
mkdirSync(cache, { recursive: true });
mkdirSync(vendor, { recursive: true });
function run(cmd, args, cwd = cache) {
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.status})`);
}
function download(url, dest, hash) {
  if (!existsSync(dest))
    run("curl", ["-fLsS", "--retry", "3", url, "-o", dest]);
  if (
    hash &&
    createHash("sha256").update(readFileSync(dest)).digest("hex") !== hash
  )
    throw new Error(`Checksum mismatch: ${dest}`);
}
const archive = path.join(cache, "ghostty-1.3.1.tar.gz");
download(
  "https://codeload.github.com/ghostty-org/ghostty/tar.gz/refs/tags/v1.3.1",
  archive,
  "265837d3026b433f0e6b4e49d43153b915b0a19513f7edd8a8e693c559bd415b",
);
const source = path.join(cache, "ghostty-1.3.1");
if (!existsSync(source)) run("tar", ["-xzf", archive]);
let zig = process.env.HIGHOSTTY_ZIG;
if (!zig) {
  let arch =
    process.env.HIGHOSTTY_ZIG_HOST_ARCH ||
    (process.arch === "arm64" ? "aarch64" : "x86_64");
  const sdk = spawnSync("xcrun", ["--show-sdk-path"], {
    encoding: "utf8",
  }).stdout.trim();
  if (
    arch === "aarch64" &&
    !/\barm64-macos\b/.test(
      // 只看最上層的 targets 行；re-export 區段的 arm64-macos 不代表 libSystem 本身有 arm64 stub
      readFileSync(path.join(sdk, "usr/lib/libSystem.tbd"), "utf8").match(
        /^targets:.*$/m,
      )?.[0] ?? "",
    )
  ) {
    arch = "x86_64";
    console.log(
      "SDK arm64e stubs: using Rosetta-hosted Zig to build the universal library.",
    );
  }
  const zigArchive = path.join(cache, `zig-${arch}-macos-0.15.2.tar.xz`);
  download(
    `https://ziglang.org/download/0.15.2/zig-${arch}-macos-0.15.2.tar.xz`,
    zigArchive,
    arch === "aarch64"
      ? "3cc2bab367e185cdfb27501c4b30b1b0653c28d9f73df8dc91488e66ece5fa6b"
      : "375b6909fc1495d16fc2c7db9538f707456bfc3373b14ee83fdd3e22b3d43f7f",
  );
  zig = path.join(cache, `zig-${arch}-macos-0.15.2/zig`);
  if (!existsSync(zig)) run("tar", ["-xJf", zigArchive]);
}
const libcxx = path.join(
  path.dirname(zig),
  "lib/libcxx/include/__random/clamp_to_integral.h",
);
if (existsSync(libcxx))
  writeFileSync(
    libcxx,
    readFileSync(libcxx, "utf8").replace(", INFINITY)", ", __builtin_inff())"),
  );
run("python3", [path.join(repo, "scripts/patch-ghostty.py"), source]);
run(
  zig,
  [
    "build",
    "--global-cache-dir",
    path.join(cache, "zig-cache"),
    "-Doptimize=ReleaseFast",
    "-Dapp-runtime=none",
    "-Demit-exe=false",
    "-Demit-xcframework=false",
    "-Demit-macos-app=false",
    "-Dsentry=false",
    "-Di18n=false",
    "-Dversion-string=1.3.1",
  ],
  source,
);
cpSync(
  path.join(source, "zig-out/lib/libghostty.a"),
  path.join(vendor, "libghostty.a"),
);
cpSync(path.join(source, "zig-out/share"), path.join(vendor, "share"), {
  recursive: true,
});
console.log("Ghostty 1.3.1 universal library and resources ready.");
