#import <Cocoa/Cocoa.h>
#import <Quartz/Quartz.h>
#import <QuickLookThumbnailing/QuickLookThumbnailing.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#include "files.h"

// Marks a pasteboard written by "剪下" so pasting moves instead of copies.
static NSPasteboardType const HGCutType = @"com.highostty.cut";

#pragma mark - Filesystem (any thread)

NSString *HGEscapePath(NSString *path) {
    NSMutableString *out = [NSMutableString string];
    BOOL control = NO;
    for (NSUInteger i = 0; i < path.length; i++) { unichar c = [path characterAtIndex:i]; if (c < 0x20 || c == 0x7f) { control = YES; break; } }
    for (NSUInteger i = 0; i < path.length; i++) {
        unichar c = [path characterAtIndex:i];
        if (control) {
            if (c == '\\' || c == '\'') [out appendFormat:@"\\%C", c];
            else if (c == '\n') [out appendString:@"\\n"];
            else if (c == '\t') [out appendString:@"\\t"];
            else if (c < 0x20 || c == 0x7f) [out appendFormat:@"\\x%02x", c];
            else [out appendFormat:@"%C", c];
        } else {
            BOOL safe = c >= 0x80 || (c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || strchr("_@%+=:,./~-", (int)c) != NULL;
            if (!safe) [out appendString:@"\\"];
            [out appendFormat:@"%C", c];
        }
    }
    return control ? [NSString stringWithFormat:@"$'%@'", out] : out;
}

static NSString *splitExtension(NSString *name, NSString **extension) {
    NSRange dot = [name rangeOfString:@"." options:NSBackwardsSearch];
    // Dotfiles such as ".env" have no extension.
    if (dot.location == NSNotFound || dot.location == 0) { *extension = @""; return name; }
    *extension = [name substringFromIndex:dot.location];
    return [name substringToIndex:dot.location];
}
// Finder-style names: "name 2" for conflicts, "name 副本" for duplicates.
// Keep in sync with the rules described in docs/files-panel.md.
static NSString *uniquePath(NSString *directory, NSString *name, BOOL duplicate) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *candidate = [directory stringByAppendingPathComponent:name];
    if (!duplicate && ![fm fileExistsAtPath:candidate]) return candidate;
    NSString *extension; NSString *stem = splitExtension(name, &extension);
    NSString *base = duplicate ? [stem stringByAppendingString:@" 副本"] : stem;
    candidate = [directory stringByAppendingPathComponent:[base stringByAppendingString:extension]];
    if (duplicate && ![fm fileExistsAtPath:candidate]) return candidate;
    for (NSInteger n = 2;; n++) {
        candidate = [directory stringByAppendingPathComponent:[NSString stringWithFormat:@"%@ %ld%@", base, (long)n, extension]];
        if (![fm fileExistsAtPath:candidate]) return candidate;
    }
}
static BOOL validName(NSString *name) {
    return name.length && ![name containsString:@"/"] && ![name isEqualToString:@"."] && ![name isEqualToString:@".."];
}
static NSString *describe(NSError *error) {
    return error.localizedDescription ?: @"未知錯誤";
}
static NSDictionary *transfer(NSArray<NSString *> *sources, NSString *destination, BOOL move) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSMutableArray *paths = [NSMutableArray array], *errors = [NSMutableArray array];
    BOOL isDirectory = NO;
    if (![fm fileExistsAtPath:destination isDirectory:&isDirectory] || !isDirectory)
        return @{@"error": @"目的地不是目錄"};
    NSString *target = destination.stringByStandardizingPath;
    for (NSString *source in sources) {
        NSString *from = source.stringByStandardizingPath, *name = from.lastPathComponent;
        if ([target isEqualToString:from] || [target hasPrefix:[from stringByAppendingString:@"/"]]) {
            [errors addObject:[NSString stringWithFormat:@"「%@」無法放進自己裡面", name]];
            continue;
        }
        BOOL sameFolder = [from.stringByDeletingLastPathComponent isEqualToString:target];
        if (move && sameFolder) { [paths addObject:from]; continue; }
        NSString *to = uniquePath(target, name, sameFolder);
        NSError *error = nil;
        BOOL ok = move ? [fm moveItemAtPath:from toPath:to error:&error] : [fm copyItemAtPath:from toPath:to error:&error];
        if (ok) [paths addObject:to];
        else [errors addObject:[NSString stringWithFormat:@"「%@」：%@", name, describe(error)]];
    }
    return @{@"paths": paths, @"errors": errors};
}
static NSString *pngDataURL(CGImageRef image) {
    if (!image) return nil;
    NSBitmapImageRep *bitmap = [[NSBitmapImageRep alloc] initWithCGImage:image];
    NSData *png = [bitmap representationUsingType:NSBitmapImageFileTypePNG properties:@{}];
    return png ? [@"data:image/png;base64," stringByAppendingString:[png base64EncodedStringWithOptions:0]] : nil;
}
// Apps that can open a file, default first. LaunchServices can be slow, so this runs off the main thread.
static NSString *appName(NSURL *app) {
    NSString *name = [NSFileManager.defaultManager displayNameAtPath:app.path];
    return [name.pathExtension isEqualToString:@"app"] ? name.stringByDeletingPathExtension : name;
}
static NSDictionary *openWithApps(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    NSURL *preferred = [workspace URLForApplicationToOpenURL:url];
    NSMutableArray *apps = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    if (preferred) { [apps addObject:@{@"name": appName(preferred), @"path": preferred.path, @"isDefault": @YES}]; [seen addObject:preferred.path]; }
    NSMutableArray *others = [NSMutableArray array];
    for (NSURL *app in [workspace URLsForApplicationsToOpenURL:url]) {
        if ([seen containsObject:app.path]) continue;
        [seen addObject:app.path];
        [others addObject:@{@"name": appName(app), @"path": app.path, @"isDefault": @NO}];
    }
    [others sortUsingComparator:^NSComparisonResult(NSDictionary *a, NSDictionary *b) { return [a[@"name"] localizedStandardCompare:b[@"name"]]; }];
    [apps addObjectsFromArray:others];
    return @{@"apps": apps};
}
// Thumbnail for the files panel preview column; falls back to the file icon.
static NSDictionary *preview(NSString *path) {
    NSURL *url = [NSURL fileURLWithPath:path];
    UTType *type = nil;
    [url getResourceValue:&type forKey:NSURLContentTypeKey error:nil];
    QLThumbnailGenerationRequest *request = [[QLThumbnailGenerationRequest alloc] initWithFileAtURL:url size:CGSizeMake(256, 256) scale:2 representationTypes:QLThumbnailGenerationRequestRepresentationTypeAll];
    dispatch_semaphore_t done = dispatch_semaphore_create(0);
    // The handler may still run after a timeout, so it writes into its own box.
    NSMutableDictionary *box = [NSMutableDictionary dictionary];
    [QLThumbnailGenerator.sharedGenerator generateBestRepresentationForRequest:request completionHandler:^(QLThumbnailRepresentation *thumbnail, NSError *error) {
        NSString *image = pngDataURL(thumbnail.CGImage);
        @synchronized (box) { if (image) box[@"image"] = image; }
        dispatch_semaphore_signal(done);
    }];
    NSString *image = nil;
    if (dispatch_semaphore_wait(done, dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC)) == 0) {
        @synchronized (box) { image = box[@"image"]; }
    } else {
        [QLThumbnailGenerator.sharedGenerator cancelRequest:request];
    }
    if (!image) {
        NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:path];
        NSRect rect = NSMakeRect(0, 0, 256, 256);
        image = pngDataURL([icon CGImageForProposedRect:&rect context:nil hints:nil]);
    }
    return @{@"image": image ?: @"", @"kind": type.localizedDescription ?: @""};
}
static NSDictionary *filesOperation(NSDictionary *req) {
    NSFileManager *fm = NSFileManager.defaultManager;
    NSString *op = req[@"op"];
    if ([op isEqualToString:@"copy"] || [op isEqualToString:@"move"])
        return transfer(req[@"sources"], req[@"destination"], [op isEqualToString:@"move"]);
    if ([op isEqualToString:@"create-folder"] || [op isEqualToString:@"create-file"]) {
        NSString *name = req[@"name"];
        if (!validName(name)) return @{@"error": @"名稱無效"};
        NSString *path = uniquePath(req[@"directory"], name, NO);
        NSError *error = nil;
        BOOL ok = [op isEqualToString:@"create-folder"]
            ? [fm createDirectoryAtPath:path withIntermediateDirectories:NO attributes:nil error:&error]
            : [[NSData data] writeToFile:path options:NSDataWritingWithoutOverwriting error:&error];
        return ok ? @{@"paths": @[path], @"errors": @[]} : @{@"error": describe(error)};
    }
    if ([op isEqualToString:@"rename"]) {
        NSString *from = req[@"path"], *name = req[@"name"];
        if (!validName(name)) return @{@"error": @"名稱不可空白，也不可包含「/」"};
        NSString *to = [from.stringByDeletingLastPathComponent stringByAppendingPathComponent:name];
        if ([to isEqualToString:from]) return @{@"paths": @[from], @"errors": @[]};
        // Case-only renames on case-insensitive volumes report the target as existing.
        BOOL caseOnly = [to.lowercaseString isEqualToString:from.lowercaseString];
        if (!caseOnly && [fm fileExistsAtPath:to]) return @{@"error": [NSString stringWithFormat:@"已有名為「%@」的項目", name]};
        NSError *error = nil;
        return [fm moveItemAtPath:from toPath:to error:&error] ? @{@"paths": @[to], @"errors": @[]} : @{@"error": describe(error)};
    }
    if ([op isEqualToString:@"preview"]) return preview(req[@"path"]);
    if ([op isEqualToString:@"open-with-apps"]) return openWithApps(req[@"path"]);
    if ([op isEqualToString:@"trash"]) {
        NSMutableArray *paths = [NSMutableArray array], *errors = [NSMutableArray array];
        for (NSString *path in req[@"paths"]) {
            NSError *error = nil; NSURL *trashed = nil;
            if ([fm trashItemAtURL:[NSURL fileURLWithPath:path] resultingItemURL:&trashed error:&error]) [paths addObject:trashed.path ?: path];
            else [errors addObject:[NSString stringWithFormat:@"「%@」：%@", path.lastPathComponent, describe(error)]];
        }
        return @{@"paths": paths, @"errors": errors};
    }
    return @{@"error": @"未知檔案指令"};
}
char *hg_files(const char *request) {
    @autoreleasepool {
        NSDictionary *result;
        @try {
            NSData *data = [[NSString stringWithUTF8String:request ?: ""] dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *req = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            result = [req isKindOfClass:NSDictionary.class] ? filesOperation(req) : @{@"error": @"檔案指令格式錯誤"};
        } @catch (NSException *exception) {
            result = @{@"error": [NSString stringWithFormat:@"檔案操作失敗：%@", exception.reason ?: exception.name]};
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return strdup(text.UTF8String ?: "{}");
    }
}

#pragma mark - Quick Look (main thread)

@interface HGQuickLook : NSObject <QLPreviewPanelDataSource, QLPreviewPanelDelegate>
@property(nonatomic, copy) NSArray<NSURL *> *items;
@property(nonatomic, copy) void (^emitEvent)(NSDictionary *event);
@end
@implementation HGQuickLook
- (NSInteger)numberOfPreviewItemsInPreviewPanel:(QLPreviewPanel *)panel { return (NSInteger)self.items.count; }
- (id<QLPreviewItem>)previewPanel:(QLPreviewPanel *)panel previewItemAtIndex:(NSInteger)index {
    return index >= 0 && index < (NSInteger)self.items.count ? (id<QLPreviewItem>)self.items[(NSUInteger)index] : nil;
}
// The panel is key while visible; hand list navigation back to the web page.
- (BOOL)previewPanel:(QLPreviewPanel *)panel handleEvent:(NSEvent *)event {
    @try {
        if (event.type != NSEventTypeKeyDown) return NO;
        if ([event.charactersIgnoringModifiers isEqualToString:@" "]) { [panel orderOut:nil]; return YES; }
        NSString *key = nil;
        switch (event.keyCode) {
            case 125: key = @"ArrowDown"; break;
            case 126: key = @"ArrowUp"; break;
            default: break;
        }
        // With several items selected, the panel's own arrows page through them.
        if (!key || self.items.count > 1) return NO;
        if (self.emitEvent) self.emitEvent(@{@"type": @"quicklook-key", @"key": key, @"shift": @((event.modifierFlags & NSEventModifierFlagShift) != 0)});
        return YES;
    } @catch (NSException *exception) {
        return NO;
    }
}
@end

static HGQuickLook *quickLook;
// QLPreviewPanel takes its controller from the key window's responder chain.
// WKWebView implements the controller methods itself (for WebKit previews), so
// while it is first responder the panel never reaches us and shows nothing.
// This invisible view becomes first responder while Quick Look is open.
@interface HGQuickLookResponder : NSView
@property(nonatomic, weak) NSResponder *previous;
@end
@implementation HGQuickLookResponder
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)acceptsPreviewPanelControl:(QLPreviewPanel *)panel { return quickLook.items.count > 0; }
- (void)beginPreviewPanelControl:(QLPreviewPanel *)panel {
    panel.dataSource = quickLook;
    panel.delegate = quickLook;
}
- (void)endPreviewPanelControl:(QLPreviewPanel *)panel {
    @try {
        panel.dataSource = nil;
        panel.delegate = nil;
        NSWindow *window = self.window;
        if (window.firstResponder == self) [window makeFirstResponder:self.previous];
        [self removeFromSuperview];
        // Losing control (e.g. clicking back into the page) would leave the panel
        // to WebKit's empty data source, so close it instead.
        dispatch_async(dispatch_get_main_queue(), ^{
            if ([QLPreviewPanel sharedPreviewPanelExists] && QLPreviewPanel.sharedPreviewPanel.isVisible && QLPreviewPanel.sharedPreviewPanel.dataSource != quickLook)
                [QLPreviewPanel.sharedPreviewPanel orderOut:nil];
        });
        if (quickLook.emitEvent) quickLook.emitEvent(@{@"type": @"quicklook-closed"});
    } @catch (NSException *exception) {}
}
@end
static HGQuickLookResponder *quickLookResponder;
static void takePreviewControl(NSWindow *window) {
    if (!quickLookResponder) quickLookResponder = [[HGQuickLookResponder alloc] initWithFrame:NSZeroRect];
    if (window.firstResponder == quickLookResponder) return;
    quickLookResponder.previous = window.firstResponder;
    if (quickLookResponder.superview != window.contentView) [window.contentView addSubview:quickLookResponder];
    [window makeFirstResponder:quickLookResponder];
}
static NSArray<NSURL *> *fileURLs(NSArray *paths) {
    NSMutableArray<NSURL *> *urls = [NSMutableArray array];
    for (id path in paths) if ([path isKindOfClass:NSString.class] && [path length]) [urls addObject:[NSURL fileURLWithPath:path]];
    return urls;
}

#pragma mark - Dragging out of the panel (main thread)

// Drag source for files-drag: the terminal (a file-URL drop target) pastes escaped paths. Other targets
// (Finder, desktop, file managers) pick copy / move / alias like for Finder's own drags, and do the work.
@interface HGFileDragSource : NSObject <NSDraggingSource>
@property(nonatomic, copy) void (^emitEvent)(NSDictionary *event);
@end
@implementation HGFileDragSource
- (NSDragOperation)draggingSession:(NSDraggingSession *)session sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
    return NSDragOperationCopy | NSDragOperationMove | NSDragOperationLink | NSDragOperationGeneric;
}
// A move or copy by another app changes the folder on disk; let the panel reload right away.
- (void)draggingSession:(NSDraggingSession *)session endedAtPoint:(NSPoint)screenPoint operation:(NSDragOperation)operation {
    if (operation != NSDragOperationNone && self.emitEvent) self.emitEvent(@{@"type": @"files-drag-ended"});
}
@end
static HGFileDragSource *dragSource;
static NSView *webViewIn(NSView *view) {
    if ([view isKindOfClass:NSClassFromString(@"WKWebView")]) return view;
    for (NSView *child in view.subviews) { NSView *found = webViewIn(child); if (found) return found; }
    return nil;
}
static NSDictionary *beginDrag(NSWindow *window, NSArray<NSURL *> *urls, void (^emitEvent)(NSDictionary *event)) {
    if (!urls.count) return @{@"error": @"沒有選取項目"};
    NSView *web = webViewIn(window.contentView);
    if (!web) return @{@"error": @"找不到 WebView"};
    // The session needs a mouse event; the one being handled is normally still current.
    NSEvent *event = NSApp.currentEvent;
    if (!event || (event.type != NSEventTypeLeftMouseDragged && event.type != NSEventTypeLeftMouseDown)) {
        event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged location:window.mouseLocationOutsideOfEventStream modifierFlags:0 timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:window.windowNumber context:nil eventNumber:0 clickCount:1 pressure:1];
    }
    if (!dragSource) dragSource = [HGFileDragSource new];
    dragSource.emitEvent = emitEvent;
    NSPoint point = [web convertPoint:event.locationInWindow fromView:nil];
    NSMutableArray<NSDraggingItem *> *items = [NSMutableArray array];
    NSMutableArray<NSString *> *escaped = [NSMutableArray array];
    for (NSURL *url in urls) [escaped addObject:HGEscapePath(url.path)];
    NSInteger index = 0;
    for (NSURL *url in urls) {
        NSPasteboardItem *pasteboardItem = [NSPasteboardItem new];
        [pasteboardItem setString:url.absoluteString forType:NSPasteboardTypeFileURL];
        // Text-only targets (editors) get the escaped paths once, on the first item.
        if (index == 0) [pasteboardItem setString:[escaped componentsJoinedByString:@" "] forType:NSPasteboardTypeString];
        NSDraggingItem *item = [[NSDraggingItem alloc] initWithPasteboardWriter:pasteboardItem];
        NSImage *icon = [NSWorkspace.sharedWorkspace iconForFile:url.path];
        icon.size = NSMakeSize(32, 32);
        item.draggingFrame = NSMakeRect(point.x - 16 + index * 6, point.y - 16 + index * 6, 32, 32);
        item.imageComponentsProvider = ^NSArray<NSDraggingImageComponent *> *{
            NSDraggingImageComponent *component = [NSDraggingImageComponent draggingImageComponentWithKey:NSDraggingImageComponentIconKey];
            component.contents = icon;
            component.frame = NSMakeRect(0, 0, 32, 32);
            return @[component];
        };
        [items addObject:item];
        if (++index >= 8) break;
    }
    [web beginDraggingSessionWithItems:items event:event source:dragSource];
    return @{};
}

