#include <jni.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "zephyr_rdp.h"

typedef struct android_rdp_session {
    JavaVM* vm;
    jobject sink;
    zephyr_rdp_session* native;
} android_rdp_session;

static JNIEnv* current_env(android_rdp_session* session, int* attached) {
    JNIEnv* env = NULL;
    *attached = 0;
    if ((*session->vm)->GetEnv(session->vm, (void**)&env, JNI_VERSION_1_6) == JNI_OK)
        return env;
    if ((*session->vm)->AttachCurrentThread(session->vm, (void**)&env, NULL) != JNI_OK)
        return NULL;
    *attached = 1;
    return env;
}

static void release_env(android_rdp_session* session, int attached) {
    if (attached) (*session->vm)->DetachCurrentThread(session->vm);
}

static jmethodID sink_method(JNIEnv* env, jobject sink, const char* name, const char* signature) {
    jclass cls = (*env)->GetObjectClass(env, sink);
    if (!cls) return NULL;
    jmethodID method = (*env)->GetMethodID(env, cls, name, signature);
    (*env)->DeleteLocalRef(env, cls);
    return method;
}

static void frame_callback(void* user, int32_t x, int32_t y, int32_t width,
                           int32_t height, const uint8_t* pixels, size_t length) {
    android_rdp_session* session = (android_rdp_session*)user;
    if (!session || !pixels || length > INT32_MAX) return;
    int attached = 0;
    JNIEnv* env = current_env(session, &attached);
    if (!env) return;
    jbyteArray bytes = (*env)->NewByteArray(env, (jsize)length);
    jmethodID method = sink_method(env, session->sink, "onFrame", "(IIII[B)V");
    if (bytes && method) {
        (*env)->SetByteArrayRegion(env, bytes, 0, (jsize)length, (const jbyte*)pixels);
        (*env)->CallVoidMethod(env, session->sink, method, x, y, width, height, bytes);
    }
    if (bytes) (*env)->DeleteLocalRef(env, bytes);
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    release_env(session, attached);
}

static void event_callback(void* user, int32_t code, int32_t a, int32_t b, const char* text) {
    android_rdp_session* session = (android_rdp_session*)user;
    if (!session) return;
    int attached = 0;
    JNIEnv* env = current_env(session, &attached);
    if (!env) return;

    if (code == ZEPHYR_RDP_EV_CONNECTED) {
        jmethodID method = sink_method(env, session->sink, "onConnected", "(II)V");
        if (method) (*env)->CallVoidMethod(env, session->sink, method, a, b);
    } else if (code == ZEPHYR_RDP_EV_ERROR) {
        jmethodID method = sink_method(env, session->sink, "onError", "(ILjava/lang/String;)V");
        jstring message = text ? (*env)->NewStringUTF(env, text) : NULL;
        if (method) (*env)->CallVoidMethod(env, session->sink, method, a, message);
        if (message) (*env)->DeleteLocalRef(env, message);
    } else if (code == ZEPHYR_RDP_EV_CLIPBOARD && text && a >= 2 && (a % 2) == 0) {
        jmethodID method = sink_method(env, session->sink, "onClipboard", "(Ljava/lang/String;)V");
        const uint8_t* bytes = (const uint8_t*)text;
        const jsize units = (jsize)(a / 2 - 1);
        jchar* chars = (jchar*)malloc((size_t)units * sizeof(jchar));
        for (jsize index = 0; chars && index < units; index++)
            chars[index] = (jchar)(bytes[index * 2] | ((uint16_t)bytes[index * 2 + 1] << 8u));
        jstring value = chars ? (*env)->NewString(env, chars, units) : NULL;
        if (method && value) (*env)->CallVoidMethod(env, session->sink, method, value);
        if (value) (*env)->DeleteLocalRef(env, value);
        free(chars);
    }
    if ((*env)->ExceptionCheck(env)) (*env)->ExceptionClear(env);
    release_env(session, attached);
}

static char* copy_utf8(JNIEnv* env, jstring value) {
    if (!value) return NULL;
    jsize units = (*env)->GetStringLength(env, value);
    const jchar* chars = (*env)->GetStringChars(env, value, NULL);
    if (!chars) return NULL;
    size_t capacity = (size_t)units * 3u + 1u;
    char* result = (char*)calloc(capacity, 1u);
    if (result) {
        size_t offset = 0;
        for (jsize index = 0; index < units; index++) {
            uint32_t code = chars[index];
            if (code >= 0xD800u && code <= 0xDBFFu && index + 1 < units) {
                uint32_t low = chars[index + 1];
                if (low >= 0xDC00u && low <= 0xDFFFu) {
                    code = 0x10000u + ((code - 0xD800u) << 10u) + (low - 0xDC00u);
                    index++;
                }
            }
            if (code < 0x80u) result[offset++] = (char)code;
            else if (code < 0x800u) {
                result[offset++] = (char)(0xC0u | (code >> 6u));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            } else if (code < 0x10000u) {
                result[offset++] = (char)(0xE0u | (code >> 12u));
                result[offset++] = (char)(0x80u | ((code >> 6u) & 0x3Fu));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            } else {
                result[offset++] = (char)(0xF0u | (code >> 18u));
                result[offset++] = (char)(0x80u | ((code >> 12u) & 0x3Fu));
                result[offset++] = (char)(0x80u | ((code >> 6u) & 0x3Fu));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            }
        }
    }
    (*env)->ReleaseStringChars(env, value, chars);
    return result;
}

