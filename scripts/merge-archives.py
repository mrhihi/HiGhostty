"""Merge Mach-O members as standalone files for Xcode 27's strict libtool.
Zig archives can place a 64-bit Mach-O member at a two-byte boundary; newer
libtool silently drops these members when reading the archive directly.
"""
from pathlib import Path
import subprocess, sys, tempfile
output, *archives = sys.argv[1:]
with tempfile.TemporaryDirectory(prefix='highostty-ar-') as temporary:
    members = []
    for archive_index, archive in enumerate(archives):
        data = Path(archive).read_bytes()
        if data[:8] != b'!<arch>\n':
            raise ValueError(f'Not a thin static archive: {archive}')
        offset = 8
        while offset < len(data):
            header = data[offset:offset+60]
            if len(header) != 60 or header[58:] != b'`\n':
                raise ValueError(f'Invalid archive member in {archive}')
            size = int(header[48:58])
            content = data[offset+60:offset+60+size]
            label = header[:16].decode().strip()
            if label.startswith('#1/'):
                name_length = int(label[3:]); label = content[:name_length].rstrip(b'\0').decode(); content = content[name_length:]
            if content[:4] in (b'\xcf\xfa\xed\xfe', b'\xce\xfa\xed\xfe', b'BC\xc0\xde'):
                path = Path(temporary) / f'{archive_index}_{offset}.o'
                path.write_bytes(content); members.append(str(path))
            offset += 60+size+(size%2)
    if not members: raise ValueError('No object members found')
    subprocess.run(['libtool','-static','-o',output,*members],check=True)
