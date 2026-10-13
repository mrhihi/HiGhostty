#pragma once
#import <Cocoa/Cocoa.h>

// Files panel operations. hg_files runs filesystem changes and is safe on any
// thread; HGFilesCommand handles AppKit-only requests on the main thread and
// returns nil for ops it does not own.
char *hg_files(const char *request);
NSDictionary *HGFilesCommand(NSWindow *window, NSDictionary *req, void (^emitEvent)(NSDictionary *event));
