cmake_minimum_required(VERSION 3.16)
project(clearcodec_wasm C)

# Source files
set(SOURCES
    clearcodec_wasm.c
)

# Create executable (Emscripten produces .js + .wasm)
add_executable(clearcodec_decoder ${SOURCES})

# Emscripten-specific settings
if(EMSCRIPTEN)
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3")
    
    # Enable SIMD for faster operations
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -msimd128")
    
    # Exported functions
    set(EXPORTED_FUNCTIONS 
        "_clear_create"
        "_clear_free"
        "_clear_context_reset"
        "_clear_decompress"
        "_clear_alloc_output"
        "_clear_free_output"
        "_malloc"
        "_free"
    )
    
    # Convert list to comma-separated string
    string(REPLACE ";" "," EXPORTED_FUNCTIONS_STR "${EXPORTED_FUNCTIONS}")
    
    # Linker flags for WASM
    set_target_properties(clearcodec_decoder PROPERTIES
        SUFFIX ".js"
        LINK_FLAGS "\
            -sEXPORTED_FUNCTIONS=[${EXPORTED_FUNCTIONS_STR}] \
            -sEXPORTED_RUNTIME_METHODS=[ccall,cwrap,getValue,setValue,HEAPU8,HEAPU16,HEAPU32] \
            -sALLOW_MEMORY_GROWTH=1 \
            -sWASM=1 \
            -sMODULARIZE=1 \
            -sEXPORT_ES6=1 \
            -sEXPORT_NAME=ClearCodecDecoderModule \
            -sENVIRONMENT=web,worker \
            -sINITIAL_MEMORY=33554432 \
            -sSTACK_SIZE=1048576 \
            -sNO_EXIT_RUNTIME=1 \
            -sFILESYSTEM=0 \
            -sASSERTIONS=0 \
        "
    )
else()
    # Native build for testing
    set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -O3 -Wall -Wextra")
    
    # Add test executable
    add_executable(clearcodec_test ${SOURCES})
    target_compile_definitions(clearcodec_test PRIVATE EMSCRIPTEN_KEEPALIVE=)
endif()
