/*
 * zephyr-xinput — Persistent X11 input injection proxy via XTest extension.
 *
 * Reads simple line-based commands from stdin, eliminating per-event
 * process spawning (xdotool/xdotool).  One process stays alive for the
 * entire RDP session.
 *
 * Build:  cc -O2 -o zephyr-xinput zephyr-xinput.c -lX11 -lXtst
 *
 * Protocol (one command per line, UTF-8):
 *   m <x> <y>                     move pointer
 *   d <button>                    mouse button down  (1=L 2=M 3=R 4=up 5=down)
 *   u <button>                    mouse button up
 *   c <button>                    click (down + up)
 *   s <button> <count>            scroll: send <count> clicks of <button>
 *   k <hex-keysym>                key press + release
 *   p <hex-keysym>                key press (down)
 *   r <hex-keysym>                key release (up)
 *   t <text>                      type ASCII text via XTest key events
 *   v <text>                      clipboard paste: set CLIPBOARD + Ctrl+V
 *
 * Exit on EOF or SIGTERM.
 */

#define _GNU_SOURCE
#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/Xatom.h>
#include <X11/extensions/XTest.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <signal.h>
#include <sys/select.h>
#include <errno.h>

static volatile sig_atomic_t running = 1;
static Display *dpy = NULL;
static Window clip_win = None;
static char *clip_text = NULL;
static int clip_len = 0;

/* X11 atoms cached at startup */
static Atom CLIPBOARD, TARGETS, UTF8_STRING, TEXT_PLAIN, TIMESTAMP_ATOM;
static Atom CLIPBOARD_CONTENT;

static void on_term(int sig) { (void)sig; running = 0; }

/* ── clipboard helpers ─────────────────────────────────────────────── */

static void init_clipboard(void) {
    CLIPBOARD = XInternAtom(dpy, "CLIPBOARD", False);
    TARGETS   = XInternAtom(dpy, "TARGETS", False);
    UTF8_STRING = XInternAtom(dpy, "UTF8_STRING", False);
    TEXT_PLAIN  = XInternAtom(dpy, "text/plain;charset=utf-8", False);
    TIMESTAMP_ATOM = XInternAtom(dpy, "TIMESTAMP", False);
    CLIPBOARD_CONTENT = XInternAtom(dpy, "ZEPHYR_CLIP_CONTENT", False);

    clip_win = XCreateSimpleWindow(dpy, DefaultRootWindow(dpy),
                                   -100, -100, 1, 1, 0, 0, 0);
    /* We need to receive SelectionRequest events */
}

static void set_clipboard_text(const char *text, int len) {
    if (clip_text) { free(clip_text); clip_text = NULL; }
    clip_len = len;
    if (len > 0) {
        clip_text = (char *)malloc(len);
        if (clip_text) memcpy(clip_text, text, len);
    }
    /* Take ownership of CLIPBOARD */
    XSetSelectionOwner(dpy, CLIPBOARD, clip_win, CurrentTime);
    /* Also set the PRIMARY selection for compatibility */
    XSetSelectionOwner(dpy, XA_PRIMARY, clip_win, CurrentTime);
    XFlush(dpy);
}

static void handle_selection_request(XEvent *ev) {
    XSelectionRequestEvent *req = &ev->xselectionrequest;
    XSelectionEvent sev;

    memset(&sev, 0, sizeof(sev));
    sev.type = SelectionNotify;
    sev.display = dpy;
    sev.requestor = req->requestor;
    sev.selection = req->selection;
    sev.target = req->target;
    sev.property = req->property;
    sev.time = req->time;

    if (req->target == TARGETS) {
        Atom supported[] = { UTF8_STRING, XA_STRING, TEXT_PLAIN };
        XChangeProperty(dpy, req->requestor, req->property, XA_ATOM, 32,
                        PropModeReplace, (unsigned char *)supported, 3);
    } else if (req->target == UTF8_STRING || req->target == XA_STRING ||
               req->target == TEXT_PLAIN) {
        if (clip_text && clip_len > 0) {
            XChangeProperty(dpy, req->requestor, req->property,
                            UTF8_STRING, 8, PropModeReplace,
                            (unsigned char *)clip_text, clip_len);
        } else {
            sev.property = None;
        }
    } else if (req->target == TIMESTAMP_ATOM) {
        long t = CurrentTime;
        XChangeProperty(dpy, req->requestor, req->property, XA_INTEGER, 32,
                        PropModeReplace, (unsigned char *)&t, 1);
    } else {
        sev.property = None;
    }

    XSendEvent(dpy, req->requestor, False, 0, (XEvent *)&sev);
    XFlush(dpy);
}

