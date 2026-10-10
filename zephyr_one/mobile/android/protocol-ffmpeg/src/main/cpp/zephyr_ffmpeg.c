#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#include <jni.h>

static const int kMaxEdge = 4096;

static char* jstring_dup(JNIEnv* env, jstring value) {
    if (!value) return NULL;
    const char* utf = (*env)->GetStringUTFChars(env, value, NULL);
    if (!utf) return NULL;
    char* copy = strdup(utf);
    (*env)->ReleaseStringUTFChars(env, value, utf);
    return copy;
}

/*
 * fork/execv runs the pinned FFmpeg CLI. posix_spawn is gated behind feature
 * macros in bionic and NDK toolchains disagree about the level, while fork is
 * always available. The child is short-lived and never touches the JVM, so
 * the Zygote fork caveats do not apply.
 */
static int spawn_capture(char* const argv[], char* output, size_t output_len, char* error, size_t error_len) {
    int pipefd[2];
    if (pipe(pipefd) != 0) {
        snprintf(error, error_len, "无法启动 FFmpeg");
        return -1;
    }
    pid_t pid = fork();
    if (pid < 0) {
        close(pipefd[0]);
        close(pipefd[1]);
        snprintf(error, error_len, "无法启动 FFmpeg");
        return -1;
    }
    if (pid == 0) {
        int nullfd = open("/dev/null", O_WRONLY);
        if (nullfd >= 0) {
            dup2(nullfd, STDOUT_FILENO);
            close(nullfd);
        }
        dup2(pipefd[1], STDERR_FILENO);
        close(pipefd[0]);
        close(pipefd[1]);
        execv(argv[0], argv);
        _exit(127);
    }
    close(pipefd[1]);
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
        char* last = "";
        if (output) {
            last = output;
            for (char* p = output; *p; p++) if (*p == '\n') last = p + 1;
            while (*last == ' ' || *last == '\t' || *last == '\r') last++;
            size_t len = strlen(last);
            while (len > 0 && (last[len - 1] == '\n' || last[len - 1] == '\r')) last[--len] = '\0';
        }
        if (*last) snprintf(error, error_len, "FFmpeg 解码失败：%s", last);
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
    int rc = spawn_capture(argv, captured, sizeof(captured), error, sizeof(error));
    free(ffmpeg);
    free(input);
    free(output);
    if (rc != 0) return (*env)->NewStringUTF(env, error[0] ? error : "FFmpeg 解码失败");
    return NULL;
}
