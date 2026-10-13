"""Small, version-pinned ABI extension: an atomic child identity, not a PTY fork."""
from pathlib import Path
import sys
root = Path(sys.argv[1])
p = root / 'src/termio/Exec.zig'
s = p.read_text()
if 'highostty_pid' not in s:
    s = s.replace('    process: ?Process = null,', '    process: ?Process = null,\n    highostty_pid: std.atomic.Value(i32) = std.atomic.Value(i32).init(0),', 1)
    s = s.replace('        self.process = .{ .fork_exec = cmd };', '        self.process = .{ .fork_exec = cmd };\n        self.highostty_pid.store(@intCast(cmd.pid.?), .release);', 1)
    p.write_text(s)
p = root / 'src/apprt/embedded.zig'
s = p.read_text()
if 'highostty_surface_pid' not in s:
    anchor = '    /// Returns true if the surface needs to confirm quitting.'
    assert anchor in s
    s = s.replace(anchor, '''    export fn highostty_surface_pid(surface: *Surface) i32 {
        return surface.core_surface.io.backend.exec.subprocess.highostty_pid.load(.acquire);
    }

''' + anchor, 1)
    p.write_text(s)
p = root / 'build.zig'
s = p.read_text()
if 'highostty universal macOS library' not in s:
    anchor = '    // macOS only artifacts.'
    assert anchor in s
    s = s.replace(anchor, '''    // highostty universal macOS library
    if (config.target.result.os.tag == .macos) {
        const hg = try buildpkg.GhosttyLib.initMacOSUniversal(b, &deps);
        hg.install("libghostty.a");
        libghostty_static.installHeader();
        resources.install();
    }

''' + anchor, 1)
    p.write_text(s)

# A shell that ignores SIGHUP must not hang surface teardown indefinitely.
p = root / 'src/termio/Exec.zig'
s = p.read_text()
if 'highostty close escalation' not in s:
    s = s.replace('        while (true) {\n            switch (posix.errno(c.killpg(pgid, c.SIGHUP))) {', '        // highostty close escalation\n        var attempts: usize = 0;\n        while (true) {\n            attempts += 1;\n            switch (posix.errno(c.killpg(pgid, if (attempts > 25) c.SIGKILL else c.SIGHUP))) {', 1)
    p.write_text(s)

# Compile the unchanged Metal shader source using the macOS runtime compiler.
# Xcode 27 distributes its offline Metal tools separately; no system SDK is edited.
p = root / 'src/build/SharedDeps.zig'
s = p.read_text()
old = '''        const metallib = self.metallib.?;
        metallib.output.addStepDependencies(&step.step);
        step.root_module.addAnonymousImport("ghostty_metallib", .{
            .root_source_file = metallib.output,
        });'''
new = '''        // highostty runtime Metal compilation
        step.root_module.addAnonymousImport("ghostty_metallib", .{
            .root_source_file = b.path("src/renderer/shaders/shaders.metal"),
        });'''
if old in s:
    p.write_text(s.replace(old, new, 1))
p = root / 'src/renderer/metal/shaders.zig'
s = p.read_text()
if 'highostty runtime shader source' not in s:
    start = s.index('    const data = try macos.dispatch.Data.create(', s.index('fn initLibrary('))
    end = s.index('    try checkError(err);', start)
    s = s[:start] + '''    // highostty runtime shader source
    const source = try macos.foundation.String.createWithBytes(
        @embedFile("ghostty_metallib"), .utf8, false,
    );
    defer source.release();
    var err: ?*anyopaque = null;
    const library = device.msgSend(
        objc.Object,
        objc.sel("newLibraryWithSource:options:error:"),
        .{ source, @as(?*anyopaque, null), &err },
    );
''' + s[end:]
    p.write_text(s)

# Xcode 27 libtool rejects unaligned object members in Zig-generated archives.
import shutil
shutil.copyfile(Path(__file__).with_name('merge-archives.py'), root / 'highostty-merge-archives.py')
p = root / 'src/build/LibtoolStep.zig'
s = p.read_text()
if 'highostty-merge-archives.py' not in s:
    s = s.replace('run_step.addArgs(&.{ "libtool", "-static", "-o" });', 'run_step.addArgs(&.{ "python3" });\n    run_step.addFileArg(b.path("highostty-merge-archives.py"));')
    p.write_text(s)
