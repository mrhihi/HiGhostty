#pragma once
#import <Cocoa/Cocoa.h>

// Files panel operations. hg_files runs filesystem changes and is safe on any
// thread; HGFilesCommand handles AppKit-only requests on the main thread and
// returns nil for ops it does not own.
char *hg_files(const char *request);
NSDictionary *HGFilesCommand(NSWindow *window, NSDictionary *req, void (^emitEvent)(NSDictionary *event));
// Backslash-escaped path for pasting into a shell (control characters fall back to $'…').
// Keep in sync with shellEscape in src/files.ts.
NSString *HGEscapePath(NSString *path);
// Drag operation shown while a file drag is over the files panel (Move or Copy, like Finder), so the
// cursor badge matches what the drop will do. The panel reports the folder under the pointer via files-drop-hint.
NSDragOperation HGFilesDropOperation(id<NSDraggingInfo> sender);
