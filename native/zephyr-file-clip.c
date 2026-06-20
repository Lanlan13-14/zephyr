/*
 * zephyr-file-clip — X11 clipboard owner for RDP CLIPRDR file virtualization.
 *
 * This helper owns the X11 CLIPBOARD selection and serves TARGETS +
 * text/uri-list. FreeRDP's X11 clipboard bridge sees the text/uri-list
 * target and advertises FileGroupDescriptorW to the Windows RDP server.
 * When the user presses Ctrl+V in any remote Explorer folder, Windows
 * issues CLIPRDR FileContentsRequest PDUs and FreeRDP/WinPR reads the
 * local files listed in the URI list on demand.
 *
 * This is the same logical path used by native RDP file clipboard:
 * descriptor first, content pulled lazily by the paste target.
 *
 * Usage:
 *   zephyr-file-clip /path/to/file1 /path/to/file2 ...
 *
 * The process stays alive until SIGTERM/EOF. It exits automatically if
 * another app takes ownership of CLIPBOARD.
 */

#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xatom.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <unistd.h>
#include <sys/stat.h>
#include <limits.h>

static volatile sig_atomic_t running = 1;
static Display *dpy = NULL;
static Window win = None;
static Atom CLIPBOARD, TARGETS, UTF8_STRING, TEXT_URI_LIST, TEXT_PLAIN, TIMESTAMP_ATOM;
static char *uri_list = NULL;
static size_t uri_list_len = 0;

static void on_term(int sig) { (void)sig; running = 0; }

static int is_unreserved(unsigned char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
           (c >= '0' && c <= '9') || c == '-' || c == '_' ||
           c == '.' || c == '~' || c == '/';
}

static char *percent_encode_path(const char *path) {
    size_t len = strlen(path), out_len = 0;
    for (size_t i = 0; i < len; i++) out_len += is_unreserved((unsigned char)path[i]) ? 1 : 3;
    char *out = calloc(out_len + 1, 1);
    if (!out) return NULL;
    char *p = out;
    static const char *hex = "0123456789ABCDEF";
    for (size_t i = 0; i < len; i++) {
        unsigned char c = (unsigned char)path[i];
        if (is_unreserved(c)) *p++ = (char)c;
        else { *p++ = '%'; *p++ = hex[c >> 4]; *p++ = hex[c & 15]; }
    }
    return out;
}

static int append_uri_for_path(const char *input) {
    char resolved[PATH_MAX];
    struct stat st;
    if (!realpath(input, resolved)) {
        fprintf(stderr, "zephyr-file-clip: skip unresolved path: %s\n", input);
        return 0;
    }
    if (stat(resolved, &st) != 0) {
        fprintf(stderr, "zephyr-file-clip: skip missing path: %s\n", resolved);
        return 0;
    }
    char *encoded = percent_encode_path(resolved);
    if (!encoded) return 0;
    size_t line_len = strlen("file://") + strlen(encoded) + 2;
    char *next = realloc(uri_list, uri_list_len + line_len + 1);
    if (!next) { free(encoded); return 0; }
    uri_list = next;
    memcpy(uri_list + uri_list_len, "file://", 7); uri_list_len += 7;
    memcpy(uri_list + uri_list_len, encoded, strlen(encoded)); uri_list_len += strlen(encoded);
    memcpy(uri_list + uri_list_len, "\r\n", 2); uri_list_len += 2;
    uri_list[uri_list_len] = '\0';
    free(encoded);
    return 1;
}

static void respond_selection(XSelectionRequestEvent *req) {
    XSelectionEvent sev;
    memset(&sev, 0, sizeof(sev));
    sev.type = SelectionNotify;
    sev.display = dpy;
    sev.requestor = req->requestor;
    sev.selection = req->selection;
    sev.target = req->target;
    Atom property = req->property == None ? req->target : req->property;
    sev.property = property;
    sev.time = req->time;

    if (req->target == TARGETS) {
        Atom targets[] = { TARGETS, TEXT_URI_LIST, UTF8_STRING, XA_STRING, TEXT_PLAIN, TIMESTAMP_ATOM };
        XChangeProperty(dpy, req->requestor, property, XA_ATOM, 32,
                        PropModeReplace, (unsigned char *)targets,
                        (int)(sizeof(targets) / sizeof(targets[0])));
    } else if (req->target == TEXT_URI_LIST) {
        XChangeProperty(dpy, req->requestor, property, TEXT_URI_LIST, 8,
                        PropModeReplace, (unsigned char *)uri_list, (int)uri_list_len);
    } else if (req->target == UTF8_STRING || req->target == XA_STRING || req->target == TEXT_PLAIN) {
        XChangeProperty(dpy, req->requestor, property, UTF8_STRING, 8,
                        PropModeReplace, (unsigned char *)uri_list, (int)uri_list_len);
    } else if (req->target == TIMESTAMP_ATOM) {
        long t = CurrentTime;
        XChangeProperty(dpy, req->requestor, property, XA_INTEGER, 32,
                        PropModeReplace, (unsigned char *)&t, 1);
    } else {
        sev.property = None;
    }

    XSendEvent(dpy, req->requestor, False, 0, (XEvent *)&sev);
    XFlush(dpy);
}

int main(int argc, char **argv) {
    signal(SIGTERM, on_term);
    signal(SIGINT, on_term);
    signal(SIGHUP, on_term);

    if (argc < 2) {
        fprintf(stderr, "usage: zephyr-file-clip <file-or-dir>...\n");
        return 2;
    }

    int count = 0;
    for (int i = 1; i < argc; i++) count += append_uri_for_path(argv[i]);
    if (count <= 0 || !uri_list || uri_list_len == 0) {
        fprintf(stderr, "zephyr-file-clip: no valid files\n");
        return 1;
    }

    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "zephyr-file-clip: cannot open display %s\n", XDisplayName(NULL));
        return 1;
    }

    CLIPBOARD = XInternAtom(dpy, "CLIPBOARD", False);
    TARGETS = XInternAtom(dpy, "TARGETS", False);
    UTF8_STRING = XInternAtom(dpy, "UTF8_STRING", False);
    TEXT_URI_LIST = XInternAtom(dpy, "text/uri-list", False);
    TEXT_PLAIN = XInternAtom(dpy, "text/plain;charset=utf-8", False);
    TIMESTAMP_ATOM = XInternAtom(dpy, "TIMESTAMP", False);

    win = XCreateSimpleWindow(dpy, DefaultRootWindow(dpy), -10, -10, 1, 1, 0, 0, 0);
    XSetSelectionOwner(dpy, CLIPBOARD, win, CurrentTime);
    if (XGetSelectionOwner(dpy, CLIPBOARD) != win) {
        fprintf(stderr, "zephyr-file-clip: failed to own CLIPBOARD\n");
        XCloseDisplay(dpy);
        return 1;
    }
    XFlush(dpy);
    fprintf(stderr, "zephyr-file-clip: serving %d file(s) as text/uri-list\n", count);

    while (running) {
        XEvent ev;
        XNextEvent(dpy, &ev);
        if (ev.type == SelectionRequest && ev.xselectionrequest.selection == CLIPBOARD) {
            respond_selection(&ev.xselectionrequest);
        } else if (ev.type == SelectionClear) {
            fprintf(stderr, "zephyr-file-clip: clipboard ownership lost\n");
            break;
        }
    }

    free(uri_list);
    XCloseDisplay(dpy);
    return 0;
}
