#pragma once
#include <stdbool.h>
#include <stdint.h>
typedef void (*hg_event_cb)(const char *window, const char *json);
char *hg_command(void *window, const char *label, const char *resources, const char *request, hg_event_cb emit);
void hg_shutdown(void);
int32_t highostty_surface_pid(void *surface);