#pragma mark - Main-thread commands

// Finder's rule for a drop: ⌥ copies, ⌘ moves, otherwise moving within one volume and copying across volumes.
static BOOL dropShouldMove(NSEventModifierFlags flags, NSArray<NSURL *> *sources, NSURL *destination);
static NSEventModifierFlags liveModifiers(void) {
    // Live keyboard state: +[NSEvent modifierFlags] lags behind during a drag session.
    CGEventFlags live = CGEventSourceFlagsState(kCGEventSourceStateCombinedSessionState);
    return ((live & kCGEventFlagMaskAlternate) ? NSEventModifierFlagOption : 0) | ((live & kCGEventFlagMaskCommand) ? NSEventModifierFlagCommand : 0);
}
static NSString *dropHint;
NSDragOperation HGFilesDropOperation(id<NSDraggingInfo> sender) {
    NSDragOperation mask = sender.draggingSourceOperationMask;
    if (!dropHint.length || !(mask & NSDragOperationMove)) return NSDragOperationCopy;
    NSArray<NSURL *> *urls = [sender.draggingPasteboard readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}] ?: @[];
    return dropShouldMove(liveModifiers(), urls, [NSURL fileURLWithPath:dropHint]) ? NSDragOperationMove : NSDragOperationCopy;
}
static BOOL dropShouldMove(NSEventModifierFlags flags, NSArray<NSURL *> *sources, NSURL *destination) {
    if (flags & NSEventModifierFlagOption) return NO;
    if (flags & NSEventModifierFlagCommand) return YES;
    id destinationVolume = nil;
    [destination getResourceValue:&destinationVolume forKey:NSURLVolumeIdentifierKey error:nil];
    if (!destinationVolume || !sources.count) return NO;
    for (NSURL *source in sources) {
        id volume = nil;
        [source getResourceValue:&volume forKey:NSURLVolumeIdentifierKey error:nil];
        if (![volume isEqual:destinationVolume]) return NO;
    }
    return YES;
}