/* ── input helpers ──────────────────────────────────────────────────── */

static void send_paste(void) {
    KeyCode ctrl = XKeysymToKeycode(dpy, XK_Control_L);
    KeyCode v = XKeysymToKeycode(dpy, XK_v);
    if (!ctrl || !v) return;
    XTestFakeKeyEvent(dpy, ctrl, True, CurrentTime);
    XTestFakeKeyEvent(dpy, v, True, CurrentTime);
    XTestFakeKeyEvent(dpy, v, False, CurrentTime);
    XTestFakeKeyEvent(dpy, ctrl, False, CurrentTime);
    XFlush(dpy);
}

/* Type a single ASCII character using XTest key events */
static void type_ascii_char(unsigned char c) {
    KeySym ks;
    int need_shift = 0;
    KeyCode shift = XKeysymToKeycode(dpy, XK_Shift_L);

    if (c >= 'a' && c <= 'z') {
        ks = c - 32;          /* uppercase keysym for same key */
    } else if (c >= 'A' && c <= 'Z') {
        ks = c;
        need_shift = 1;
    } else if (c >= '0' && c <= '9') {
        ks = c;
    } else if (c >= 0x20 && c <= 0x7e) {
        ks = c;
        /* symbols that require shift on US layout */
        if (strchr("!@#$%^&*()_+{}|:\"<>?~", c)) need_shift = 1;
    } else if (c == '\n' || c == '\r') {
        ks = XK_Return;
    } else if (c == '\t') {
        ks = XK_Tab;
    } else {
        return;               /* non-ASCII: caller should use paste */
    }

    KeyCode kc = XKeysymToKeycode(dpy, ks);
    if (!kc) return;

    if (need_shift && shift) XTestFakeKeyEvent(dpy, shift, True, CurrentTime);
    XTestFakeKeyEvent(dpy, kc, True, CurrentTime);
    XTestFakeKeyEvent(dpy, kc, False, CurrentTime);
    if (need_shift && shift) XTestFakeKeyEvent(dpy, shift, False, CurrentTime);
}

static void type_text(const char *text, int len) {
    int has_non_ascii = 0;
    for (int i = 0; i < len; i++) {
        if ((unsigned char)text[i] > 0x7f) { has_non_ascii = 1; break; }
    }
    if (has_non_ascii) {
        /* Fall back to clipboard paste for Unicode */
        set_clipboard_text(text, len);
        send_paste();
        return;
    }
    for (int i = 0; i < len; i++) {
        type_ascii_char((unsigned char)text[i]);
    }
    XFlush(dpy);
}

/* ── command processing ────────────────────────────────────────────── */

static void process_line(char *line, int len) {
    /* strip trailing newline */
    while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r')) line[--len] = '\0';
    if (len < 1) return;

    char cmd = line[0];
    char *rest = line + 1;

    switch (cmd) {
    case 'm': {                     /* mouse move */
        int x, y;
        if (sscanf(rest, " %d %d", &x, &y) == 2) {
            XTestFakeMotionEvent(dpy, -1, x, y, CurrentTime);
            XFlush(dpy);
        }
        break;
    }
    case 'd': {                     /* button down */
        int b;
        if (sscanf(rest, " %d", &b) == 1) {
            XTestFakeButtonEvent(dpy, b, True, CurrentTime);
            XFlush(dpy);
        }
        break;
    }
    case 'u': {                     /* button up */
        int b;
        if (sscanf(rest, " %d", &b) == 1) {
            XTestFakeButtonEvent(dpy, b, False, CurrentTime);
            XFlush(dpy);
        }
        break;
    }
    case 'c': {                     /* click */
        int b;
        if (sscanf(rest, " %d", &b) == 1) {
            XTestFakeButtonEvent(dpy, b, True, CurrentTime);
            XTestFakeButtonEvent(dpy, b, False, CurrentTime);
            XFlush(dpy);
        }
        break;
    }
    case 's': {                     /* scroll */
        int b, n;
        if (sscanf(rest, " %d %d", &b, &n) == 2) {
            for (int i = 0; i < n && i < 20; i++) {
                XTestFakeButtonEvent(dpy, b, True, CurrentTime);
                XTestFakeButtonEvent(dpy, b, False, CurrentTime);
            }
            XFlush(dpy);
        }
        break;
    }
    case 'k': {                     /* key press + release */
        unsigned int ks;
        if (sscanf(rest, " %x", &ks) == 1) {
            KeyCode kc = XKeysymToKeycode(dpy, ks);
            if (kc) {
                XTestFakeKeyEvent(dpy, kc, True, CurrentTime);
                XTestFakeKeyEvent(dpy, kc, False, CurrentTime);
                XFlush(dpy);
            }
        }
        break;
    }
    case 'p': {                     /* key press (down) */
        unsigned int ks;
        if (sscanf(rest, " %x", &ks) == 1) {
            KeyCode kc = XKeysymToKeycode(dpy, ks);
            if (kc) {
                XTestFakeKeyEvent(dpy, kc, True, CurrentTime);
                XFlush(dpy);
            }
        }
        break;
    }
    case 'r': {                     /* key release (up) */
        unsigned int ks;
        if (sscanf(rest, " %x", &ks) == 1) {
            KeyCode kc = XKeysymToKeycode(dpy, ks);
            if (kc) {
                XTestFakeKeyEvent(dpy, kc, False, CurrentTime);
                XFlush(dpy);
            }
        }
        break;
    }
    case 't': {                     /* type text */
        while (*rest == ' ') rest++;
        type_text(rest, strlen(rest));
        break;
    }
    case 'v': {                     /* clipboard paste */
        while (*rest == ' ') rest++;
        set_clipboard_text(rest, strlen(rest));
        send_paste();
        break;
    }
    case 'C': {                     /* set clipboard only (no paste) */
        while (*rest == ' ') rest++;
        set_clipboard_text(rest, strlen(rest));
        break;
    }
    default:
        break;
    }
}

