#if defined(__ANDROID__)
/* bionic hides posix_spawn unless a feature level is requested before includes. */
#if !defined(_POSIX_C_SOURCE) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE 1
#endif
#endif
#include <errno.h>
#include <fcntl.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include <jni.h>

extern char** environ;

static const int kMaxEdge = 4096;

static char* jstring_dup(JNIEnv* env, jstring value) {
    if (!value) return NULL;
    const char* utf = (*env)->GetStringUTFChars(env, value, NULL);
    if (!utf) return NULL;
    char* copy = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, value, utf);
    return copy;
}

static int spawn_capture(char* const argv[], int capture_stdout, char* output, size_t output_len, char* error, size_t error_len) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        snprintf(error, error_len, "无法启动 FFmpeg");
        return -1;
    }
    posix_spawn_file_actions_t actions;
    posix_spawn_file_actions_init(&actions);
    int nullfd = open("/dev/null", O_RDWR);
    if (nullfd >= 0) {
        posix_spawn_file_actions_adddup2(&actions, nullfd, capture_stdout ? STDERR_FILENO : STDOUT_FILENO);
    }
    posix_spawn_file_actions_adddup2(&actions, pipefd[1], capture_stdout ? STDOUT_FILENO : STDERR_FILENO);
    posix_spawn_file_actions_addclose(&actions, pipefd[0]);
    posix_spawn_file_actions_addclose(&actions, pipefd[1]);
    pid_t pid = 0;
    int spawn_rc = posix_spawn(&pid, argv[0], &actions, NULL, argv, environ);
    posix_spawn_file_actions_destroy(&actions);
    if (nullfd >= 0) close(nullfd);
    close(pipefd[1]);
    if (spawn_rc != 0) {
        close(pipefd[0]);
        snprintf(error, error_len, "无法启动 FFmpeg（%s）", strerror(spawn_rc));
        return -1;
    }
    size_t total = 0;
    if (output && output_len > 0) {
        for (;;) {
            ssize_t n = read(pipefd[0], output + total, output_len - 1 - total);
            if (n <= 0) break;
            total += (size_t)n;
            if (total >= output_len - 1) break;
        }
        output[total] = '\0';
    } else {
        char sink[256];
        while (read(pipefd[0], sink, sizeof(sink)) > 0) {}
    }
    close(pipefd[0]);
    int status = 0;
    if (waitpid(pid, &status, 0) < 0) {
        snprintf(error, error_len, "FFmpeg 等待失败");
        return -1;
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 127) {
        snprintf(error, error_len, "FFmpeg 二进制不可执行");
        return -1;
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
        char* last = output ? output : "";
        if (output) {
            last = output;
            for (char* p = output; *p; p++) if (*p == '\n') last = p + 1;
            while (*last == ' ' || *last == '\t' || *last == '\r') last++;
            size_t len = strlen(last);
            while (len > 0 && (last[len - 1] == '\n' || last[len - 1] == '\r')) last[--len] = '\0';
        }
        if (last && *last) snprintf(error, error_len, "FFmpeg 解码失败：%s", last);
        else snprintf(error, error_len, "FFmpeg 解码失败（exit %d）",
                      WIFEXITED(status) ? WEXITSTATUS(status) : -1);
        return -1;
    }
    return 0;
}

JNIEXPORT jstring JNICALL
Java_one_zephyr_mobile_protocol_ffmpeg_FfmpegImage_nativeConvert(
    JNIEnv* env,
    jclass clazz,
    jstring ffmpegPath,
    jstring inputPath,
    jstring outputPath,
    jint maxEdge
) {
    (void)clazz;
    char error[512];
    char captured[2048];
    error[0] = '\0';
    captured[0] = '\0';
    char* ffmpeg = jstring_dup(env, ffmpegPath);
    char* input = jstring_dup(env, inputPath);
    char* output = jstring_dup(env, outputPath);
    if (!ffmpeg || !input || !output) {
        free(ffmpeg); free(input); free(output);
        return (*env)->NewStringUTF(env, "缺少 FFmpeg 路径");
    }
    int edge = maxEdge > 0 && maxEdge <= kMaxEdge ? maxEdge : kMaxEdge;
    char scale[96];
    snprintf(
        scale, sizeof(scale),
        "scale='min(%d\\,iw)':'min(%d\\,ih)':force_original_aspect_ratio=decrease",
        edge, edge
    );
    char* argv[] = {
        ffmpeg,
        "-hide_banner",
        "-loglevel", "error",
        "-nostdin",
        "-y",
        "-i", input,
        "-an",
        "-frames:v", "1",
        "-vf", scale,
        "-q:v", "3",
        output,
        NULL,
    };
    int rc = spawn_capture(argv, 0, captured, sizeof(captured), error, sizeof(error));
    free(ffmpeg);
    free(input);
    free(output);
    if (rc != 0) return (*env)->NewStringUTF(env, error[0] ? error : "FFmpeg 解码失败");
    return NULL;
}


