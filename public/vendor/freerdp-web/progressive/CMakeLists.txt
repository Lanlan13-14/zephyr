cmake_minimum_required(VERSION 3.16)
project(progressive_wasm C)

# Source files
set(SOURCES
    progressive_wasm.c
    rfx_rlgr.c
    rfx_dwt.c
    rfx_decode.c
)

# Create executable (Emscripten produces .js + .wasm)
add_executable(progressive_decoder ${SOURCES})

# Emscripten-specific settings
if(EMSCRIPTEN)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3")
    
    # Enable SIMD for faster DWT operations
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -msimd128")
    
    # Enable pthreads for parallel tile decoding
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -pthread")
    
    # Exported functions
    set(EXPORTED_FUNCTIONS 
        "_prog_create"
        "_prog_free"
        "_prog_create_surface"
        "_prog_delete_surface"
        "_prog_reset_surface"
        "_prog_decompress"
        "_prog_decompress_parallel"
        "_prog_get_tile_data"
        "_prog_get_dirty_tile_count"
        "_prog_get_dirty_tile_info"
        "_prog_get_surface_info"
        "_prog_get_extrapolate"
        "_malloc"
        "_free"
    )
    
    # Convert list to comma-separated string
    string(REPLACE ";" "," EXPORTED_FUNCTIONS_STR "${EXPORTED_FUNCTIONS}")
    
    # Linker flags for WASM with pthread support
    set_target_properties(progressive_decoder PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -pthread \
            -sUSE_PTHREADS=1 \
            -sPTHREAD_POOL_SIZE=4 \
            -sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS_STR}] \
            -sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,getValue,setValue,HEAPU8,HEAPU16,HEAPU32] \
            -sALLOW_MEMORY_GROWTH=1 \
            -sWASM=1 \
            -sMODULARIZE=1 \
            -sEXPORT_ES6=1 \
            -sEXPORT_NAME=ProgressiveDecoderModule \
            -sENVIRONMENT=web,worker \
            -sINITIAL_MEMORY=67108864 \
            -sSTACK_SIZE=1048576 \
            -sNO_EXIT_RUNTIME=1 \
            -sFILESYSTEM=0 \
            -sASSERTIONS=0 \
        "
    )
else()
    # Native build for testing
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3 -Wall -Wextra -pthread")
    
    # Add test executable
    add_executable(progressive_test ${SOURCES})
    target_compile_definitions(progressive_test PRIVATE EMSCRIPTEN_KEEPALIVE=)
    target_link_libraries(progressive_test pthread)
endif()
