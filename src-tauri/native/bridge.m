#import <Cocoa/Cocoa.h>
#import <Carbon/Carbon.h>
#import <QuartzCore/QuartzCore.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <UserNotifications/UserNotifications.h>
#include <libproc.h>
#include <signal.h>
#include <stdio.h>
#include <sys/proc.h>
#include <sys/sysctl.h>
#include <unistd.h>
#include "ghostty.h"
#include "bridge.h"
#include "files.h"

// The Ghostty ABI, its AppKit views, and all callbacks are owned by the main thread.
@class HGSurface;
static ghostty_app_t engine;
static ghostty_config_t config;
static NSMutableDictionary<NSString *, HGSurface *> *surfaces;
static NSMutableDictionary<NSString *, NSWindow *> *windows;
static hg_event_cb eventCallback;
static NSString *lastWindow;
static NSString *resourcePath;
static CFMachPortRef globalTap;
static CFRunLoopSourceRef globalSource;
static id localMonitor;
static id themeObserver;
static BOOL shuttingDown;
static BOOL transparencyEnabled = YES;
static NSMutableArray<NSString *> *activeKeyTexts;

static NSMutableArray<id> *observers;
static void emit(NSString *window, NSDictionary *event) {
    if (!eventCallback || shuttingDown || !window) return;
    NSData *json = [NSJSONSerialization dataWithJSONObject:event options:0 error:nil];
    NSString *text = [[NSString alloc] initWithData:json encoding:NSUTF8StringEncoding];
    eventCallback(window.UTF8String, text.UTF8String);
}
static NSString *str(const char *s) { return s ? [NSString stringWithUTF8String:s] ?: @"" : @""; }
static ghostty_input_mods_e mods(NSEventModifierFlags flags) {
    int m = 0;
    if (flags & NSEventModifierFlagShift) m |= GHOSTTY_MODS_SHIFT;
    if (flags & NSEventModifierFlagControl) m |= GHOSTTY_MODS_CTRL;
    if (flags & NSEventModifierFlagOption) m |= GHOSTTY_MODS_ALT;
    if (flags & NSEventModifierFlagCommand) m |= GHOSTTY_MODS_SUPER;
    if (flags & NSEventModifierFlagCapsLock) m |= GHOSTTY_MODS_CAPS;
    return m;
}
static ghostty_input_key_s keyEvent(NSEvent *event, ghostty_input_action_e action) {
    NSString *base = (event.type==NSEventTypeKeyDown||event.type==NSEventTypeKeyUp)?([event charactersByApplyingModifiers:0] ?: @""):@"";
    uint32_t cp = base.length ? [base characterAtIndex:0] : 0;
    if (base.length > 1 && CFStringIsSurrogateHighCharacter(cp)) cp = CFStringGetLongCharacterForSurrogatePair(cp,[base characterAtIndex:1]);
    ghostty_input_mods_e eventMods=mods(event.modifierFlags);
    return (ghostty_input_key_s){.action=action,.mods=eventMods,.consumed_mods=eventMods & ~(GHOSTTY_MODS_CTRL|GHOSTTY_MODS_SUPER),.keycode=event.keyCode,.unshifted_codepoint=cp};
}
static NSString *keyboardLayoutID(void) {
    TISInputSourceRef source=TISCopyCurrentKeyboardInputSource();
    if(!source)return nil;
    CFStringRef sourceID=TISGetInputSourceProperty(source,kTISPropertyInputSourceID);
    NSString *result=sourceID?[(__bridge NSString *)sourceID copy]:nil;
    CFRelease(source);
    return result;
}
#ifdef HG_DEBUG_INPUT
static void inputTrace(NSString *stage,NSEvent *event,NSString *text,BOOL result) {
    // -characters throws for flagsChanged events.
    NSString *chars=(event.type==NSEventTypeKeyDown||event.type==NSEventTypeKeyUp)?event.characters:nil;
    unichar eventFirst=chars.length?[chars characterAtIndex:0]:0;
    unichar sentFirst=text.length?[text characterAtIndex:0]:0;
    NSLog(@"[HiGhostty keyboard] stage=%@ keyCode=%hu flags=%llu eventChars=%lu eventFirst=%04x sentChars=%lu sentFirst=%04x windowKey=%d result=%d",
          stage,event.keyCode,(unsigned long long)event.modifierFlags,(unsigned long)chars.length,
          eventFirst,(unsigned long)text.length,sentFirst,event.window.isKeyWindow,result);
    FILE *file=fopen("/private/tmp/highostty-keyboard.log","a");
    if(file){fprintf(file,"stage=%s keyCode=%hu flags=%llu eventChars=%lu eventFirst=%04x sentChars=%lu sentFirst=%04x windowKey=%d result=%d\n",
                     stage.UTF8String,event.keyCode,(unsigned long long)event.modifierFlags,(unsigned long)chars.length,
                     eventFirst,(unsigned long)text.length,sentFirst,event.window.isKeyWindow,result);fclose(file);}
}
#define HG_INPUT_TRACE(stage,event,text,result) inputTrace((stage),(event),(text),(result))
#else
#define HG_INPUT_TRACE(stage,event,text,result) ((void)0)
#endif
static NSString *ghosttyCharacters(NSEvent *event) {
    NSString *text=event.characters;
    if(!text.length)return nil;
    if(text.length==1) {
        unichar c=[text characterAtIndex:0];
        if(c==0x7f)return nil;
        if(c<0x20)return [event charactersByApplyingModifiers:event.modifierFlags & ~NSEventModifierFlagControl];
        if(c>=0xF700 && c<=0xF8FF)return nil;
    }
    return text;
}
static BOOL getConfig(const char *key, void *out) { return config && ghostty_config_get(config,out,key,strlen(key)); }
static double numberConfig(const char *key, double fallback) { double value=fallback; getConfig(key,&value); return value; }
static NSString *stringConfig(const char *key) { const char *value=NULL; getConfig(key,&value); return str(value); }
static BOOL boolConfig(const char *key, BOOL fallback) { bool value=fallback; getConfig(key,&value); return value; }
static NSColor *backgroundColor(void) {
    ghostty_config_color_s color={21,25,31}; getConfig("background",&color);
    return [NSColor colorWithSRGBRed:color.r/255.0 green:color.g/255.0 blue:color.b/255.0 alpha:1];
}
static NSString *hexColor(NSColor *color) { return [NSString stringWithFormat:@"#%02x%02x%02x",(int)lround(color.redComponent*255),(int)lround(color.greenComponent*255),(int)lround(color.blueComponent*255)]; }
static void applyWindow(NSWindow *window);
static void configureGlobalKeys(void);
static bool nativeAction(ghostty_app_t app, ghostty_target_s target, ghostty_action_s action);

// UI 字串由前端 (i18n) 透過 set-strings 推入；沒有就用英文 fallback。
static NSDictionary<NSString *,NSString *> *uiStrings;
static NSString *L(NSString *key,NSString *fallback){NSString *v=uiStrings[key];return v.length?v:fallback;}
@interface HGSurface : NSView <NSTextInputClient>
@property ghostty_surface_t surface;

@property NSString *owner;
@property BOOL tmux;
@property NSString *cwd;
@property NSString *title;
@property NSMutableAttributedString *marked;
@property BOOL closing;
@property BOOL suspended;
@property NSTrackingArea *tracking;
@property uint64_t rootStart;
@property int32_t rootPid;
@property int32_t primaryPid;
@property uint64_t primaryStart;
@property NSTimeInterval lastPerformKeyEvent;
@property BOOL hasLastPerformKeyEvent;
// Area (in this view's coordinates) hidden so the web overlay beneath shows through.
@property (copy) NSArray<NSValue *> *cutouts; // overlay holes (disjoint), view coordinates

