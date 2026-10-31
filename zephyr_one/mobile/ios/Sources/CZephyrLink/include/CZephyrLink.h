#include <stdint.h>
#include <stdlib.h>

uint64_t ZephyrLinkCreate(void);
char *ZephyrLinkCall(uint64_t handle, const char *path, const char *input, int size);
void ZephyrLinkDestroy(uint64_t handle);
char *ZephyrLinkBuildInfo(void);
void ZephyrLinkFree(char *value);
