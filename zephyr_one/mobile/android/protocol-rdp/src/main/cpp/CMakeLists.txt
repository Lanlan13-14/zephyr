cmake_minimum_required(VERSION 3.22.1)
project(zephyr_rdp_android LANGUAGES C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

if(NOT DEFINED ZEPHYR_FREERDP_ANDROID_ROOT)
    message(FATAL_ERROR "Set zephyr.rdp.freerdpAndroidRoot or ZEPHYR_ANDROID_FREERDP_ROOT")
endif()

set(FREERDP_PREFIX "${ZEPHYR_FREERDP_ANDROID_ROOT}/${ANDROID_ABI}")
set(FREERDP_INCLUDE "${FREERDP_PREFIX}/include/freerdp3")
set(WINPR_INCLUDE "${FREERDP_PREFIX}/include/winpr3")
set(FREERDP_LIB "${FREERDP_PREFIX}/lib")
set(FREERDP_STAMP "${FREERDP_PREFIX}/.zephyr-freerdp-tag")

if(NOT EXISTS "${FREERDP_STAMP}")
    message(FATAL_ERROR "Missing patched FreeRDP stamp for ${ANDROID_ABI}: ${FREERDP_STAMP}")
endif()
file(READ "${FREERDP_STAMP}" FREERDP_STAMP_VALUE)
string(STRIP "${FREERDP_STAMP_VALUE}" FREERDP_STAMP_VALUE)
if(NOT FREERDP_STAMP_VALUE STREQUAL "3.30.0+cliprdr-reassembly-limit-v1")
    message(FATAL_ERROR "FreeRDP ${ANDROID_ABI} must be 3.30.0+cliprdr-reassembly-limit-v1")
endif()

set(REQUIRED_ARCHIVES
    freerdp-client3
    freerdp3
    winpr3
    remdesk-common
    rdpsnd-common
    ssl
    crypto
    cjson
)
foreach(ARCHIVE IN LISTS REQUIRED_ARCHIVES)
    set(ARCHIVE_PATH "${FREERDP_LIB}/lib${ARCHIVE}.a")
    if(NOT EXISTS "${ARCHIVE_PATH}")
        message(FATAL_ERROR "Missing Android ${ANDROID_ABI} static archive: ${ARCHIVE_PATH}")
    endif()
    add_library("${ARCHIVE}" STATIC IMPORTED)
    set_target_properties("${ARCHIVE}" PROPERTIES IMPORTED_LOCATION "${ARCHIVE_PATH}")
endforeach()

get_filename_component(ZEPHYR_ONE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../../../../.." ABSOLUTE)
set(FREERDP_CORE "${ZEPHYR_ONE_ROOT}/native/freerdp-core")

add_library(zephyr_rdp_android SHARED
    zephyr_rdp_jni.c
    "${FREERDP_CORE}/zephyr_rdp.c"
)

target_include_directories(zephyr_rdp_android PRIVATE
    "${FREERDP_CORE}"
    "${FREERDP_INCLUDE}"
    "${WINPR_INCLUDE}"
)
target_compile_options(zephyr_rdp_android PRIVATE -Wall -Wextra -Werror -Wno-deprecated-declarations)
target_link_options(zephyr_rdp_android PRIVATE "-Wl,--exclude-libs,ALL")
target_link_libraries(zephyr_rdp_android PRIVATE
    "-Wl,--start-group"
    freerdp-client3 freerdp3 winpr3 remdesk-common rdpsnd-common ssl crypto cjson
    "-Wl,--end-group"
    z log android dl m OpenSLES
)
