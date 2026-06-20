cmake_minimum_required(VERSION 3.16)
project(rdp_bridge VERSION 1.0.0 LANGUAGES C)

# Use C11 standard
set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

# Build shared library
set(BUILD_SHARED_LIBS ON)

# Option to enable verbose settings/caps logging (disabled by default)
option(ENABLE_VERBOSE_SETTINGS_LOG "Enable verbose logging of RDP settings and capabilities" OFF)

# Find FreeRDP3 packages
find_package(PkgConfig REQUIRED)

# Find FreeRDP3 packages
pkg_check_modules(FREERDP3 REQUIRED freerdp3)
pkg_check_modules(FREERDP_CLIENT3 REQUIRED freerdp-client3)
pkg_check_modules(WINPR3 REQUIRED winpr3)
pkg_check_modules(OPUS REQUIRED opus)

# FFmpeg for AVC444 transcoding (4:4:4 → 4:2:0)
pkg_check_modules(LIBAVCODEC REQUIRED libavcodec)
pkg_check_modules(LIBAVUTIL REQUIRED libavutil)
pkg_check_modules(LIBSWSCALE REQUIRED libswscale)

# libwebp for encoding tiles (ClearCodec, Uncompressed, Planar → WebP)
pkg_check_modules(LIBWEBP REQUIRED libwebp)

# ==============================================================================
# Main RDP Bridge Library
# ==============================================================================

# Create the shared library
add_library(rdp_bridge SHARED
    rdp_bridge.c
)

# Include directories
target_include_directories(rdp_bridge PRIVATE
    ${FREERDP3_INCLUDE_DIRS}
    ${FREERDP_CLIENT3_INCLUDE_DIRS}
    ${WINPR3_INCLUDE_DIRS}
    ${OPUS_INCLUDE_DIRS}
    ${LIBAVCODEC_INCLUDE_DIRS}
    ${LIBAVUTIL_INCLUDE_DIRS}
    ${LIBSWSCALE_INCLUDE_DIRS}
    ${LIBWEBP_INCLUDE_DIRS}
)

# Link directories
target_link_directories(rdp_bridge PRIVATE
    ${FREERDP3_LIBRARY_DIRS}
    ${FREERDP_CLIENT3_LIBRARY_DIRS}
    ${WINPR3_LIBRARY_DIRS}
    ${OPUS_LIBRARY_DIRS}
    ${LIBAVCODEC_LIBRARY_DIRS}
    ${LIBAVUTIL_LIBRARY_DIRS}
    ${LIBSWSCALE_LIBRARY_DIRS}
    ${LIBWEBP_LIBRARY_DIRS}
)

# Link libraries
target_link_libraries(rdp_bridge PRIVATE
    ${FREERDP3_LIBRARIES}
    ${FREERDP_CLIENT3_LIBRARIES}
    ${WINPR3_LIBRARIES}
    ${OPUS_LIBRARIES}
    ${LIBAVCODEC_LIBRARIES}
    ${LIBAVUTIL_LIBRARIES}
    ${LIBSWSCALE_LIBRARIES}
    ${LIBWEBP_LIBRARIES}
    pthread
    dl
)

# Compiler flags
target_compile_options(rdp_bridge PRIVATE
    ${FREERDP3_CFLAGS_OTHER}
    ${FREERDP_CLIENT3_CFLAGS_OTHER}
    ${WINPR3_CFLAGS_OTHER}
    ${OPUS_CFLAGS_OTHER}
    ${LIBAVCODEC_CFLAGS_OTHER}
    ${LIBAVUTIL_CFLAGS_OTHER}
    ${LIBSWSCALE_CFLAGS_OTHER}
    ${LIBWEBP_CFLAGS_OTHER}
    -Wall
    -Wextra
    -O2
)

# Compile definitions
if(ENABLE_VERBOSE_SETTINGS_LOG)
    target_compile_definitions(rdp_bridge PRIVATE ENABLE_VERBOSE_SETTINGS_LOG=1)
endif()

# Set library properties
set_target_properties(rdp_bridge PROPERTIES
    VERSION ${PROJECT_VERSION}
    SOVERSION 1
    PUBLIC_HEADER rdp_bridge.h
)

# ==============================================================================
# RDPSND Bridge Plugin (standalone, version-independent)
# ==============================================================================

add_library(rdpsnd-bridge SHARED
    rdpsnd_bridge.c
)

# Include directories for plugin
target_include_directories(rdpsnd-bridge PRIVATE
    ${FREERDP3_INCLUDE_DIRS}
    ${FREERDP_CLIENT3_INCLUDE_DIRS}
    ${WINPR3_INCLUDE_DIRS}
    ${OPUS_INCLUDE_DIRS}
    ${CMAKE_CURRENT_SOURCE_DIR}
)

# Link directories for plugin
target_link_directories(rdpsnd-bridge PRIVATE
    ${FREERDP3_LIBRARY_DIRS}
    ${FREERDP_CLIENT3_LIBRARY_DIRS}
    ${WINPR3_LIBRARY_DIRS}
    ${OPUS_LIBRARY_DIRS}
)

# Link libraries for plugin (minimal - only what we need)
target_link_libraries(rdpsnd-bridge PRIVATE
    ${FREERDP3_LIBRARIES}
    ${FREERDP_CLIENT3_LIBRARIES}
    ${WINPR3_LIBRARIES}
    ${OPUS_LIBRARIES}
    pthread
    dl
)

# Compiler flags for plugin
target_compile_options(rdpsnd-bridge PRIVATE
    ${FREERDP3_CFLAGS_OTHER}
    ${FREERDP_CLIENT3_CFLAGS_OTHER}
    ${WINPR3_CFLAGS_OTHER}
    ${OPUS_CFLAGS_OTHER}
    -Wall
    -Wextra
    -O2
    -fvisibility=hidden
)

# Set plugin properties - must be named librdpsnd-client-bridge.so for FreeRDP to find it
set_target_properties(rdpsnd-bridge PROPERTIES
    OUTPUT_NAME "rdpsnd-client-bridge"
    PREFIX "lib"
    SUFFIX ".so"
)

# ==============================================================================
# Install targets
# ==============================================================================

# Install main library
install(TARGETS rdp_bridge
    LIBRARY DESTINATION lib
    PUBLIC_HEADER DESTINATION include
)

# Install RDPSND plugin to FreeRDP plugin directory
# FreeRDP3 looks for plugins in /usr/lib/freerdp3 or similar
install(TARGETS rdpsnd-bridge
    LIBRARY DESTINATION lib/freerdp3
)

# Print configuration summary
message(STATUS "FreeRDP3 include dirs: ${FREERDP3_INCLUDE_DIRS}")
message(STATUS "FreeRDP3 libraries: ${FREERDP3_LIBRARIES}")
message(STATUS "WinPR3 libraries: ${WINPR3_LIBRARIES}")
message(STATUS "Opus libraries: ${OPUS_LIBRARIES}")
