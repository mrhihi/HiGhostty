#import <Cocoa/Cocoa.h>

// 主視窗位置／大小。座標一律是 AppKit points（全域一致，不受各螢幕 scale 影響）。
// 必須在主執行緒呼叫。

static NSDictionary *HGRectJSON(NSRect r) {
    return @{@"x": @(r.origin.x), @"y": @(r.origin.y), @"w": @(r.size.width), @"h": @(r.size.height)};
}

// 螢幕識別：廠商-型號-序號＠點數大小；同一台螢幕換解析度設定也算不同組，各自記大小。
static NSString *HGScreenKey(NSScreen *screen) {
    NSNumber *number = screen.deviceDescription[@"NSScreenNumber"];
    CGDirectDisplayID display = (CGDirectDisplayID)number.unsignedIntValue;
    return [NSString stringWithFormat:@"%u-%u-%u@%dx%d", CGDisplayVendorNumber(display), CGDisplayModelNumber(display),
            CGDisplaySerialNumber(display), (int)screen.frame.size.width, (int)screen.frame.size.height];
}

static NSDictionary *HGWindowOperation(NSWindow *window, NSDictionary *req) {
    NSString *op = req[@"op"];
    if ([op isEqualToString:@"screens"]) {
        NSMutableArray *list = [NSMutableArray array];
        NSPoint mouse = NSEvent.mouseLocation;
        for (NSScreen *screen in NSScreen.screens) {
            [list addObject:@{
                @"key": HGScreenKey(screen),
                @"visible": HGRectJSON(screen.visibleFrame),
                @"mouse": @(NSPointInRect(mouse, screen.frame)),
            }];
        }
        return @{@"screens": list};
    }
    if ([op isEqualToString:@"frame"]) {
        NSScreen *screen = window.screen;
        if (!screen) return @{@"error": @"視窗不在任何螢幕上"};
        // 縮放（isZoomed）是使用者拉滿螢幕的結果，要記住；全螢幕與最小化的外框不代表他要的大小。
        BOOL normal = !(window.styleMask & NSWindowStyleMaskFullScreen) && !window.isMiniaturized;
        return @{@"frame": HGRectJSON(window.frame), @"screen": HGScreenKey(screen), @"visible": HGRectJSON(screen.visibleFrame), @"normal": @(normal)};
    }
    if ([op isEqualToString:@"set-frame"]) {
        NSRect target = NSMakeRect([req[@"x"] doubleValue], [req[@"y"] doubleValue], [req[@"w"] doubleValue], [req[@"h"] doubleValue]);
        [window setFrame:target display:YES];
        return @{@"ok": @YES};
    }
    return @{@"error": @"未知視窗指令"};
}

char *hg_window(void *windowPointer, const char *request) {
    @autoreleasepool {
        NSDictionary *result;
        @try {
            NSWindow *window = (__bridge NSWindow *)windowPointer;
            NSData *data = [[NSString stringWithUTF8String:request ?: ""] dataUsingEncoding:NSUTF8StringEncoding];
            NSDictionary *req = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
            result = [req isKindOfClass:NSDictionary.class] && window ? HGWindowOperation(window, req) : @{@"error": @"視窗指令格式錯誤"};
        } @catch (NSException *exception) {
            result = @{@"error": [NSString stringWithFormat:@"視窗操作失敗：%@", exception.reason ?: exception.name]};
        }
        NSData *json = [NSJSONSerialization dataWithJSONObject:result options:0 error:nil];
        NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
        return strdup(text.UTF8String ?: "{}");
    }
}