/* ── main loop ─────────────────────────────────────────────────────── */

int main(void) {
    signal(SIGTERM, on_term);
    signal(SIGINT, on_term);
    signal(SIGPIPE, SIG_IGN);

    dpy = XOpenDisplay(NULL);
    if (!dpy) {
        fprintf(stderr, "zephyr-xinput: cannot open display %s\n",
                XDisplayName(NULL));
        return 1;
    }

    int ev_base, er_base, maj, min;
    if (!XTestQueryExtension(dpy, &ev_base, &er_base, &maj, &min)) {
        fprintf(stderr, "zephyr-xinput: XTest extension not available\n");
        XCloseDisplay(dpy);
        return 1;
    }

    init_clipboard();

    /* Use unbuffered stdin for lowest latency */
    setvbuf(stdin, NULL, _IONBF, 0);

    char buf[8192];
    int bufpos = 0;
    int xfd = ConnectionNumber(dpy);

    fprintf(stderr, "zephyr-xinput: ready (XTest %d.%d)\n", maj, min);

    while (running) {
        fd_set fds;
        FD_ZERO(&fds);
        FD_SET(STDIN_FILENO, &fds);
        FD_SET(xfd, &fds);
        int maxfd = xfd > STDIN_FILENO ? xfd : STDIN_FILENO;

        struct timeval tv = { 0, 16000 };   /* 16 ms wakeup */
        int ret = select(maxfd + 1, &fds, NULL, NULL, &tv);
        if (ret < 0) {
            if (errno == EINTR) continue;
            break;
        }

        /* Process X11 events (clipboard selection requests) */
        if (ret > 0 && FD_ISSET(xfd, &fds)) {
            XLockDisplay(dpy);
            while (XPending(dpy)) {
                XEvent ev;
                XNextEvent(dpy, &ev);
                if (ev.type == SelectionRequest &&
                    (ev.xselectionrequest.selection == CLIPBOARD ||
                     ev.xselectionrequest.selection == XA_PRIMARY)) {
                    handle_selection_request(&ev);
                }
            }
            XUnlockDisplay(dpy);
        }

        /* Process stdin commands */
        if (ret > 0 && FD_ISSET(STDIN_FILENO, &fds)) {
            ssize_t n = read(STDIN_FILENO, buf + bufpos, sizeof(buf) - bufpos - 1);
            if (n <= 0) break;
            bufpos += n;
            buf[bufpos] = '\0';

            /* Process complete lines */
            char *start = buf;
            char *nl;
            while ((nl = memchr(start, '\n', buf + bufpos - start)) != NULL) {
                *nl = '\0';
                process_line(start, nl - start);
                start = nl + 1;
            }
            /* Move remaining partial line to beginning */
            int remaining = buf + bufpos - start;
            if (remaining > 0 && start != buf) {
                memmove(buf, start, remaining);
            }
            bufpos = remaining;
        }
    }

    if (clip_text) free(clip_text);
    XCloseDisplay(dpy);
    return 0;
}