static NSDictionary *writePasteboard(NSArray<NSURL *> *urls, BOOL cut) {
    if (!urls.count) return @{@"error": @"沒有選取項目"};
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    [pasteboard clearContents];
    NSMutableArray<NSPasteboardItem *> *items = [NSMutableArray array];
    NSMutableArray<NSString *> *quoted = [NSMutableArray array], *paths = [NSMutableArray array];
    for (NSURL *url in urls) {
        [paths addObject:url.path];
        [quoted addObject:HGEscapePath(url.path)];
    }
    for (NSURL *url in urls) {
        NSPasteboardItem *item = [NSPasteboardItem new];
        [item setString:url.absoluteString forType:NSPasteboardTypeFileURL];
        [items addObject:item];
    }
    // Text targets (including the terminal) receive shell-escaped paths, matching
    // what dragging files onto a terminal inserts.
    [items.firstObject setString:[quoted componentsJoinedByString:@" "] forType:NSPasteboardTypeString];
    if (cut) [items.firstObject setString:[paths componentsJoinedByString:@"\n"] forType:HGCutType];
    return [pasteboard writeObjects:items] ? @{} : @{@"error": @"無法寫入剪貼簿"};
}
static NSDictionary *readPasteboard(void) {
    NSPasteboard *pasteboard = NSPasteboard.generalPasteboard;
    NSArray<NSURL *> *urls = [pasteboard readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey: @YES}] ?: @[];
    NSMutableArray *paths = [NSMutableArray array];
    for (NSURL *url in urls) if (url.path.length) [paths addObject:url.path];
    // Only a marker that still matches the files counts; anything copied later wins.
    NSString *marker = [pasteboard.pasteboardItems.firstObject stringForType:HGCutType];
    BOOL cut = marker && [marker isEqualToString:[paths componentsJoinedByString:@"\n"]];
    return @{@"paths": paths, @"cut": @(cut)};
}
static NSDictionary *openPaths(NSArray<NSURL *> *urls, NSString *app) {
    if (!urls.count) return @{@"error": @"沒有選取項目"};
    NSWorkspace *workspace = NSWorkspace.sharedWorkspace;
    if (app.length) {
        NSWorkspaceOpenConfiguration *configuration = [NSWorkspaceOpenConfiguration configuration];
        [workspace openURLs:urls withApplicationAtURL:[NSURL fileURLWithPath:app] configuration:configuration completionHandler:nil];
        return @{};
    }
    for (NSURL *url in urls) if (![workspace openURL:url]) return @{@"error": [NSString stringWithFormat:@"無法開啟「%@」", url.lastPathComponent]};
    return @{};
}
NSDictionary *HGFilesCommand(NSWindow *window, NSDictionary *req, void (^emitEvent)(NSDictionary *event)) {
    NSString *op = req[@"op"];
    if (![op hasPrefix:@"files-"]) return nil;
    @try {
        if ([op isEqualToString:@"files-pasteboard-write"]) return writePasteboard(fileURLs(req[@"paths"]), [req[@"cut"] boolValue]);
        if ([op isEqualToString:@"files-pasteboard-read"]) return readPasteboard();
        if ([op isEqualToString:@"files-pasteboard-text"]) {
            NSString *text = req[@"text"];
            if (!text.length) return @{@"error": @"沒有內容可拷貝"};
            [NSPasteboard.generalPasteboard clearContents];
            return [NSPasteboard.generalPasteboard setString:text forType:NSPasteboardTypeString] ? @{} : @{@"error": @"無法寫入剪貼簿"};
        }
        if ([op isEqualToString:@"files-drag"]) return beginDrag(window, fileURLs(req[@"paths"]), emitEvent);
        if ([op isEqualToString:@"files-drop-hint"]) { dropHint = req[@"destination"]; return @{}; }
        if ([op isEqualToString:@"files-drop-mode"]) {
            BOOL move = dropShouldMove(liveModifiers(), fileURLs(req[@"sources"]), [NSURL fileURLWithPath:req[@"destination"] ?: @""]);
            return @{@"move": @(move)};
        }
        if ([op isEqualToString:@"files-open"]) return openPaths(fileURLs(req[@"paths"]), req[@"app"]);
        if ([op isEqualToString:@"files-reveal"]) { [NSWorkspace.sharedWorkspace activateFileViewerSelectingURLs:fileURLs(req[@"paths"])]; return @{}; }
        if ([op isEqualToString:@"files-quicklook"] || [op isEqualToString:@"files-quicklook-update"]) {
            if (!quickLook) quickLook = [HGQuickLook new];
            QLPreviewPanel *panel = [QLPreviewPanel sharedPreviewPanel];
            BOOL visible = [QLPreviewPanel sharedPreviewPanelExists] && panel.isVisible;
            if ([op isEqualToString:@"files-quicklook-update"] && !visible) return @{};
            quickLook.items = fileURLs(req[@"paths"]);
            quickLook.emitEvent = emitEvent;
            if (!quickLook.items.count) { if (visible) [panel orderOut:nil]; return @{}; }
            takePreviewControl(window);
            if (visible) { [panel updateController]; [panel reloadData]; }
            else [panel makeKeyAndOrderFront:nil];
            panel.currentPreviewItemIndex = MAX(0, MIN([req[@"index"] integerValue], (NSInteger)quickLook.items.count - 1));
            return @{};
        }
        if ([op isEqualToString:@"files-quicklook-close"]) {
            if ([QLPreviewPanel sharedPreviewPanelExists] && [QLPreviewPanel sharedPreviewPanel].isVisible) [[QLPreviewPanel sharedPreviewPanel] orderOut:nil];
            return @{};
        }
        return @{@"error": @"未知檔案指令"};
    } @catch (NSException *exception) {
        return @{@"error": [NSString stringWithFormat:@"檔案操作失敗：%@", exception.reason ?: exception.name]};
    }
}