@end
@implementation HGSurface
- (NSView *)hitTest:(NSPoint)point {
    if(self.cutouts.count){NSPoint local=[self convertPoint:point fromView:self.superview];for(NSValue *hole in self.cutouts)if(NSPointInRect(local,hole.rectValue))return nil;}
    return [super hitTest:point];
}
- (NSDragOperation)draggingEntered:(id<NSDraggingInfo>)sender {
    @try { return [sender.draggingPasteboard.types containsObject:NSPasteboardTypeFileURL] ? NSDragOperationCopy : NSDragOperationNone; }
    @catch(NSException *exception) { [self reportInputException:exception]; return NSDragOperationNone; }
}
- (BOOL)prepareForDragOperation:(id<NSDraggingInfo>)sender {
    @try { return [sender.draggingPasteboard.types containsObject:NSPasteboardTypeFileURL]; }
    @catch(NSException *exception) { [self reportInputException:exception]; return NO; }
}
- (BOOL)performDragOperation:(id<NSDraggingInfo>)sender {
    @try {
        NSArray<NSURL *> *urls=[sender.draggingPasteboard readObjectsForClasses:@[NSURL.class] options:@{NSPasteboardURLReadingFileURLsOnlyKey:@YES}];
        if(!urls.count||!_surface)return NO;
        NSMutableArray<NSString *> *quoted=[NSMutableArray array];
        for(NSURL *url in urls){NSString *path=url.path;if(!path.length)continue;[quoted addObject:HGEscapePath(path)];}
        if(!quoted.count)return NO;
        NSString *text=[quoted componentsJoinedByString:@" "];
        ghostty_surface_text(_surface,text.UTF8String,[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
        return YES;
    } @catch(NSException *exception) { [self reportInputException:exception]; return NO; }
}
- (BOOL)isFlipped { return YES; }
- (BOOL)acceptsFirstMouse:(NSEvent *)event { return YES; }
- (BOOL)isAccessibilityElement { return !self.hidden; }
- (NSString *)accessibilityRole { return NSAccessibilityTextAreaRole; }
- (NSString *)accessibilityLabel { return L(@"native.terminalLabel",@"Ghostty terminal"); }
- (NSString *)accessibilityHelp { return self.cwd ?: L(@"native.terminalHelp",@"Native terminal content"); }
- (BOOL)isAccessibilityFocused { return self.window.firstResponder==self; }
- (void)setAccessibilityFocused:(BOOL)focused { if(focused)[self.window makeFirstResponder:self]; }
- (id)accessibilityValue {
    if(!_surface)return @"";
    ghostty_selection_s selection={.top_left={.tag=GHOSTTY_POINT_SCREEN,.coord=GHOSTTY_POINT_COORD_TOP_LEFT},.bottom_right={.tag=GHOSTTY_POINT_SCREEN,.coord=GHOSTTY_POINT_COORD_BOTTOM_RIGHT}};
    ghostty_text_s text={0};if(!ghostty_surface_read_text(_surface,selection,&text))return @"";
    NSString *value=[[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
    ghostty_surface_free_text(_surface,&text);return value;
}
- (NSString *)exportText {
    if(!_surface)return nil;
    // SCREEN coordinates address Ghostty's retained screen, including scrollback.
    ghostty_selection_s selection={.top_left={.tag=GHOSTTY_POINT_SCREEN,.coord=GHOSTTY_POINT_COORD_TOP_LEFT},.bottom_right={.tag=GHOSTTY_POINT_SCREEN,.coord=GHOSTTY_POINT_COORD_BOTTOM_RIGHT}};
    ghostty_text_s text={0};if(!ghostty_surface_read_text(_surface,selection,&text))return nil;
    NSString *value=[[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
    ghostty_surface_free_text(_surface,&text);return value;
}
- (NSString *)exportBaseName {
    NSString *base=self.title.length?self.title:self.cwd.lastPathComponent;
    if(!base.length)base=@"terminal";
    NSCharacterSet *invalid=[NSCharacterSet characterSetWithCharactersInString:@"/:\\0"];
    base=[[base componentsSeparatedByCharactersInSet:invalid] componentsJoinedByString:@"-"];
    return base.length?base:@"terminal";
}
- (void)exportAsMarkdown:(id)sender {
    NSString *text=[self exportText];if(!text)return;
    NSUInteger longest=0,current=0;
    for(NSUInteger i=0;i<text.length;i++){if([text characterAtIndex:i]=='`'){current++;longest=MAX(longest,current);}else current=0;}
    NSString *fence=[@"" stringByPaddingToLength:MAX((NSUInteger)3,longest+1) withString:@"`" startingAtIndex:0];
    NSString *markdown=[NSString stringWithFormat:@"%@\n\n%@\n%@\n",fence,text,fence];
    NSSavePanel *panel=[NSSavePanel savePanel];UTType *markdownType=[UTType typeWithFilenameExtension:@"md"] ?: UTTypePlainText;panel.allowedContentTypes=@[markdownType];panel.nameFieldStringValue=[[self exportBaseName] stringByAppendingPathExtension:@"md"];
    if([panel runModal]!=NSModalResponseOK||!panel.URL)return;
    NSError *error=nil;if(![markdown writeToURL:panel.URL atomically:YES encoding:NSUTF8StringEncoding error:&error]){NSAlert *alert=[NSAlert new];alert.messageText=L(@"native.exportMarkdownFailed",@"Could not export Markdown");alert.informativeText=error.localizedDescription ?: L(@"native.writeFailed",@"Failed to write file");[alert runModal];}
}
- (void)exportAsPDF:(id)sender {
    NSString *text=[self exportText];if(!text)return;
    NSSavePanel *panel=[NSSavePanel savePanel];panel.allowedContentTypes=@[UTTypePDF];panel.nameFieldStringValue=[[self exportBaseName] stringByAppendingPathExtension:@"pdf"];
    if([panel runModal]!=NSModalResponseOK||!panel.URL)return;
    NSPrintInfo *info=[NSPrintInfo.sharedPrintInfo copy];info.paperSize=NSMakeSize(595.28,841.89);info.topMargin=36;info.bottomMargin=36;info.leftMargin=36;info.rightMargin=36;info.horizontalPagination=NSPrintingPaginationModeFit;info.verticalPagination=NSPrintingPaginationModeAutomatic;
    CGFloat contentWidth=info.paperSize.width-info.leftMargin-info.rightMargin;
    NSTextView *view=[[NSTextView alloc] initWithFrame:NSMakeRect(0,0,contentWidth,1)];view.editable=NO;view.selectable=YES;view.font=[NSFont userFixedPitchFontOfSize:10] ?: [NSFont monospacedSystemFontOfSize:10 weight:NSFontWeightRegular];view.string=text;view.textContainer.containerSize=NSMakeSize(contentWidth,CGFLOAT_MAX);view.textContainer.widthTracksTextView=YES;view.verticallyResizable=YES;view.horizontallyResizable=NO;
    [view.layoutManager ensureLayoutForTextContainer:view.textContainer];
    CGFloat contentHeight=MAX(1,NSMaxY([view.layoutManager usedRectForTextContainer:view.textContainer]));view.frame=NSMakeRect(0,0,contentWidth,contentHeight);
    NSData *pdf=[NSMutableData data];NSPrintOperation *operation=[NSPrintOperation PDFOperationWithView:view insideRect:view.bounds toData:(NSMutableData *)pdf printInfo:info];
    NSError *error=nil;BOOL printed=operation&&[operation runOperation];
    if(!printed||![pdf writeToURL:panel.URL options:NSDataWritingAtomic error:&error]){NSAlert *alert=[NSAlert new];alert.messageText=L(@"native.exportPdfFailed",@"Could not export PDF");alert.informativeText=error.localizedDescription ?: L(@"native.pdfFailed",@"Failed to generate PDF");[alert runModal];}
}
- (NSMenu *)menuForEvent:(NSEvent *)event {
    if(!_surface)return nil;
    [self.window makeFirstResponder:self];
    NSMenu *menu=[NSMenu new];menu.autoenablesItems=NO;
    for(NSArray *entry in @[@[L(@"native.copy",@"Copy"),NSStringFromSelector(@selector(copy:))],@[L(@"native.paste",@"Paste"),NSStringFromSelector(@selector(paste:))],@[L(@"native.selectAll",@"Select All"),NSStringFromSelector(@selector(selectAll:))],@[L(@"native.clearScreen",@"Clear Screen"),NSStringFromSelector(@selector(clearScreen:))]]){
        NSMenuItem *item=[[NSMenuItem alloc] initWithTitle:entry[0] action:NSSelectorFromString(entry[1]) keyEquivalent:@""];item.target=self;[menu addItem:item];
    }
    [menu addItem:NSMenuItem.separatorItem];
    NSMenuItem *export=[[NSMenuItem alloc] initWithTitle:L(@"native.export",@"Export Contents") action:nil keyEquivalent:@""];
    NSMenu *submenu=[NSMenu new];NSMenuItem *markdown=[[NSMenuItem alloc] initWithTitle:@"Markdown…" action:@selector(exportAsMarkdown:) keyEquivalent:@""];markdown.target=self;[submenu addItem:markdown];NSMenuItem *pdf=[[NSMenuItem alloc] initWithTitle:@"PDF…" action:@selector(exportAsPDF:) keyEquivalent:@""];pdf.target=self;[submenu addItem:pdf];export.submenu=submenu;[menu addItem:export];
    return menu;
}
- (void)clearScreen:(id)sender { [self runBinding:"clear_screen"]; }
- (NSRange)accessibilitySelectedTextRange { return self.selectedRange; }
- (NSString *)accessibilitySelectedText {
    ghostty_text_s text={0};if(!_surface||!ghostty_surface_read_selection(_surface,&text))return @"";
    NSString *value=[[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
    ghostty_surface_free_text(_surface,&text);return value;
}
- (BOOL)acceptsFirstResponder { return YES; }
- (BOOL)becomeFirstResponder {
    if (_surface) ghostty_surface_set_focus(_surface,true);
    lastWindow=_owner;
    emit(_owner,@{@"type":@"focus",@"id":self.identifier});
    return YES;
}
- (BOOL)resignFirstResponder { if (_surface) ghostty_surface_set_focus(_surface,false); [self unmarkText]; return YES; }
- (void)viewDidMoveToWindow { [super viewDidMoveToWindow]; [self syncSize]; }
- (void)viewDidChangeBackingProperties { [super viewDidChangeBackingProperties]; [self syncSize]; }
- (void)setFrameSize:(NSSize)size { [super setFrameSize:size]; [self syncSize]; }
- (void)syncSize {
    if (!_surface) return;
    // libghostty installs its own layer and sets contentsScale only once, at surface
    // creation. AppKit never updates a host-provided layer, so after the window moves
    // to a display with a different scale the stale value makes the rendered frame
    // display magnified (or shrunk). Keep it in sync like Ghostty.app does.
    CGFloat layerScale=self.window.backingScaleFactor ?: 1;
    if (self.layer && self.layer.contentsScale!=layerScale) {
        [CATransaction begin];[CATransaction setDisableActions:YES];
        self.layer.contentsScale=layerScale;
        [CATransaction commit];
    }
    if (self.hidden || self.bounds.size.width < 1 || self.bounds.size.height < 1) return;
    NSSize backingSize=[self convertSizeToBacking:self.bounds.size];
    double scaleX=backingSize.width/self.bounds.size.width;
    double scaleY=backingSize.height/self.bounds.size.height;
    if(!isfinite(scaleX)||scaleX<=0)scaleX=1;
    if(!isfinite(scaleY)||scaleY<=0)scaleY=1;
    ghostty_surface_set_content_scale(_surface,scaleX,scaleY);
    ghostty_surface_set_size(_surface,(uint32_t)lround(backingSize.width),(uint32_t)lround(backingSize.height));
}
- (void)updateTrackingAreas {
    [super updateTrackingAreas];
    if (_tracking) [self removeTrackingArea:_tracking];
    _tracking=[[NSTrackingArea alloc] initWithRect:NSZeroRect options:NSTrackingMouseMoved|NSTrackingMouseEnteredAndExited|NSTrackingActiveInKeyWindow|NSTrackingInVisibleRect owner:self userInfo:nil];
    [self addTrackingArea:_tracking];
}
- (void)drawRect:(NSRect)rect { if (_surface) ghostty_surface_refresh(_surface); }
- (void)sendKey:(NSEvent *)event action:(ghostty_input_action_e)action text:(NSString *)text composing:(BOOL)composing translationFlags:(NSEventModifierFlags)translationFlags {
    if (!_surface) return;
    ghostty_input_key_s key=keyEvent(event,action);
    key.composing=composing;
    const char *utf8=text.UTF8String;
    if (utf8 && text.length) {
        unichar first=[text characterAtIndex:0];
        if(first>=0x20&&first!=0x7f&&!(first>=0xF700&&first<=0xF8FF))key.text=utf8;
    }
    key.consumed_mods=mods(translationFlags) & ~(GHOSTTY_MODS_CTRL|GHOSTTY_MODS_SUPER);
    BOOL result=ghostty_surface_key(_surface,key);
    HG_INPUT_TRACE(@"surface-key",event,text,result);
}
// An exception escaping an input handler unwinds into tao's Rust sendEvent: frame and aborts the app.
- (void)reportInputException:(NSException *)exception {
    emit(_owner,@{@"type":@"warning",@"message":[NSString stringWithFormat:@"鍵盤輸入失敗：%@ %@",exception.name,exception.reason]});
}
- (void)keyDown:(NSEvent *)event {
    @try { [self handleKeyDown:event]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)syncPreedit:(BOOL)clearIfNeeded {
    if (!_surface) return;
    if (_marked.length) {
        const char *utf8=_marked.string.UTF8String;
        ghostty_surface_preedit(_surface,utf8,[_marked.string lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
    } else if (clearIfNeeded) {
        ghostty_surface_preedit(_surface,NULL,0);
    }
}
- (void)handleKeyDown:(NSEvent *)event {
    HG_INPUT_TRACE(@"key-down",event,nil,YES);
    if (!_surface) {
        [self interpretKeyEvents:@[event]];
        HG_INPUT_TRACE(@"key-down-no-surface",event,nil,NO);
        return;
    }
    BOOL markedBefore=self.hasMarkedText;
    NSString *layoutBefore=markedBefore?nil:keyboardLayoutID();
    ghostty_input_action_e action=event.isARepeat?GHOSTTY_ACTION_REPEAT:GHOSTTY_ACTION_PRESS;
    ghostty_input_mods_e translated=ghostty_surface_key_translation_mods(_surface,mods(event.modifierFlags));
    NSEventModifierFlags flags=event.modifierFlags;
    const NSEventModifierFlags bits[]={NSEventModifierFlagShift,NSEventModifierFlagControl,NSEventModifierFlagOption,NSEventModifierFlagCommand};
    const int values[]={GHOSTTY_MODS_SHIFT,GHOSTTY_MODS_CTRL,GHOSTTY_MODS_ALT,GHOSTTY_MODS_SUPER};
    for(int i=0;i<4;i++) { if(translated&values[i]) flags|=bits[i]; else flags&=~bits[i]; }
    NSEvent *translationEvent=event;
    if(flags!=event.modifierFlags) {
        translationEvent=[NSEvent keyEventWithType:event.type location:event.locationInWindow modifierFlags:flags timestamp:event.timestamp windowNumber:event.windowNumber context:nil characters:[event charactersByApplyingModifiers:flags] ?: @"" charactersIgnoringModifiers:event.charactersIgnoringModifiers ?: @"" isARepeat:event.isARepeat keyCode:event.keyCode] ?: event;
    }
    NSMutableArray<NSString *> *previousKeyTexts=activeKeyTexts;
    activeKeyTexts=[NSMutableArray array];
    self.hasLastPerformKeyEvent=NO;
    @try {
        [self interpretKeyEvents:@[translationEvent]];
        NSArray<NSString *> *texts=[activeKeyTexts copy];
        HG_INPUT_TRACE(@"interpret",event,texts.lastObject,YES);
        NSString *layoutAfter=keyboardLayoutID();
        if(!markedBefore && ![(layoutBefore ?: @"") isEqualToString:(layoutAfter ?: @"")]) {
            HG_INPUT_TRACE(@"input-source-changed",event,texts.lastObject,NO);
            return;
        }
        [self syncPreedit:markedBefore];
        if(texts.count) {
            for(NSString *text in texts) [self sendKey:event action:action text:text composing:NO translationFlags:flags];
        } else {
            [self sendKey:event action:action text:ghosttyCharacters(translationEvent) composing:self.hasMarkedText||markedBefore translationFlags:flags];
        }
    } @finally {
        activeKeyTexts=previousKeyTexts;
    }
}
- (void)runBinding:(const char *)action {
    @try { if(_surface)ghostty_surface_binding_action(_surface,action,strlen(action)); }
    @catch(NSException *exception) { emit(_owner,@{@"type":@"warning",@"message":[NSString stringWithFormat:@"終端動作失敗：%@ %@",exception.name,exception.reason]}); }
}
- (void)paste:(id)sender { [self runBinding:"paste_from_clipboard"]; }
- (void)pasteAsPlainText:(id)sender { [self paste:sender]; }
- (void)copy:(id)sender { [self runBinding:"copy_to_clipboard"]; }
- (void)selectAll:(id)sender { [self runBinding:"select_all"]; }
- (void)find:(id)sender { [self runBinding:"start_search"]; }
- (BOOL)validateUserInterfaceItem:(id<NSValidatedUserInterfaceItem>)item { return _surface!=NULL; }
- (void)keyUp:(NSEvent *)event {
    @try { [self sendKey:event action:GHOSTTY_ACTION_RELEASE text:nil composing:NO translationFlags:event.modifierFlags]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)flagsChanged:(NSEvent *)event {
    @try { [self handleFlagsChanged:event]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)handleFlagsChanged:(NSEvent *)event {
    ghostty_input_mods_e mod=0;
    switch(event.keyCode){
        case 0x39:mod=GHOSTTY_MODS_CAPS;break;
        case 0x38:case 0x3C:mod=GHOSTTY_MODS_SHIFT;break;
        case 0x3B:case 0x3E:mod=GHOSTTY_MODS_CTRL;break;
        case 0x3A:case 0x3D:mod=GHOSTTY_MODS_ALT;break;
        case 0x37:case 0x36:mod=GHOSTTY_MODS_SUPER;break;
        default:return;
    }
    ghostty_input_mods_e active=mods(event.modifierFlags);
    ghostty_input_action_e action=GHOSTTY_ACTION_RELEASE;
    if(active&mod){
        BOOL sidePressed=YES;
        switch(event.keyCode){
            case 0x3C:sidePressed=(event.modifierFlags&NX_DEVICERSHIFTKEYMASK)!=0;break;
            case 0x3E:sidePressed=(event.modifierFlags&NX_DEVICERCTLKEYMASK)!=0;break;
            case 0x3D:sidePressed=(event.modifierFlags&NX_DEVICERALTKEYMASK)!=0;break;
            case 0x36:sidePressed=(event.modifierFlags&NX_DEVICERCMDKEYMASK)!=0;break;
            default:break;
        }
        if(sidePressed)action=GHOSTTY_ACTION_PRESS;
    }
    // While composing, swallow presses but still forward releases so Ghostty never keeps a stuck modifier.
    if(self.hasMarkedText&&action==GHOSTTY_ACTION_PRESS)return;
    [self sendKey:event action:action text:nil composing:NO translationFlags:event.modifierFlags];
}
- (BOOL)performKeyEquivalent:(NSEvent *)event {
    @try { return [self handleKeyEquivalent:event]; }
    @catch(NSException *exception) { [self reportInputException:exception]; return NO; }
}
- (BOOL)handleKeyEquivalent:(NSEvent *)event {
    if(!_surface||event.type!=NSEventTypeKeyDown||self.window.firstResponder!=self)return NO;
    ghostty_input_key_s key=keyEvent(event,GHOSTTY_ACTION_PRESS);
    NSString *text=event.characters;
    if(text.length) key.text=text.UTF8String;
    if(ghostty_surface_key_is_binding(_surface,key,NULL)) {
        HG_INPUT_TRACE(@"key-binding",event,text,YES);
        [self keyDown:event];
        return YES;
    }
    NSString *equivalent=nil;
    NSString *unmodified=event.charactersIgnoringModifiers;
    if([unmodified isEqualToString:@"\r"]){
        if(!(event.modifierFlags&NSEventModifierFlagControl))return NO;
        equivalent=@"\r";
    }else if([unmodified isEqualToString:@"/"]){
        NSEventModifierFlags other=event.modifierFlags&(NSEventModifierFlagShift|NSEventModifierFlagCommand|NSEventModifierFlagOption);
        if(!(event.modifierFlags&NSEventModifierFlagControl)||other)return NO;
        equivalent=@"_";
    }else{
        if(event.timestamp==0)return NO;
        if(!(event.modifierFlags&(NSEventModifierFlagCommand|NSEventModifierFlagControl))){self.hasLastPerformKeyEvent=NO;return NO;}
        if(self.hasLastPerformKeyEvent){
            BOOL same=self.lastPerformKeyEvent==event.timestamp;
            self.hasLastPerformKeyEvent=NO;
            if(!same)return NO;
            equivalent=event.characters ?: @"";
        }else{
            self.lastPerformKeyEvent=event.timestamp;
            self.hasLastPerformKeyEvent=YES;
            return NO;
        }
    }
    NSEvent *finalEvent=[NSEvent keyEventWithType:NSEventTypeKeyDown location:event.locationInWindow modifierFlags:event.modifierFlags timestamp:event.timestamp windowNumber:event.windowNumber context:nil characters:equivalent charactersIgnoringModifiers:equivalent isARepeat:event.isARepeat keyCode:event.keyCode];
    if(finalEvent)[self keyDown:finalEvent];
    HG_INPUT_TRACE(@"key-equivalent",event,text,finalEvent!=nil);
    return finalEvent!=nil;
}
- (void)insertText:(id)string { [self insertText:string replacementRange:NSMakeRange(NSNotFound,0)]; }
- (void)insertText:(id)string replacementRange:(NSRange)range {
    @try { [self handleInsertText:string]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)handleInsertText:(id)string {
    if(!NSApp.currentEvent)return;
    // Input methods may reuse and clear the attributed string after this call
    // returns, and -string is its live backing store, so keep a snapshot.
    NSString *text=[string isKindOfClass:NSAttributedString.class]?[[string string] copy]:([string isKindOfClass:NSString.class]?[string copy]:nil);
    if(!text)return;
    if (activeKeyTexts) {
        [activeKeyTexts addObject:text];
        HG_INPUT_TRACE(@"insert-text-accumulated",NSApp.currentEvent,text,YES);
    } else if (_surface) {
        ghostty_surface_text(_surface,text.UTF8String,[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
        HG_INPUT_TRACE(@"insert-text-raw",NSApp.currentEvent,text,YES);
    }
    [self unmarkText];
}
- (void)setMarkedText:(id)string selectedRange:(NSRange)selection replacementRange:(NSRange)range {
    @try { [self handleMarkedText:string]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)handleMarkedText:(id)string {
    _marked=[string isKindOfClass:NSAttributedString.class]?[[NSMutableAttributedString alloc] initWithAttributedString:string]:[[NSMutableAttributedString alloc] initWithString:string];
    if(!activeKeyTexts && _surface)ghostty_surface_preedit(_surface,_marked.string.UTF8String,[_marked.string lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);
    HG_INPUT_TRACE(@"set-marked-text",NSApp.currentEvent,_marked.string,YES);
}
- (void)unmarkText { _marked=[[NSMutableAttributedString alloc] initWithString:@""]; if(_surface)ghostty_surface_preedit(_surface,NULL,0); }
- (BOOL)hasMarkedText { return _marked.length>0; }
- (NSRange)markedRange { return self.hasMarkedText?NSMakeRange(0,_marked.length):NSMakeRange(NSNotFound,0); }
- (NSRange)selectedRange { ghostty_text_s text={0}; if(_surface && ghostty_surface_read_selection(_surface,&text)){NSRange r=NSMakeRange(text.offset_start,text.offset_len);ghostty_surface_free_text(_surface,&text);return r;}return NSMakeRange(NSNotFound,0); }
- (NSArray<NSAttributedStringKey> *)validAttributesForMarkedText { return @[]; }
- (NSAttributedString *)attributedSubstringForProposedRange:(NSRange)range actualRange:(NSRangePointer)actual {
    ghostty_text_s text={0}; if(!_surface || !ghostty_surface_read_selection(_surface,&text))return nil;
    NSString *value=[[NSString alloc] initWithBytes:text.text length:text.text_len encoding:NSUTF8StringEncoding] ?: @"";
    if(actual)*actual=NSMakeRange(text.offset_start,text.offset_len);
    ghostty_surface_free_text(_surface,&text);return [[NSAttributedString alloc] initWithString:value];
}
- (NSUInteger)characterIndexForPoint:(NSPoint)point { return 0; }
- (NSRect)firstRectForCharacterRange:(NSRange)range actualRange:(NSRangePointer)actual {
    double x=0,y=0,w=0,h=0;if(_surface)ghostty_surface_ime_point(_surface,&x,&y,&w,&h);
    if(actual)*actual=self.markedRange;
    NSRect rect=[self convertRect:NSMakeRect(x,y,w,h) toView:nil];return [self.window convertRectToScreen:rect];
}
- (void)doCommandBySelector:(SEL)selector {
    @try { [self handleCommand:selector]; }
    @catch(NSException *exception) { [self reportInputException:exception]; }
}
- (void)handleCommand:(SEL)selector {
    NSEvent *current=NSApp.currentEvent;
    if(self.hasLastPerformKeyEvent&&current&&self.lastPerformKeyEvent==current.timestamp){
        [NSApp sendEvent:current];
        return;
    }
    if(!_surface)return;
    if(selector==@selector(moveToBeginningOfDocument:))[self runBinding:"scroll_to_top"];
    else if(selector==@selector(moveToEndOfDocument:))[self runBinding:"scroll_to_bottom"];
}
- (void)mouseMoved:(NSEvent *)event { if(!_surface)return;NSPoint p=[self convertPoint:event.locationInWindow fromView:nil];ghostty_surface_mouse_pos(_surface,p.x,p.y,mods(event.modifierFlags)); }
- (void)mouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)rightMouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)otherMouseDragged:(NSEvent *)event { [self mouseMoved:event]; }
- (void)mouseEntered:(NSEvent *)event { emit(_owner,@{@"type":@"pointer-terminal",@"on":@YES});[self mouseMoved:event]; }
- (void)mouseExited:(NSEvent *)event { emit(_owner,@{@"type":@"pointer-terminal",@"on":@NO});[NSCursor.arrowCursor set]; }
- (void)mouseButton:(NSEvent *)event pressed:(BOOL)pressed {
    if(!_surface)return;
    if(pressed)[self.window makeFirstResponder:self];
    [self mouseMoved:event];
    ghostty_input_mouse_button_e button=event.buttonNumber==0?GHOSTTY_MOUSE_LEFT:event.buttonNumber==1?GHOSTTY_MOUSE_RIGHT:event.buttonNumber==2?GHOSTTY_MOUSE_MIDDLE:GHOSTTY_MOUSE_UNKNOWN;
    ghostty_surface_mouse_button(_surface,pressed?GHOSTTY_MOUSE_PRESS:GHOSTTY_MOUSE_RELEASE,button,mods(event.modifierFlags));
}
- (void)mouseDown:(NSEvent *)event { [self mouseButton:event pressed:YES]; }
- (void)mouseUp:(NSEvent *)event { [self mouseButton:event pressed:NO]; }
- (void)otherMouseDown:(NSEvent *)event { [self mouseButton:event pressed:YES]; }
- (void)otherMouseUp:(NSEvent *)event { [self mouseButton:event pressed:NO]; }
- (void)scrollWheel:(NSEvent *)event {
    if(!_surface)return;
    int momentum=0;
    switch(event.momentumPhase){case NSEventPhaseBegan:momentum=GHOSTTY_MOUSE_MOMENTUM_BEGAN;break;case NSEventPhaseChanged:momentum=GHOSTTY_MOUSE_MOMENTUM_CHANGED;break;case NSEventPhaseEnded:momentum=GHOSTTY_MOUSE_MOMENTUM_ENDED;break;default:break;}
    ghostty_surface_mouse_scroll(_surface,event.scrollingDeltaX,event.scrollingDeltaY,(event.hasPreciseScrollingDeltas?1:0)|(momentum<<1));
}
@end

static NSString *processName(struct proc_bsdinfo info) { return str(info.pbi_name[0]?info.pbi_name:info.pbi_comm); }
// Idle background processes (e.g. dotnet build servers) outlive their command
// on purpose. They are not user jobs, so they must not trigger the close
// confirmation; they stay in `pids` and are still killed. The rules come from
// src/prompt-rules.json via the "idle-rules" op: {name, args?} where name is the
// exact process name and every arg must appear in the command line.
static NSArray<NSDictionary *> *idleRules = nil;
static NSString *processArgs(int pid) {
    int mib[3]={CTL_KERN,KERN_PROCARGS2,pid};size_t size=0;
    if(sysctl(mib,3,NULL,&size,NULL,0)!=0||size<=sizeof(int))return @"";
    char *buffer=malloc(size);if(!buffer)return @"";
    NSString *args=@"";
    if(sysctl(mib,3,buffer,&size,NULL,0)==0)args=[[NSString alloc] initWithBytes:buffer+sizeof(int) length:size-sizeof(int) encoding:NSUTF8StringEncoding]?:@"";
    free(buffer);return args;
}
static BOOL idleProcess(int pid, NSString *name) {
    NSString *args=nil;
    for(NSDictionary *rule in idleRules){
        if(![rule[@"name"] isEqualToString:name])continue;
        NSArray *need=rule[@"args"];if(![need isKindOfClass:[NSArray class]]||!need.count)return YES;
        if(!args)args=processArgs(pid);
        BOOL all=YES;for(id item in need)if(![item isKindOfClass:[NSString class]]||![args containsString:item]){all=NO;break;}
        if(all)return YES;
    }
    return NO;
}
static int32_t shellPid(HGSurface *surface) {
    if(!surface.surface)return 0;
    int32_t pid=highostty_surface_pid(surface.surface);struct proc_bsdinfo root={0};
    if(pid<=0||proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&root,sizeof(root))!=sizeof(root))return 0;
    uint64_t started=root.pbi_start_tvsec*1000000ULL+root.pbi_start_tvusec;
    if(!surface.rootPid){surface.rootPid=pid;surface.rootStart=started;}
    if(surface.rootStart!=started)return 0;
    if(surface.primaryPid){struct proc_bsdinfo shell={0};if(proc_pidinfo(surface.primaryPid,PROC_PIDTBSDINFO,0,&shell,sizeof(shell))==sizeof(shell)&&shell.pbi_start_tvsec*1000000ULL+shell.pbi_start_tvusec==surface.primaryStart)return surface.primaryPid;return 0;}
    BOOL login=[processName(root) isEqualToString:@"login"];
    int32_t candidate=login?(int32_t)root.e_tpgid:pid;
    struct proc_bsdinfo info={0};
    if(login){
        pid_t children[64]={0};int bytes=proc_listpids(PROC_PPID_ONLY,(uint32_t)pid,children,sizeof(children));
        for(int index=0;index<bytes/(int)sizeof(pid_t)&&index<64;index++){struct proc_bsdinfo child={0};if(children[index]>0&&proc_pidinfo(children[index],PROC_PIDTBSDINFO,0,&child,sizeof(child))==sizeof(child)&&[@[@"zsh",@"bash",@"fish",@"sh",@"nu",@"elvish",@"tcsh",@"csh"] containsObject:processName(child)]){candidate=children[index];break;}}
    }
    if(candidate>0&&proc_pidinfo(candidate,PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)&&[@[@"zsh",@"bash",@"fish",@"sh",@"nu",@"elvish",@"tcsh",@"csh"] containsObject:processName(info)]&&(candidate==pid||info.pbi_ppid==(uint32_t)pid)){
        surface.primaryPid=candidate;surface.primaryStart=info.pbi_start_tvsec*1000000ULL+info.pbi_start_tvusec;return candidate;
    }
    return pid;
}
static HGSurface *focused(NSString *owner) {
    NSWindow *window=windows[owner ?: lastWindow];
    if([window.firstResponder isKindOfClass:HGSurface.class])return (HGSurface *)window.firstResponder;
    for(HGSurface *surface in surfaces.allValues)if([surface.owner isEqualToString:owner ?: lastWindow]&&!surface.hidden&&!surface.suspended)return surface;
    return nil;
}
static void wakeup(void *data) { dispatch_async(dispatch_get_main_queue(),^{if(engine&&!shuttingDown)ghostty_app_tick(engine);}); }
static bool readClipboard(void *data, ghostty_clipboard_e clipboard, void *state) {
    @try {
    HGSurface *surface=(__bridge HGSurface *)data;if(!surface.surface)return false;
    NSString *text=[NSPasteboard.generalPasteboard stringForType:NSPasteboardTypeString] ?: @"";
    ghostty_surface_complete_clipboard_request(surface.surface,text.UTF8String,state,false);return true;
    } @catch(NSException *exception) {HGSurface *s=(__bridge HGSurface *)data;emit(s.owner,@{@"type":@"warning",@"message":[NSString stringWithFormat:@"剪貼簿讀取失敗：%@ %@",exception.name,exception.reason]});return false;}
}
static void confirmClipboard(void *data,const char *text,void *state,ghostty_clipboard_request_e request) {
    HGSurface *surface=(__bridge HGSurface *)data;
    NSAlert *alert=[NSAlert new];alert.messageText=L(@"native.clipboardReadTitle",@"Allow the terminal to access the clipboard?");alert.informativeText=L(@"native.clipboardReadBody",@"A running program is requesting the clipboard contents.");
    [alert addButtonWithTitle:L(@"native.allow",@"Allow")];[alert addButtonWithTitle:L(@"native.cancel",@"Cancel")];
    if([alert runModal]==NSAlertFirstButtonReturn&&surface.surface)ghostty_surface_complete_clipboard_request(surface.surface,text,state,true);
}
static void writeClipboard(void *data,ghostty_clipboard_e clipboard,const ghostty_clipboard_content_s *contents,size_t count,bool confirm) {
    HGSurface *surface=(__bridge HGSurface *)data;
    // copy-on-select 寫的是 SELECTION；macOS 沒有獨立選取剪貼簿，寫進系統剪貼簿會讓誤選蓋掉資料，所以忽略。
    if(clipboard==GHOSTTY_CLIPBOARD_SELECTION){(void)surface;return;}
    if(confirm){NSAlert *alert=[NSAlert new];alert.messageText=L(@"native.clipboardWriteTitle",@"Allow the terminal to write to the clipboard?");[alert addButtonWithTitle:L(@"native.allow",@"Allow")];[alert addButtonWithTitle:L(@"native.cancel",@"Cancel")];if([alert runModal]!=NSAlertFirstButtonReturn)return;}
    for(size_t i=0;i<count;i++)if(strcmp(contents[i].mime,"text/plain")==0){[NSPasteboard.generalPasteboard clearContents];[NSPasteboard.generalPasteboard setString:str(contents[i].data) forType:NSPasteboardTypeString];break;}
    (void)surface;
}
static void closeSurface(void *data,bool alive) {
    HGSurface *surface=(__bridge HGSurface *)data;if(!surface.closing)emit(surface.owner,@{@"type":@"close-surface",@"id":surface.identifier,@"alive":@(alive)});
}
static NSDictionary *configurationInfo(void) {
    NSMutableArray *diagnostics=[NSMutableArray array];
    for(uint32_t i=0;i<ghostty_config_diagnostics_count(config);i++)[diagnostics addObject:str(ghostty_config_get_diagnostic(config,i).message)];
    ghostty_config_color_s fg={219,219,219};getConfig("foreground",&fg);
    ghostty_config_color_s cursor={255,255,255};getConfig("cursor-color",&cursor);
    float fontSize=15;getConfig("font-size",&fontSize);
    ghostty_string_s path=ghostty_config_open_path();NSString *configPath=path.ptr?[[NSString alloc] initWithBytes:path.ptr length:path.len encoding:NSUTF8StringEncoding]:@"";ghostty_string_free(path);
    return @{@"version":@"1.3.1",@"path":configPath ?: @"",@"background":hexColor(backgroundColor()),@"foreground":[NSString stringWithFormat:@"#%02x%02x%02x",fg.r,fg.g,fg.b],@"opacity":@(numberConfig("background-opacity",1)),@"fontSize":@(fontSize),@"diagnostics":diagnostics};
}
static void reloadConfig(void) {
    ghostty_config_t fresh=ghostty_config_new();ghostty_config_load_default_files(fresh);ghostty_config_load_recursive_files(fresh);ghostty_config_finalize(fresh);
    ghostty_config_t old=config;config=fresh;
    ghostty_app_update_config(engine,config);
    for(HGSurface *surface in surfaces.allValues){ghostty_surface_update_config(surface.surface,config);[surface syncSize];}
    for(NSString *label in windows){applyWindow(windows[label]);emit(label,@{@"type":@"config",@"config":configurationInfo()});}
    if(old)ghostty_config_free(old);configureGlobalKeys();
}
static CGEventRef globalKey(CGEventTapProxy proxy,CGEventType type,CGEventRef cg,void *data) {
    if(type==kCGEventTapDisabledByTimeout||type==kCGEventTapDisabledByUserInput){if(globalTap)CGEventTapEnable(globalTap,true);return cg;}
    if(type!=kCGEventKeyDown||NSApp.active||!engine)return cg;
    NSEvent *event=[NSEvent eventWithCGEvent:cg];ghostty_input_key_s key=keyEvent(event,GHOSTTY_ACTION_PRESS);
    if(ghostty_app_key(engine,key))return NULL;return cg;
}
static void configureGlobalKeys(void) {
    if(globalSource){CFRunLoopRemoveSource(CFRunLoopGetMain(),globalSource,kCFRunLoopCommonModes);CFRelease(globalSource);globalSource=NULL;}
    if(globalTap){CFMachPortInvalidate(globalTap);CFRelease(globalTap);globalTap=NULL;}
    if(!ghostty_app_has_global_keybinds(engine))return;
    globalTap=CGEventTapCreate(kCGSessionEventTap,kCGHeadInsertEventTap,kCGEventTapOptionDefault,CGEventMaskBit(kCGEventKeyDown),globalKey,NULL);
    if(!globalTap){emit(lastWindow,@{@"type":@"warning",@"message":@"全域快捷鍵無法啟用。請在系統設定 → 隱私權與安全性 → 輔助使用，允許 HiGhostty，然後重新載入設定。"});return;}
    globalSource=CFMachPortCreateRunLoopSource(kCFAllocatorDefault,globalTap,0);CFRunLoopAddSource(CFRunLoopGetMain(),globalSource,kCFRunLoopCommonModes);CGEventTapEnable(globalTap,true);
}
static void applyWindow(NSWindow *window) {
    window.opaque=NO;window.backgroundColor=NSColor.clearColor;
    if(engine)ghostty_set_window_background_blur(engine,(__bridge void *)window);
    window.hasShadow=boolConfig("macos-window-shadow",YES);
    NSString *theme=stringConfig("window-theme");
    if([theme isEqualToString:@"dark"])window.appearance=[NSAppearance appearanceNamed:NSAppearanceNameDarkAqua];else if([theme isEqualToString:@"light"])window.appearance=[NSAppearance appearanceNamed:NSAppearanceNameAqua];else window.appearance=nil;
    BOOL decorated=![stringConfig("window-decoration") isEqualToString:@"none"];
    NSWindowStyleMask style=window.styleMask;
    if(decorated)style|=NSWindowStyleMaskTitled|NSWindowStyleMaskClosable|NSWindowStyleMaskMiniaturizable|NSWindowStyleMaskResizable;
    else {style&=~NSWindowStyleMaskTitled;style|=NSWindowStyleMaskResizable;}
    window.styleMask=style;
    NSString *titlebar=stringConfig("macos-titlebar-style");
    window.titleVisibility=([titlebar isEqualToString:@"hidden"]||[titlebar isEqualToString:@"transparent"])?NSWindowTitleHidden:NSWindowTitleVisible;
    window.titlebarAppearsTransparent=[titlebar isEqualToString:@"transparent"]||[titlebar isEqualToString:@"hidden"];
    if([titlebar isEqualToString:@"hidden"])window.styleMask|=NSWindowStyleMaskFullSizeContentView;
    for(HGSurface *s in surfaces.allValues)if(s.window==window){s.layer.backgroundColor=[backgroundColor() colorWithAlphaComponent:transparencyEnabled?numberConfig("background-opacity",1):1].CGColor;}
}
static void toggleQuickTerminal(NSString *owner) {
    // Tauri creates the webview, then this host configures it as a macOS floating panel.
    NSWindow *window=windows[owner];
    if(![owner hasPrefix:@"quick-"]){emit(owner,@{@"type":@"quick-terminal"});return;}
    if(window.visible){[window orderOut:nil];return;}
    NSString *which=stringConfig("quick-terminal-screen");NSScreen *screen=window.screen ?: NSScreen.mainScreen;
    if([which isEqualToString:@"mouse"]){for(NSScreen *candidate in NSScreen.screens)if(NSPointInRect(NSEvent.mouseLocation,candidate.frame)){screen=candidate;break;}}
    else if([which isEqualToString:@"main"])screen=NSScreen.screens.firstObject;
    NSRect visible=screen.visibleFrame;
    NSString *position=stringConfig("quick-terminal-position");
    ghostty_config_quick_terminal_size_s size={0};getConfig("quick-terminal-size",&size);
    BOOL horizontal=![position isEqualToString:@"left"]&&![position isEqualToString:@"right"];
    double primary=horizontal?visible.size.height:visible.size.width,secondary=horizontal?visible.size.width:visible.size.height;
    primary=size.primary.tag==GHOSTTY_QUICK_TERMINAL_SIZE_PIXELS?size.primary.value.pixels:size.primary.tag==GHOSTTY_QUICK_TERMINAL_SIZE_PERCENTAGE?primary*size.primary.value.percentage:primary*0.4;
    secondary=size.secondary.tag==GHOSTTY_QUICK_TERMINAL_SIZE_PIXELS?size.secondary.value.pixels:size.secondary.tag==GHOSTTY_QUICK_TERMINAL_SIZE_PERCENTAGE?secondary*size.secondary.value.percentage:secondary;
    NSRect target=horizontal?NSMakeRect(NSMidX(visible)-secondary/2,visible.origin.y,secondary,primary):NSMakeRect(visible.origin.x,NSMidY(visible)-secondary/2,primary,secondary);
    if([position isEqualToString:@"right"])target.origin.x=NSMaxX(visible)-target.size.width;
    else if(![position isEqualToString:@"bottom"]&&horizontal)target.origin.y=NSMaxY(visible)-target.size.height;
    window.level=NSFloatingWindowLevel;window.styleMask&=~NSWindowStyleMaskTitled;
    NSString *spaces=stringConfig("quick-terminal-space-behavior");window.collectionBehavior=NSWindowCollectionBehaviorFullScreenAuxiliary|([spaces isEqualToString:@"move"]?NSWindowCollectionBehaviorMoveToActiveSpace:NSWindowCollectionBehaviorCanJoinAllSpaces);
    [window setFrame:target display:YES];[NSApp activateIgnoringOtherApps:YES];[window makeKeyAndOrderFront:nil];
    HGSurface *s=focused(owner);if(s)[window makeFirstResponder:s];
}
static bool nativeAction(ghostty_app_t app,ghostty_target_s target,ghostty_action_s action) {
    HGSurface *surface=target.tag==GHOSTTY_TARGET_SURFACE?(__bridge HGSurface *)ghostty_surface_userdata(target.target.surface):focused(lastWindow);
    NSString *owner=surface.owner ?: lastWindow;NSString *identifier=surface.identifier ?: @"";NSWindow *window=windows[owner];
    NSDictionary *event=nil;
    switch(action.tag) {
        case GHOSTTY_ACTION_PWD: shellPid(surface);surface.cwd=str(action.action.pwd.pwd);event=@{@"type":@"cwd",@"id":identifier,@"path":surface.cwd};break;
        case GHOSTTY_ACTION_SET_TITLE: surface.title=str(action.action.set_title.title);event=@{@"type":@"title",@"id":identifier,@"title":surface.title};break;
        case GHOSTTY_ACTION_SET_TAB_TITLE:event=@{@"type":@"tab-title",@"id":identifier,@"title":str(action.action.set_tab_title.title)};break;
        case GHOSTTY_ACTION_NEW_WINDOW:event=@{@"type":@"new-window",@"id":identifier};break;
        case GHOSTTY_ACTION_NEW_TAB:event=@{@"type":@"new-tab",@"id":identifier};break;
        case GHOSTTY_ACTION_NEW_SPLIT:event=@{@"type":@"split",@"id":identifier,@"direction":@(action.action.new_split)};break;
        case GHOSTTY_ACTION_CLOSE_TAB:event=@{@"type":@"close-tab",@"id":identifier,@"mode":@(action.action.close_tab_mode)};break;
        case GHOSTTY_ACTION_GOTO_TAB:event=@{@"type":@"goto-tab",@"value":@(action.action.goto_tab)};break;
        case GHOSTTY_ACTION_MOVE_TAB:event=@{@"type":@"move-tab",@"value":@(action.action.move_tab.amount)};break;
        case GHOSTTY_ACTION_GOTO_SPLIT:event=@{@"type":@"goto-split",@"id":identifier,@"value":@(action.action.goto_split)};break;
        case GHOSTTY_ACTION_RESIZE_SPLIT:event=@{@"type":@"resize-split",@"id":identifier,@"direction":@(action.action.resize_split.direction),@"amount":@(action.action.resize_split.amount)};break;
        case GHOSTTY_ACTION_EQUALIZE_SPLITS:event=@{@"type":@"equalize",@"id":identifier};break;
        case GHOSTTY_ACTION_TOGGLE_SPLIT_ZOOM:event=@{@"type":@"zoom",@"id":identifier};break;
        case GHOSTTY_ACTION_GOTO_WINDOW:event=@{@"type":@"goto-window",@"value":@(action.action.goto_window)};break;
        case GHOSTTY_ACTION_CLOSE_WINDOW:event=@{@"type":@"close-window"};break;
        case GHOSTTY_ACTION_QUIT:case GHOSTTY_ACTION_CLOSE_ALL_WINDOWS:event=@{@"type":@"quit"};break;
        case GHOSTTY_ACTION_TOGGLE_TAB_OVERVIEW:event=@{@"type":@"overview"};break;
        case GHOSTTY_ACTION_TOGGLE_COMMAND_PALETTE:event=@{@"type":@"command-palette"};break;
        case GHOSTTY_ACTION_PROMPT_TITLE:event=@{@"type":@"prompt-title",@"id":identifier};break;
        case GHOSTTY_ACTION_START_SEARCH:event=@{@"type":@"search",@"id":identifier,@"needle":str(action.action.start_search.needle)};break;
        case GHOSTTY_ACTION_END_SEARCH:event=@{@"type":@"end-search"};break;
        case GHOSTTY_ACTION_SEARCH_TOTAL:event=@{@"type":@"search-total",@"value":@(action.action.search_total.total)};break;
        case GHOSTTY_ACTION_SEARCH_SELECTED:event=@{@"type":@"search-selected",@"value":@(action.action.search_selected.selected)};break;
        case GHOSTTY_ACTION_SHOW_CHILD_EXITED:event=@{@"type":@"exited",@"id":identifier,@"code":@(action.action.child_exited.exit_code)};break;
        case GHOSTTY_ACTION_OPEN_CONFIG:{ghostty_string_s path=ghostty_config_open_path();NSString *p=path.ptr?[[NSString alloc] initWithBytes:path.ptr length:path.len encoding:NSUTF8StringEncoding]:nil;if(p)[NSWorkspace.sharedWorkspace openURL:[NSURL fileURLWithPath:p]];ghostty_string_free(path);return true;}
        case GHOSTTY_ACTION_RELOAD_CONFIG:dispatch_async(dispatch_get_main_queue(),^{reloadConfig();});return true;
        case GHOSTTY_ACTION_INITIAL_SIZE:return true; // 終端機跟隨視窗，不反過來依終端機大小改視窗
        case GHOSTTY_ACTION_SIZE_LIMIT:return true;
        case GHOSTTY_ACTION_CELL_SIZE:return true;
        case GHOSTTY_ACTION_TOGGLE_FULLSCREEN:[window toggleFullScreen:nil];return true;
        case GHOSTTY_ACTION_TOGGLE_MAXIMIZE:[window zoom:nil];return true;
        case GHOSTTY_ACTION_TOGGLE_WINDOW_DECORATIONS:window.styleMask^=NSWindowStyleMaskTitled;return true;
        case GHOSTTY_ACTION_TOGGLE_QUICK_TERMINAL:toggleQuickTerminal(owner);return true;
        case GHOSTTY_ACTION_TOGGLE_VISIBILITY:if(window.visible)[window orderOut:nil];else{[NSApp activateIgnoringOtherApps:YES];[window makeKeyAndOrderFront:nil];}return true;
        case GHOSTTY_ACTION_PRESENT_TERMINAL:[NSApp activateIgnoringOtherApps:YES];[window makeKeyAndOrderFront:nil];if(surface)[window makeFirstResponder:surface];return true;
        case GHOSTTY_ACTION_FLOAT_WINDOW:window.level=window.level==NSNormalWindowLevel?NSFloatingWindowLevel:NSNormalWindowLevel;return true;
        case GHOSTTY_ACTION_TOGGLE_BACKGROUND_OPACITY:transparencyEnabled=!transparencyEnabled;for(NSWindow *w in windows.allValues)applyWindow(w);return true;
        case GHOSTTY_ACTION_SECURE_INPUT:if(action.action.secure_input==GHOSTTY_SECURE_INPUT_ON)EnableSecureEventInput();else if(action.action.secure_input==GHOSTTY_SECURE_INPUT_OFF)DisableSecureEventInput();else if(IsSecureEventInputEnabled())DisableSecureEventInput();else EnableSecureEventInput();return true;
        case GHOSTTY_ACTION_CONFIG_CHANGE:return true;
        case GHOSTTY_ACTION_RENDERER_HEALTH:if(action.action.renderer_health==GHOSTTY_RENDERER_HEALTH_UNHEALTHY)emit(owner,@{@"type":@"warning",@"message":@"Ghostty Metal renderer 無法正常繪製"});return true;
        case GHOSTTY_ACTION_QUIT_TIMER:return true;
        case GHOSTTY_ACTION_COLOR_CHANGE:emit(owner,@{@"type":@"color",@"kind":@(action.action.color_change.kind),@"color":[NSString stringWithFormat:@"#%02x%02x%02x",action.action.color_change.r,action.action.color_change.g,action.action.color_change.b]});return true;
        case GHOSTTY_ACTION_MOUSE_SHAPE:if(action.action.mouse_shape==GHOSTTY_MOUSE_SHAPE_TEXT)[NSCursor.IBeamCursor set];else if(action.action.mouse_shape==GHOSTTY_MOUSE_SHAPE_POINTER)[NSCursor.pointingHandCursor set];else [NSCursor.arrowCursor set];return true;
        case GHOSTTY_ACTION_MOUSE_VISIBILITY:[NSCursor setHiddenUntilMouseMoves:action.action.mouse_visibility==GHOSTTY_MOUSE_HIDDEN];return true;
        case GHOSTTY_ACTION_MOUSE_OVER_LINK:return true;
        case GHOSTTY_ACTION_RENDER:if(surface.surface)ghostty_surface_draw(surface.surface);return true;
        case GHOSTTY_ACTION_SCROLLBAR:return true;
        case GHOSTTY_ACTION_RING_BELL:NSBeep();emit(owner,@{@"type":@"bell",@"id":identifier});return true;
        case GHOSTTY_ACTION_OPEN_URL:{NSString *url=[[NSString alloc] initWithBytes:action.action.open_url.url length:action.action.open_url.len encoding:NSUTF8StringEncoding];NSURL *u=[NSURL URLWithString:url];if(u)[NSWorkspace.sharedWorkspace openURL:u];return true;}
        case GHOSTTY_ACTION_DESKTOP_NOTIFICATION:{UNMutableNotificationContent *content=[UNMutableNotificationContent new];content.title=str(action.action.desktop_notification.title);content.body=str(action.action.desktop_notification.body);emit(owner,@{@"type":@"notify",@"id":identifier,@"title":content.title,@"body":content.body});[UNUserNotificationCenter.currentNotificationCenter requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL allowed,NSError *error){if(allowed)[UNUserNotificationCenter.currentNotificationCenter addNotificationRequest:[UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil] withCompletionHandler:nil];}];return true;}
        case GHOSTTY_ACTION_PROGRESS_REPORT:case GHOSTTY_ACTION_COMMAND_FINISHED:case GHOSTTY_ACTION_KEY_SEQUENCE:case GHOSTTY_ACTION_KEY_TABLE:case GHOSTTY_ACTION_READONLY:return true;
        case GHOSTTY_ACTION_UNDO:event=@{@"type":@"undo"};break;
        case GHOSTTY_ACTION_REDO:event=@{@"type":@"redo"};break;
        default:emit(owner,@{@"type":@"warning",@"message":[NSString stringWithFormat:@"此原生宿主尚未實作 Ghostty action %d",action.tag]});return false;
    }
    if(event)emit(owner,event);return true;
}

static NSDictionary *initialize(NSWindow *window,NSString *label,NSString *resources) {
    windows[label]=window;lastWindow=label;
    NSView *web=nil;for(NSView *v in window.contentView.subviews)if([v isKindOfClass:NSClassFromString(@"WKWebView")])web=v;
    if(web){[web setValue:@NO forKey:@"drawsBackground"];}
    if(!engine){
        resourcePath=resources;setenv("GHOSTTY_RESOURCES_DIR",resources.UTF8String,1);
        NSString *terminfo=[[resources stringByDeletingLastPathComponent] stringByAppendingPathComponent:@"terminfo"];
        setenv("TERMINFO",terminfo.UTF8String,1);
        // macOS GUI processes often inherit the C locale, which breaks shell Unicode.
        const char *locale=getenv("LC_ALL") ?: getenv("LC_CTYPE") ?: getenv("LANG");
        if(!locale||strcmp(locale,"C")==0||strcmp(locale,"POSIX")==0){setenv("LANG","en_US.UTF-8",1);setenv("LC_CTYPE","UTF-8",1);if(getenv("LC_ALL"))setenv("LC_ALL","en_US.UTF-8",1);}
        if(ghostty_init(0,NULL)!=GHOSTTY_SUCCESS)return @{@"error":@"Ghostty 初始化失敗"};
        config=ghostty_config_new();ghostty_config_load_default_files(config);ghostty_config_load_recursive_files(config);ghostty_config_finalize(config);
        ghostty_runtime_config_s runtime={.wakeup_cb=wakeup,.action_cb=nativeAction,.read_clipboard_cb=readClipboard,.confirm_read_clipboard_cb=confirmClipboard,.write_clipboard_cb=writeClipboard,.close_surface_cb=closeSurface};
        engine=ghostty_app_new(&runtime,config);if(!engine)return @{@"error":@"無法建立 Ghostty app"};
        configureGlobalKeys();
        localMonitor=[NSEvent addLocalMonitorForEventsMatchingMask:NSEventMaskKeyDown handler:^NSEvent *(NSEvent *event){
            @try {
                if(!engine)return event;
                NSString *pressed=event.charactersIgnoringModifiers.lowercaseString;
                NSEventModifierFlags flags=event.modifierFlags & NSEventModifierFlagDeviceIndependentFlagsMask;
                NSEventModifierFlags command=NSEventModifierFlagCommand, shift=NSEventModifierFlagShift;
                NSEventModifierFlags relevant=flags&(command|shift|NSEventModifierFlagOption|NSEventModifierFlagControl);
                if(relevant==(command|shift)&&[pressed isEqualToString:@"b"]){emit(lastWindow,@{@"type":@"toggle-sidebar"});return nil;}
                if(relevant==(command|shift)&&[pressed isEqualToString:@"t"]){emit(lastWindow,@{@"type":@"duplicate-tab"});return nil;}
                if(relevant==(command|shift)&&[pressed isEqualToString:@"p"]){emit(lastWindow,@{@"type":@"toggle-palette"});return nil;}
                if(relevant==command&&pressed.length==1){
                    // ⌘0 toggles the files panel like ⌘O; ⌘1～⌘9 switch tabs.
                    if([pressed isEqualToString:@"0"]){emit(lastWindow,@{@"type":@"browse"});return nil;}
                    NSInteger value=[pressed integerValue];
                    if(value>=1&&value<=9){emit(lastWindow,@{@"type":@"goto-tab",@"value":@(value)});return nil;}
                }
                ghostty_input_key_s key=keyEvent(event,GHOSTTY_ACTION_PRESS);
                if(ghostty_app_key(engine,key))return nil;
                if([pressed isEqualToString:@"o"]&&(relevant&command)){
                    HGSurface *s=focused(lastWindow);if(!s||!ghostty_surface_key_is_binding(s.surface,key,NULL)){emit(lastWindow,@{@"type":@"browse"});return nil;}
                }
                return event;
            } @catch(NSException *exception) {
                emit(lastWindow,@{@"type":@"warning",@"message":[NSString stringWithFormat:@"快捷鍵處理失敗：%@ %@",exception.name,exception.reason ?: @""]});
                return event;
            }
        }];
        observers=[NSMutableArray array];NSNotificationCenter *nc=NSNotificationCenter.defaultCenter;
        for(NSString *name in @[NSApplicationDidBecomeActiveNotification,NSApplicationDidResignActiveNotification]) [observers addObject:[nc addObserverForName:name object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){ghostty_app_set_focus(engine,NSApp.active);}]];
        [observers addObject:[nc addObserverForName:NSWindowDidResignKeyNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){NSWindow *w=n.object;NSString *owner=[windows allKeysForObject:w].firstObject;if([owner hasPrefix:@"quick-"]&&boolConfig("quick-terminal-autohide",YES))[w orderOut:nil];}]];
        [observers addObject:[nc addObserverForName:NSWindowDidBecomeKeyNotification object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){NSString *owner=[windows allKeysForObject:n.object].firstObject;if(owner)lastWindow=owner;}]];
        themeObserver=[NSDistributedNotificationCenter.defaultCenter addObserverForName:@"AppleInterfaceThemeChangedNotification" object:nil queue:NSOperationQueue.mainQueue usingBlock:^(NSNotification *n){BOOL dark=[[NSApp.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];ghostty_app_set_color_scheme(engine,dark?GHOSTTY_COLOR_SCHEME_DARK:GHOSTTY_COLOR_SCHEME_LIGHT);}];
    }
    applyWindow(window);
    BOOL dark=[[window.effectiveAppearance bestMatchFromAppearancesWithNames:@[NSAppearanceNameAqua,NSAppearanceNameDarkAqua]] isEqualToString:NSAppearanceNameDarkAqua];
    ghostty_app_set_color_scheme(engine,dark?GHOSTTY_COLOR_SCHEME_DARK:GHOSTTY_COLOR_SCHEME_LIGHT);
    if([label hasPrefix:@"quick-"])toggleQuickTerminal(label);
    return configurationInfo();
}

static NSDictionary *processInfo(HGSurface *surface) {
    // shellPid can resolve the foreground shell before its identity is cached
    // (for example while `login` is still handing off to zsh). Always exclude
    // the resolved shell PID itself from the work list as well as the cached
    // PID/start-time pair below.
    int32_t primaryShellPid=shellPid(surface);
    int32_t pid=highostty_surface_pid(surface.surface);
    if(ghostty_surface_process_exited(surface.surface)&&surface.rootPid==0)pid=0;
    struct proc_bsdinfo root={0};
    if(pid>0&&proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&root,sizeof(root))==sizeof(root)){
        uint64_t started=root.pbi_start_tvsec*1000000ULL+root.pbi_start_tvusec;
        if(surface.rootPid==0){surface.rootPid=pid;surface.rootStart=started;}
        if(surface.rootStart!=started)return @{@"cwd":surface.cwd ?: @"",@"running":@[],@"pids":@[],@"exited":@YES};
    }
    NSMutableArray *pids=[NSMutableArray array],*names=[NSMutableArray array];
    if(pid>0){
        int size=proc_listallpids(NULL,0);pid_t *all=calloc(size+64,sizeof(pid_t));int count=proc_listallpids(all,(size+64)*sizeof(pid_t));
        NSMutableSet *family=[NSMutableSet setWithObject:@(pid)];NSMutableArray *records=[NSMutableArray array];
        for(int i=0;i<count;i++){struct proc_bsdinfo info={0};if(all[i]>0&&proc_pidinfo(all[i],PROC_PIDTBSDINFO,0,&info,sizeof(info))==sizeof(info)){[records addObject:@{@"pid":@(all[i]),@"ppid":@(info.pbi_ppid),@"sid":@(getsid(all[i])),@"status":@(info.pbi_status),@"start":@(info.pbi_start_tvsec*1000000ULL+info.pbi_start_tvusec),@"name":processName(info)}];}}
        free(all);BOOL added;do{added=NO;for(NSDictionary *r in records){if(![family containsObject:r[@"pid"]]&&([family containsObject:r[@"ppid"]]||[r[@"sid"] intValue]==pid)){[family addObject:r[@"pid"]];added=YES;}}}while(added);
        // libghostty may expose the login wrapper as its process PID, while
        // macOS reparents the interactive shell during login handoff. Resolve
        // the closest shell in this surface's process tree so an idle prompt
        // is never reported as a background job.
        NSSet *shellNames=[NSSet setWithArray:@[@"zsh",@"bash",@"fish",@"sh",@"nu",@"elvish",@"tcsh",@"csh"]];
        int32_t treeShellPid=0;NSUInteger bestDepth=NSUIntegerMax;
        for(NSDictionary *candidate in records){
            if(![family containsObject:candidate[@"pid"]]||![shellNames containsObject:candidate[@"name"]])continue;
            int32_t parent=[candidate[@"ppid"] intValue];NSUInteger depth=0;
            while(parent!=pid&&depth<64){NSDictionary *parentRecord=nil;for(NSDictionary *record in records)if([record[@"pid"] intValue]==parent){parentRecord=record;break;}if(!parentRecord)break;parent=[parentRecord[@"ppid"] intValue];depth++;}
            if(parent==pid&&depth<bestDepth){bestDepth=depth;treeShellPid=[candidate[@"pid"] intValue];}
        }
        for(NSDictionary *r in records)if([family containsObject:r[@"pid"]]&&[r[@"pid"] intValue]!=pid&&[r[@"status"] intValue]!=SZOMB){
            [pids addObject:r];
            BOOL primary=[r[@"pid"] intValue]==primaryShellPid||[r[@"pid"] intValue]==treeShellPid||([r[@"pid"] intValue]==surface.primaryPid&&[r[@"start"] unsignedLongLongValue]==surface.primaryStart);
            if(!primary&&!idleProcess([r[@"pid"] intValue],r[@"name"]))[names addObject:[NSString stringWithFormat:@"%@ (%@)",r[@"name"],r[@"pid"]]];
        }
        // cwd fallback when shell integration is disabled. This is a direct syscall.
        struct proc_vnodepathinfo cwd={0};if(proc_pidinfo(shellPid(surface),PROC_PIDVNODEPATHINFO,0,&cwd,sizeof(cwd))==sizeof(cwd)){NSString *path=str(cwd.pvi_cdir.vip_path);if(path.length&&![path isEqualToString:surface.cwd]){surface.cwd=path;emit(surface.owner,@{@"type":@"cwd",@"id":surface.identifier,@"path":path});}}
    }
    BOOL exited=ghostty_surface_process_exited(surface.surface);
    return @{@"cwd":surface.cwd ?: @"",@"running":names,@"pids":pids,@"exited":@(exited),@"needsConfirm":@(ghostty_surface_needs_confirm_quit(surface.surface))};
}
// Visible screen text plus the agent-looking process name of each requested
// surface, for attention detection. The process walk is cached for a few seconds.
static NSDictionary *scanSurfaces(NSArray *ids,NSArray *agents) {
    static NSMutableDictionary<NSString *,NSDictionary *> *agentCache;
    if(!agentCache)agentCache=[NSMutableDictionary dictionary];
    // Agent process names come from the prompt rules (regex fragments); fall back to the built-in list.
    NSRegularExpression *agentName=nil;
    if([agents isKindOfClass:NSArray.class]&&agents.count)agentName=[NSRegularExpression regularExpressionWithPattern:[NSString stringWithFormat:@"^(%@)\\b",[agents componentsJoinedByString:@"|"]] options:NSRegularExpressionCaseInsensitive error:nil];
    if(!agentName)agentName=[NSRegularExpression regularExpressionWithPattern:@"^(claude|codex|gemini|copilot|aider|opencode|\\d+\\.\\d+\\.\\d+|node|python3?|bun|deno)\\b" options:0 error:nil];
    NSMutableDictionary *out=[NSMutableDictionary dictionary];
    for(NSString *identifier in ids){
        HGSurface *s=surfaces[identifier];if(!s||!s.surface||s.closing)continue;
        NSString *text=@"";
        ghostty_selection_s selection={.top_left={.tag=GHOSTTY_POINT_VIEWPORT,.coord=GHOSTTY_POINT_COORD_TOP_LEFT},.bottom_right={.tag=GHOSTTY_POINT_VIEWPORT,.coord=GHOSTTY_POINT_COORD_BOTTOM_RIGHT}};
        ghostty_text_s raw={0};
        if(ghostty_surface_read_text(s.surface,selection,&raw)){text=[[NSString alloc] initWithBytes:raw.text length:raw.text_len encoding:NSUTF8StringEncoding] ?: @"";ghostty_surface_free_text(s.surface,&raw);}
        NSDictionary *cached=agentCache[identifier];NSTimeInterval now=NSDate.timeIntervalSinceReferenceDate;
        if(!cached||now-[cached[@"t"] doubleValue]>5){
            NSString *agent=@"";
            for(NSString *name in processInfo(s)[@"running"]){if([agentName firstMatchInString:name options:0 range:NSMakeRange(0,name.length)]){agent=[name componentsSeparatedByString:@" ("].firstObject;break;}}
            cached=@{@"t":@(now),@"agent":agent};agentCache[identifier]=cached;
        }
        out[identifier]=@{@"text":text,@"agent":cached[@"agent"]};
    }
    return @{@"screens":out};
}
// 終端機文字（agent 控制指令的 surface read／wait）：目前畫面，或含捲動緩衝的全部。過長時只留尾端，避免一次傳數 MB。
static NSDictionary *readSurface(HGSurface *s,BOOL scrollback) {
    if(!s||!s.surface||s.closing)return @{@"error":@"找不到終端機"};
    ghostty_point_tag_e tag=scrollback?GHOSTTY_POINT_SCREEN:GHOSTTY_POINT_VIEWPORT;
    ghostty_selection_s selection={.top_left={.tag=tag,.coord=GHOSTTY_POINT_COORD_TOP_LEFT},.bottom_right={.tag=tag,.coord=GHOSTTY_POINT_COORD_BOTTOM_RIGHT}};
    ghostty_text_s raw={0};NSString *text=@"";
    if(ghostty_surface_read_text(s.surface,selection,&raw)){text=[[NSString alloc] initWithBytes:raw.text length:raw.text_len encoding:NSUTF8StringEncoding] ?: @"";ghostty_surface_free_text(s.surface,&raw);}
    const NSUInteger limit=1<<21;
    if(text.length>limit){NSUInteger start=[text rangeOfComposedCharacterSequenceAtIndex:text.length-limit].location;text=[text substringFromIndex:start];}
    return @{@"text":text};
}
// agent 控制指令的 key op：以邏輯鍵名直接組出 Ghostty 按鍵事件（按下＋放開），不經 NSEvent／輸入法路徑，
// 所以與 HGSurface 的輸入方法（docs/keyboard-input.md）互不影響。keycode 為 macOS 虛擬鍵碼。
static NSDictionary *sendNamedKey(HGSurface *s,NSString *name) {
    if(!s||!s.surface||s.closing)return @{@"error":@"找不到終端機"};
    static NSDictionary<NSString *,NSArray<NSNumber *> *> *table;
    static dispatch_once_t once;
    dispatch_once(&once,^{
        NSMutableDictionary *t=[@{@"enter":@[@36,@13],@"tab":@[@48,@9],@"esc":@[@53,@27],@"backspace":@[@51,@127],@"up":@[@126,@0xF700],@"down":@[@125,@0xF701],@"left":@[@123,@0xF702],@"right":@[@124,@0xF703]} mutableCopy];
        NSDictionary<NSString *,NSNumber *> *ansi=@{@"a":@0,@"b":@11,@"c":@8,@"d":@2,@"e":@14,@"f":@3,@"g":@5,@"h":@4,@"i":@34,@"j":@38,@"k":@40,@"l":@37,@"m":@46,@"n":@45,@"o":@31,@"p":@35,@"q":@12,@"r":@15,@"s":@1,@"t":@17,@"u":@32,@"v":@9,@"w":@13,@"x":@7,@"y":@16,@"z":@6};
        for(NSString *letter in ansi)t[[@"ctrl+" stringByAppendingString:letter]]=@[ansi[letter],@([letter characterAtIndex:0])];
        table=t;
    });
    NSArray<NSNumber *> *entry=table[name];
    if(!entry)return @{@"error":[NSString stringWithFormat:@"不支援的按鍵：%@",name]};
    ghostty_input_key_s key={.action=GHOSTTY_ACTION_PRESS,.mods=[name hasPrefix:@"ctrl+"]?GHOSTTY_MODS_CTRL:GHOSTTY_MODS_NONE,.consumed_mods=GHOSTTY_MODS_NONE,.keycode=entry[0].unsignedIntValue,.text=NULL,.unshifted_codepoint=entry[1].unsignedIntValue,.composing=false};
    ghostty_surface_key(s.surface,key);
    key.action=GHOSTTY_ACTION_RELEASE;
    ghostty_surface_key(s.surface,key);
    return @{};
}
static NSDictionary *destroySurface(HGSurface *surface,BOOL force) {
    NSDictionary *info=processInfo(surface);NSArray *running=info[@"running"];
    // tmux 窗格的前景行程只是 tmux client；終止它不會結束 session（session 由前端另外決定是否 kill）。
    if(!force&&!surface.tmux&&(running.count||[info[@"needsConfirm"] boolValue]))return @{@"error":@"仍有工作執行，請確認終止",@"running":running};
    NSArray *pids=info[@"pids"];
    for(NSDictionary *r in [pids reverseObjectEnumerator]){struct proc_bsdinfo current={0};int pid=[r[@"pid"] intValue];if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&current,sizeof(current))==sizeof(current)&&current.pbi_start_tvsec*1000000ULL+current.pbi_start_tvusec==[r[@"start"] unsignedLongLongValue]){if(kill(pid,SIGKILL)<0&&errno!=ESRCH)return @{@"error":str(strerror(errno))};}}
    // Do not release a surface while descendants are still running. Retry is safe.
    for(int attempt=0;attempt<50;attempt++){BOOL alive=NO;for(NSDictionary *r in pids){struct proc_bsdinfo current={0};int pid=[r[@"pid"] intValue];if(proc_pidinfo(pid,PROC_PIDTBSDINFO,0,&current,sizeof(current))==sizeof(current)&&current.pbi_status!=SZOMB&&current.pbi_start_tvsec*1000000ULL+current.pbi_start_tvusec==[r[@"start"] unsignedLongLongValue])alive=YES;}if(!alive)break;if(attempt==49)return @{@"error":@"程序尚未結束，請重試關閉"};usleep(10000);}
    surface.closing=YES;
    ghostty_surface_t native=surface.surface;surface.surface=NULL;
    ghostty_surface_free(native); // engine joins the IO thread and reaps its child
    [surface removeFromSuperview];[surfaces removeObjectForKey:surface.identifier];emit(surface.owner,@{@"type":@"removed",@"id":surface.identifier});
    return @{@"closed":@YES};
}
static NSView *findWebView(NSView *view) {if([view isKindOfClass:NSClassFromString(@"WKWebView")])return view;for(NSView *child in view.subviews){NSView *found=findWebView(child);if(found)return found;}return nil;}
// The web overlay (command palette) must appear above native terminals, so the
// overlapping part of each terminal is masked out instead of resizing it.
// cutoutRequests[window label][slot] = overlay-cutout request. Slots let several overlays
// (palette / attention / usage share "default"; the files drop-down uses "files") be open together.
static NSMutableDictionary<NSString *,NSMutableDictionary *> *cutoutRequests;
// rect minus hole, as up to four disjoint pieces.
static void subtractRect(NSRect rect,NSRect hole,NSMutableArray<NSValue *> *out) {
    NSRect cut=NSIntersectionRect(rect,hole);
    if(NSIsEmptyRect(cut)){[out addObject:[NSValue valueWithRect:rect]];return;}
    if(cut.origin.y>rect.origin.y)[out addObject:[NSValue valueWithRect:NSMakeRect(rect.origin.x,rect.origin.y,rect.size.width,cut.origin.y-rect.origin.y)]];
    if(NSMaxY(cut)<NSMaxY(rect))[out addObject:[NSValue valueWithRect:NSMakeRect(rect.origin.x,NSMaxY(cut),rect.size.width,NSMaxY(rect)-NSMaxY(cut))]];
    if(cut.origin.x>rect.origin.x)[out addObject:[NSValue valueWithRect:NSMakeRect(rect.origin.x,cut.origin.y,cut.origin.x-rect.origin.x,cut.size.height)]];
    if(NSMaxX(cut)<NSMaxX(rect))[out addObject:[NSValue valueWithRect:NSMakeRect(NSMaxX(cut),cut.origin.y,NSMaxX(rect)-NSMaxX(cut),cut.size.height)]];
}
static void applyCutout(HGSurface *s,NSView *web) {
    // Disjoint holes, so the even-odd mask doesn't un-cut where two overlays overlap.
    NSMutableArray<NSValue *> *holes=[NSMutableArray array];
    if(web&&!s.hidden){
        for(NSDictionary *cutoutRequest in cutoutRequests[s.owner].allValues){
            double ratio=web.bounds.size.width/[cutoutRequest[@"viewportWidth"] doubleValue];
            if(!isfinite(ratio)||ratio<=0)continue;
            NSRect rect=NSMakeRect([cutoutRequest[@"x"] doubleValue]*ratio,[cutoutRequest[@"y"] doubleValue]*ratio,[cutoutRequest[@"width"] doubleValue]*ratio,[cutoutRequest[@"height"] doubleValue]*ratio);
            if(!web.isFlipped)rect.origin.y=web.bounds.size.height-rect.origin.y-rect.size.height;
            rect=[web convertRect:rect toView:s.superview];
            rect=NSIntersectionRect([s convertRect:rect fromView:s.superview],s.bounds);
            if(NSIsEmptyRect(rect))continue;
            NSMutableArray<NSValue *> *pieces=[NSMutableArray arrayWithObject:[NSValue valueWithRect:rect]];
            for(NSValue *old in holes){NSMutableArray<NSValue *> *next=[NSMutableArray array];for(NSValue *piece in pieces)subtractRect(piece.rectValue,old.rectValue,next);pieces=next;}
            [holes addObjectsFromArray:pieces];
        }
    }
    s.cutouts=holes;
    s.wantsLayer=YES;
    if(!holes.count){s.layer.mask=nil;return;}
    CGMutablePathRef path=CGPathCreateMutable();
    CGPathAddRect(path,NULL,NSRectToCGRect(s.bounds));
    for(NSValue *hole in holes)CGPathAddRect(path,NULL,NSRectToCGRect(hole.rectValue));
    CAShapeLayer *mask=[CAShapeLayer layer];mask.frame=s.bounds;mask.path=path;mask.fillRule=kCAFillRuleEvenOdd;
    CGPathRelease(path);
    s.layer.mask=mask;
}
char *hg_command(void *windowPointer,const char *labelString,const char *resources,const char *request,hg_event_cb callback) {
    NSCAssert(NSThread.isMainThread,@"Native Ghostty must run on the AppKit thread");
    @autoreleasepool {
        if(!surfaces)surfaces=[NSMutableDictionary dictionary];if(!windows)windows=[NSMutableDictionary dictionary];eventCallback=callback;
        NSWindow *window=(__bridge NSWindow *)windowPointer;NSString *label=str(labelString);windows[label]=window;
        NSDictionary *req=[NSJSONSerialization JSONObjectWithData:[str(request) dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];NSString *op=req[@"op"];
        NSDictionary *result=@{};
        if([op isEqualToString:@"init"])result=initialize(window,label,str(resources));
        else if(!engine)result=@{@"error":@"原生 Ghostty 尚未初始化"};
        else if([op isEqualToString:@"pick-directory"]){
            NSOpenPanel *panel=[NSOpenPanel openPanel];panel.canChooseDirectories=YES;panel.canChooseFiles=NO;panel.allowsMultipleSelection=NO;panel.canCreateDirectories=YES;panel.prompt=L(@"native.chooseDirectory",@"Choose");panel.directoryURL=[NSURL fileURLWithPath:req[@"path"]];
            // Let AppKit own its modal event loop. Manually pumping only the
            // default run-loop mode starves mouse tracking while browsing.
            NSModalResponse response=[panel runModal];
            result=@{@"path":response==NSModalResponseOK?panel.URL.path:(id)NSNull.null};
        }
        else if([op isEqualToString:@"set-strings"]){
            NSDictionary *strings=req[@"strings"];
            if([strings isKindOfClass:NSDictionary.class]){NSMutableDictionary *clean=[NSMutableDictionary dictionary];[strings enumerateKeysAndObjectsUsingBlock:^(id k,id v,BOOL *stop){if([k isKindOfClass:NSString.class]&&[v isKindOfClass:NSString.class])clean[k]=[v copy];}];uiStrings=[clean copy];}
            result=@{@"ok":@YES};
        }
        else if([op isEqualToString:@"preferred-languages"])result=@{@"languages":NSLocale.preferredLanguages ?: @[]};
        else if([op isEqualToString:@"pick-file"]||[op isEqualToString:@"save-file"]){
            BOOL saving=[op isEqualToString:@"save-file"];NSSavePanel *panel=saving?[NSSavePanel savePanel]:[NSOpenPanel openPanel];
            if(![req[@"any"] boolValue]){UTType *json=[UTType typeWithFilenameExtension:@"json"];if(json)panel.allowedContentTypes=@[json];}
            if(saving){NSString *name=req[@"name"];if([name isKindOfClass:NSString.class])panel.nameFieldStringValue=name;}
            else{NSOpenPanel *open=(NSOpenPanel *)panel;open.canChooseFiles=YES;open.canChooseDirectories=NO;open.allowsMultipleSelection=NO;NSString *dir=req[@"dir"];if([dir isKindOfClass:NSString.class])open.directoryURL=[NSURL fileURLWithPath:dir isDirectory:YES];}
            NSModalResponse response=[panel runModal];
            result=@{@"path":response==NSModalResponseOK?panel.URL.path:(id)NSNull.null};
        }
        else if([op isEqualToString:@"cwd"]){HGSurface *s=surfaces[req[@"id"]];if(s){int pid=shellPid(s);struct proc_vnodepathinfo cwd={0};if(pid>0&&proc_pidinfo(pid,PROC_PIDVNODEPATHINFO,0,&cwd,sizeof(cwd))==sizeof(cwd)){NSString *p=str(cwd.pvi_cdir.vip_path);if(p.length&&![p isEqualToString:s.cwd]){s.cwd=p;emit(s.owner,@{@"type":@"cwd",@"id":s.identifier,@"path":p});}}result=@{@"cwd":s.cwd ?: @"",@"exited":@(ghostty_surface_process_exited(s.surface))};}}
        else if([op isEqualToString:@"idle-rules"]){NSMutableArray *list=[NSMutableArray array];id given=req[@"rules"];if([given isKindOfClass:[NSArray class]])for(id item in given)if([item isKindOfClass:[NSDictionary class]]&&[item[@"name"] isKindOfClass:[NSString class]])[list addObject:item];idleRules=list;}
        else if([op isEqualToString:@"all-info"]){NSMutableArray *running=[NSMutableArray array];BOOL confirm=NO;for(HGSurface *s in surfaces.allValues){if(s.tmux)continue;NSDictionary *info=processInfo(s);[running addObjectsFromArray:info[@"running"]];confirm|=[info[@"needsConfirm"] boolValue];}result=@{@"running":running,@"needsConfirm":@(confirm)};}
        else if([op isEqualToString:@"close-all"]){for(HGSurface *s in [surfaces.allValues copy]){NSDictionary *r=destroySurface(s,[req[@"force"] boolValue]);if(r[@"error"]){result=r;break;}}}
        else if([op isEqualToString:@"config"])result=configurationInfo();
        else if([op isEqualToString:@"reload"]){reloadConfig();result=configurationInfo();}
        else if([op isEqualToString:@"open-config"]){ghostty_action_s a={.tag=GHOSTTY_ACTION_OPEN_CONFIG};nativeAction(engine,(ghostty_target_s){.tag=GHOSTTY_TARGET_APP},a);}
        else if([op isEqualToString:@"open"]){
            NSString *identifier=req[@"id"],*path=req[@"path"];
            HGSurface *view=[[HGSurface alloc] initWithFrame:NSMakeRect(0,0,800,600)];[view registerForDraggedTypes:@[NSPasteboardTypeFileURL]];view.identifier=identifier;view.owner=label;view.tmux=[req[@"tmux"] boolValue];view.cwd=path;view.title=@"";view.marked=[[NSMutableAttributedString alloc] initWithString:@""];view.hidden=YES;
            NSView *web=findWebView(window.contentView);NSView *parent=web.superview ?: window.contentView;
            [parent addSubview:view positioned:NSWindowAbove relativeTo:web];surfaces[identifier]=view;
            ghostty_surface_config_s options=ghostty_surface_config_new();
            HGSurface *source=surfaces[req[@"source"]];if(source.surface)options=ghostty_surface_inherited_config(source.surface,[req[@"split"] boolValue]?GHOSTTY_SURFACE_CONTEXT_SPLIT:GHOSTTY_SURFACE_CONTEXT_TAB);
            NSString *command=req[@"command"];
            BOOL commandInShell=[req[@"commandInShell"] boolValue]&&command.length;
            options.platform_tag=GHOSTTY_PLATFORM_MACOS;options.platform.macos.nsview=(__bridge void *)view;options.userdata=(__bridge void *)view;options.working_directory=path.UTF8String;options.scale_factor=window.backingScaleFactor;
            if(command.length&&!commandInShell)options.command=command.UTF8String;
            // 環境變數（HIGHOSTTY_*）：libghostty 會複製字串，所以呼叫期間有效即可。
            NSDictionary *env=[req[@"env"] isKindOfClass:NSDictionary.class]?req[@"env"]:nil;
            ghostty_env_var_s *envVars=env.count?calloc(env.count,sizeof(ghostty_env_var_s)):NULL;size_t envCount=0;
            for(id key in env){id value=env[key];if(![key isKindOfClass:NSString.class]||![value isKindOfClass:NSString.class])continue;envVars[envCount].key=strdup([key UTF8String]);envVars[envCount].value=strdup([value UTF8String]);envCount++;}
            options.env_vars=envVars;options.env_var_count=envCount;
            view.surface=ghostty_surface_new(engine,&options);
            for(size_t i=0;i<envCount;i++){free((void *)envVars[i].key);free((void *)envVars[i].value);}free(envVars);
            view.wantsLayer=YES;view.layer.backgroundColor=[backgroundColor() colorWithAlphaComponent:numberConfig("background-opacity",1)].CGColor;
            if(!view.surface){[view removeFromSuperview];[surfaces removeObjectForKey:identifier];result=@{@"error":@"建立原生 Ghostty surface 失敗"};}else{
                [view syncSize];
                if(commandInShell){NSString *input=[command stringByAppendingString:@"\r"];ghostty_surface_text(view.surface,input.UTF8String,[input lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);}
                result=@{@"id":identifier,@"cwd":path};
            }
        }else if([op isEqualToString:@"layout"]){
            NSView *web=findWebView(window.contentView);NSArray *rects=req[@"rects"];
            // 先全部隱藏再逐一顯示：隱藏 first responder 會讓視窗失去焦點（AppKit 不會在重新顯示時還原），
            // 所以不是由 focus op 接著呼叫的 layout（尺寸變動、cwd 事件…）會把鍵盤焦點弄丟。記住它，布局後還原。
            HGSurface *keepFocus=[window.firstResponder isKindOfClass:[HGSurface class]]?(HGSurface *)window.firstResponder:nil;
            for(HGSurface *s in surfaces.allValues)if([s.owner isEqualToString:label]){s.hidden=YES;if(s.surface)ghostty_surface_set_occlusion(s.surface,false);}
            double ratio=web.bounds.size.width/[req[@"viewportWidth"] doubleValue];if(!isfinite(ratio)||ratio<=0)ratio=1;
            for(NSDictionary *r in rects){HGSurface *s=surfaces[r[@"id"]];if(!s||![s.owner isEqualToString:label])continue;s.suspended=[req[@"suspended"] boolValue];
                NSRect rect=NSMakeRect([r[@"x"] doubleValue]*ratio,[r[@"y"] doubleValue]*ratio,[r[@"width"] doubleValue]*ratio,[r[@"height"] doubleValue]*ratio);
                if(!web.isFlipped)rect.origin.y=web.bounds.size.height-rect.origin.y-rect.size.height;
                if(web)rect=[web convertRect:rect toView:s.superview];s.frame=rect;s.hidden=s.suspended||rect.size.width<1||rect.size.height<1;
                if(s.surface){ghostty_surface_set_occlusion(s.surface,!s.hidden);if(!s.hidden)[s syncSize];}
                applyCutout(s,web);
            }
            if(keepFocus&&!keepFocus.hidden&&window.firstResponder!=keepFocus)[window makeFirstResponder:keepFocus];
        }else if([op isEqualToString:@"overlay-cutout"]){
            NSView *web=findWebView(window.contentView);
            if(!cutoutRequests)cutoutRequests=[NSMutableDictionary dictionary];
            NSString *slot=[req[@"slot"] isKindOfClass:NSString.class]?req[@"slot"]:@"default";
            NSMutableDictionary *slots=cutoutRequests[label];if(!slots)cutoutRequests[label]=slots=[NSMutableDictionary dictionary];
            if([req[@"width"] doubleValue]>0&&[req[@"height"] doubleValue]>0)slots[slot]=req;else [slots removeObjectForKey:slot];
            for(HGSurface *s in surfaces.allValues)if([s.owner isEqualToString:label])applyCutout(s,web);
            // Palette closed: never leave the keyboard focus in the WebView, or surface-level bindings (⌘D…) stop working.
            if([req[@"restoreFocus"] boolValue]&&![req[@"width"] doubleValue]&&web&&window.firstResponder==web){HGSurface *f=focused(label);if(f&&!f.hidden)[window makeFirstResponder:f];}
        }else if([op isEqualToString:@"focus"]){HGSurface *s=surfaces[req[@"id"]];if(s&&!s.hidden&&window.firstResponder!=s)[window makeFirstResponder:s];}
        else if([op isEqualToString:@"focus-web"]){NSView *web=findWebView(window.contentView);if(web)[window makeFirstResponder:web];}
        else if([op isEqualToString:@"scan"]){result=scanSurfaces(req[@"ids"],req[@"agents"]);}
        else if([op isEqualToString:@"read"]){result=readSurface(surfaces[req[@"id"]],[req[@"scrollback"] boolValue]);}
        else if([op isEqualToString:@"key"]){
            @try{result=sendNamedKey(surfaces[req[@"id"]],[req[@"key"] isKindOfClass:NSString.class]?req[@"key"]:@"");}
            @catch(NSException *exception){result=@{@"error":[NSString stringWithFormat:@"送出按鍵失敗：%@ %@",exception.name,exception.reason]};}
        }
        else if([op isEqualToString:@"info"]){HGSurface *s=surfaces[req[@"id"]];result=s?processInfo(s):@{@"error":@"找不到終端機"};}
        else if([op isEqualToString:@"close"]){HGSurface *s=surfaces[req[@"id"]];result=s?destroySurface(s,[req[@"force"] boolValue]):@{@"closed":@YES};}
        else if([op isEqualToString:@"binding"]){HGSurface *s=surfaces[req[@"id"]];NSString *binding=req[@"action"];if(!s||!ghostty_surface_binding_action(s.surface,binding.UTF8String,[binding lengthOfBytesUsingEncoding:NSUTF8StringEncoding]))result=@{@"error":@"Ghostty 無法執行這個動作"};}
        else if([op isEqualToString:@"quick"]){toggleQuickTerminal(label);}
        else if([op isEqualToString:@"forget-window"]){[windows removeObjectForKey:label];}
        else if([op isEqualToString:@"insert-text"]){HGSurface *s=surfaces[req[@"id"]];NSString *text=req[@"text"];if(s.surface&&text.length)ghostty_surface_text(s.surface,text.UTF8String,[text lengthOfBytesUsingEncoding:NSUTF8StringEncoding]);else result=@{@"error":@"找不到終端機"};}
        else if([op hasPrefix:@"files-"])result=HGFilesCommand(window,req,^(NSDictionary *event){emit(label,event);});
        else result=@{@"error":@"未知原生指令"};
        NSData *data=[NSJSONSerialization dataWithJSONObject:result options:0 error:nil];NSString *json=[[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];return strdup(json.UTF8String ?: "{}");
    }
}
void hg_shutdown(void) {
    shuttingDown=YES;
    if(globalSource){CFRunLoopRemoveSource(CFRunLoopGetMain(),globalSource,kCFRunLoopCommonModes);CFRelease(globalSource);globalSource=NULL;}
    if(globalTap){CFMachPortInvalidate(globalTap);CFRelease(globalTap);globalTap=NULL;}
    if(localMonitor)[NSEvent removeMonitor:localMonitor];
    if(themeObserver)[NSDistributedNotificationCenter.defaultCenter removeObserver:themeObserver];
    for(id observer in observers)[NSNotificationCenter.defaultCenter removeObserver:observer];
    for(HGSurface *surface in surfaces.allValues)destroySurface(surface,YES);
    if(engine){ghostty_app_free(engine);engine=NULL;}if(config){ghostty_config_free(config);config=NULL;}
    [surfaces removeAllObjects];[windows removeAllObjects];
}