static char* copy_password(JNIEnv* env, jcharArray value) {
    if (!value) return NULL;
    jsize units = (*env)->GetArrayLength(env, value);
    jchar* chars = (*env)->GetCharArrayElements(env, value, NULL);
    if (!chars) return NULL;
    size_t capacity = (size_t)units * 3u + 1u;
    char* result = (char*)calloc(capacity, 1u);
    if (result) {
        size_t offset = 0;
        for (jsize index = 0; index < units; index++) {
            uint32_t code = chars[index];
            if (code >= 0xD800u && code <= 0xDBFFu && index + 1 < units) {
                uint32_t low = chars[index + 1];
                if (low >= 0xDC00u && low <= 0xDFFFu) {
                    code = 0x10000u + ((code - 0xD800u) << 10u) + (low - 0xDC00u);
                    index++;
                }
            }
            if (code < 0x80u) result[offset++] = (char)code;
            else if (code < 0x800u) {
                result[offset++] = (char)(0xC0u | (code >> 6u));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            } else if (code < 0x10000u) {
                result[offset++] = (char)(0xE0u | (code >> 12u));
                result[offset++] = (char)(0x80u | ((code >> 6u) & 0x3Fu));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            } else {
                result[offset++] = (char)(0xF0u | (code >> 18u));
                result[offset++] = (char)(0x80u | ((code >> 12u) & 0x3Fu));
                result[offset++] = (char)(0x80u | ((code >> 6u) & 0x3Fu));
                result[offset++] = (char)(0x80u | (code & 0x3Fu));
            }
        }
    }
    memset(chars, 0, (size_t)units * sizeof(jchar));
    (*env)->ReleaseCharArrayElements(env, value, chars, 0);
    return result;
}

static jfieldID field(JNIEnv* env, jclass cls, const char* name, const char* signature) {
    return (*env)->GetFieldID(env, cls, name, signature);
}

JNIEXPORT jlong JNICALL
Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_create(
    JNIEnv* env, jobject self, jobject config, jobject sink) {
    (void)self;
    if (!config || !sink) return 0;
    jclass cls = (*env)->GetObjectClass(env, config);
    if (!cls) return 0;

    char* host = copy_utf8(env, (jstring)(*env)->GetObjectField(env, config, field(env, cls, "host", "Ljava/lang/String;")));
    char* username = copy_utf8(env, (jstring)(*env)->GetObjectField(env, config, field(env, cls, "username", "Ljava/lang/String;")));
    char* domain = copy_utf8(env, (jstring)(*env)->GetObjectField(env, config, field(env, cls, "domain", "Ljava/lang/String;")));
    char* password = copy_password(env, (jcharArray)(*env)->GetObjectField(env, config, field(env, cls, "password", "[C")));

    zephyr_rdp_config native_config = {0};
    native_config.host = host;
    native_config.port = (uint32_t)(*env)->GetIntField(env, config, field(env, cls, "port", "I"));
    native_config.username = username;
    native_config.password = password;
    native_config.domain = domain;
    native_config.width = (uint32_t)(*env)->GetIntField(env, config, field(env, cls, "widthPx", "I"));
    native_config.height = (uint32_t)(*env)->GetIntField(env, config, field(env, cls, "heightPx", "I"));
    native_config.color_depth = 32;
    native_config.security = ZEPHYR_RDP_SEC_NLA;
    native_config.ignore_certificate = 0;
    native_config.audio_mode = (*env)->GetBooleanField(env, config, field(env, cls, "audio", "Z")) ? ZEPHYR_RDP_AUDIO_LOCAL : ZEPHYR_RDP_AUDIO_OFF;
    native_config.microphone = (*env)->GetBooleanField(env, config, field(env, cls, "microphone", "Z"));
    native_config.clipboard = (*env)->GetBooleanField(env, config, field(env, cls, "clipboard", "Z"));
    native_config.dynamic_resolution = 1;
    native_config.gfx = 1;
    native_config.disable_wallpaper = 1;
    native_config.disable_themes = 1;
    native_config.disable_menu_anims = 1;
    native_config.disable_full_window_drag = 1;
    native_config.allow_font_smoothing = 1;

    android_rdp_session* session = (android_rdp_session*)calloc(1, sizeof(*session));
    if (session) {
        (*env)->GetJavaVM(env, &session->vm);
        session->sink = (*env)->NewGlobalRef(env, sink);
        session->native = zephyr_rdp_new(&native_config, frame_callback, event_callback, session);
        if (!session->sink || !session->native) {
            if (session->native) zephyr_rdp_free(session->native);
            if (session->sink) (*env)->DeleteGlobalRef(env, session->sink);
            free(session);
            session = NULL;
        }
    }

    if (password) { memset(password, 0, strlen(password)); free(password); }
    free(host);
    free(username);
    free(domain);
    (*env)->DeleteLocalRef(env, cls);
    return (jlong)(intptr_t)session;
}

static android_rdp_session* from_handle(jlong handle) {
    return (android_rdp_session*)(intptr_t)handle;
}

JNIEXPORT jint JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_run(
    JNIEnv* env, jobject self, jlong handle) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    return session ? zephyr_rdp_run(session->native) : -1;
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_stop(
    JNIEnv* env, jobject self, jlong handle) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    if (session) zephyr_rdp_stop(session->native);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_free(
    JNIEnv* env, jobject self, jlong handle) {
    (void)self;
    android_rdp_session* session = from_handle(handle);
    if (!session) return;
    zephyr_rdp_free(session->native);
    (*env)->DeleteGlobalRef(env, session->sink);
    free(session);
}

#define PTR_FLAGS_WHEEL          0x0200u
#define PTR_FLAGS_WHEEL_NEGATIVE 0x0100u
#define PTR_FLAGS_MOVE           0x0800u
#define PTR_FLAGS_DOWN           0x8000u
#define PTR_FLAGS_BUTTON1        0x1000u
#define PTR_FLAGS_BUTTON2        0x2000u
#define PTR_FLAGS_BUTTON3        0x4000u
#define KBD_FLAGS_EXTENDED       0x0100u
#define KBD_FLAGS_RELEASE        0x8000u

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendPointerMove(
    JNIEnv* env, jobject self, jlong handle, jint x, jint y) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    if (session) zephyr_rdp_send_mouse(session->native, PTR_FLAGS_MOVE, (uint16_t)x, (uint16_t)y);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendPointerButton(
    JNIEnv* env, jobject self, jlong handle, jint x, jint y, jint button, jboolean down) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    uint16_t flag = button == 1 ? PTR_FLAGS_BUTTON1 : button == 2 ? PTR_FLAGS_BUTTON3 : PTR_FLAGS_BUTTON2;
    if (session) zephyr_rdp_send_mouse(session->native, flag | (down ? PTR_FLAGS_DOWN : 0), (uint16_t)x, (uint16_t)y);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendWheel(
    JNIEnv* env, jobject self, jlong handle, jint x, jint y, jint delta) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    uint16_t amount = (uint16_t)(delta < 0 ? 0x100 + delta : delta);
    uint16_t flags = PTR_FLAGS_WHEEL | (delta < 0 ? PTR_FLAGS_WHEEL_NEGATIVE : 0) | (amount & 0xFFu);
    if (session) zephyr_rdp_send_mouse(session->native, flags, (uint16_t)x, (uint16_t)y);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendScancode(
    JNIEnv* env, jobject self, jlong handle, jint scan_code, jboolean down, jboolean extended) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    uint16_t flags = (down ? 0 : KBD_FLAGS_RELEASE) | (extended ? KBD_FLAGS_EXTENDED : 0);
    if (session) zephyr_rdp_send_scancode(session->native, flags, (uint16_t)scan_code);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendUnicode(
    JNIEnv* env, jobject self, jlong handle, jint utf16_unit, jboolean down) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    if (session) zephyr_rdp_send_unicode(session->native, down ? 0 : KBD_FLAGS_RELEASE, (uint16_t)utf16_unit);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_resize(
    JNIEnv* env, jobject self, jlong handle, jint width, jint height) {
    (void)env; (void)self;
    android_rdp_session* session = from_handle(handle);
    if (session) zephyr_rdp_resize(session->native, (uint32_t)width, (uint32_t)height);
}

JNIEXPORT void JNICALL Java_one_zephyr_mobile_protocol_rdp_JniRdpNativeBridge_sendClipboard(
    JNIEnv* env, jobject self, jlong handle, jstring value) {
    (void)self;
    android_rdp_session* session = from_handle(handle);
    char* text = copy_utf8(env, value);
    if (session && text) zephyr_rdp_set_clipboard(session->native, text);
    free(text);
}
