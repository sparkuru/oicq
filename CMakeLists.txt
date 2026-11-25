cmake_minimum_required(VERSION 3.16)
project(oicq VERSION 0.2.2 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

find_package(Python3 COMPONENTS Interpreter REQUIRED)

# ---------------------------------------------------------------- JS runtime
# The runtime is embedded, not bundled: the native half writes these files into
# <tmp>/oicq/ and prepends require('<tmp>/oicq/boot.cjs') to the anchored
# source. Edit runtime/*.js and rebuild; no JavaScript toolchain is involved.
set(OICQ_RUNTIME_DIR ${CMAKE_CURRENT_SOURCE_DIR}/runtime)
set(OICQ_GENERATED ${CMAKE_CURRENT_BINARY_DIR}/resources_gen.cc)

# Embedding must rerun when a builtin changes, not only on main.js.
file(GLOB OICQ_BUILTIN_SOURCES CONFIGURE_DEPENDS
     ${OICQ_RUNTIME_DIR}/builtin/*.js)

add_custom_command(
  OUTPUT ${OICQ_GENERATED}
  COMMAND ${Python3_EXECUTABLE} ${CMAKE_CURRENT_SOURCE_DIR}/scripts/embed_runtime.py
          --runtime ${OICQ_RUNTIME_DIR}
          --out ${OICQ_GENERATED}
  DEPENDS ${OICQ_RUNTIME_DIR}/main.js
          ${OICQ_RUNTIME_DIR}/minimal.js
          ${OICQ_RUNTIME_DIR}/protocol.js
          ${OICQ_RUNTIME_DIR}/renderer.js
          ${OICQ_RUNTIME_DIR}/kernel.js
          ${OICQ_BUILTIN_SOURCES}
          ${CMAKE_CURRENT_SOURCE_DIR}/scripts/embed_runtime.py
  COMMENT "Embedding oicq runtime"
  VERBATIM)

# Single-owner rule: without this the same OUTPUT is attached to two targets and
# a parallel build can compile a half-written translation unit.
add_custom_target(oicq_runtime DEPENDS ${OICQ_GENERATED})

# ------------------------------------------------------------------- sources
set(OICQ_CORE_SOURCES
  src/core/log.cc
  src/core/config.cc
  src/core/resource.cc
  src/core/source_anchor.cc
  src/core/source_splice.cc
  src/core/hook_common.cc
  src/core/x86_length_decoder.cc)

set(OICQ_PLATFORM_SOURCES)
if(CMAKE_SYSTEM_NAME STREQUAL "Linux")
  list(APPEND OICQ_PLATFORM_SOURCES
    src/platform/linux/inline_hook.cc
    src/platform/linux/observe.cc
    src/platform/linux/entry.cc)
elseif(APPLE)
  list(APPEND OICQ_PLATFORM_SOURCES
    src/platform/macos/entry.cc
    src/platform/macos/dobby_backend.cc
    src/platform/macos/arm64_patch.cc)
elseif(WIN32)
  list(APPEND OICQ_PLATFORM_SOURCES
    src/platform/windows/entry.cc
    src/platform/windows/export_shim.cc
    src/platform/windows/inline_hook.cc
    src/platform/windows/remote_inject.cc
    src/platform/windows/renderer_bridge.cc)
endif()

# --------------------------------------------------------------------- target
add_library(oicq SHARED ${OICQ_CORE_SOURCES} ${OICQ_PLATFORM_SOURCES} ${OICQ_GENERATED})
add_dependencies(oicq oicq_runtime)
target_include_directories(oicq PUBLIC ${CMAKE_CURRENT_SOURCE_DIR}/src/include
                                      PRIVATE ${CMAKE_CURRENT_SOURCE_DIR}/src)
target_compile_options(oicq PRIVATE -Wall -Wextra -Wpedantic -fvisibility=hidden)
# No "lib" prefix: the artefact is loaded by name (LD_PRELOAD=./oicq.so,
# dlopen("oicq.so")). On Windows it ships as dbghelp.dll (see README).
set_target_properties(oicq PROPERTIES PREFIX "" OUTPUT_NAME "oicq")
if(UNIX AND NOT APPLE)
  target_link_libraries(oicq PRIVATE ${CMAKE_DL_LIBS} pthread)
  # GCC 11（Ubuntu 22.04 发布基线）会把静态 libstdc++ 里的 inline static 编成
  # STB_GNU_UNIQUE；该符号一旦被查找，glibc 就把 DSO 标成 NODELETE，dlclose 不再
  # 卸载，dlopen 冒烟测试和热重载都会受影响。关掉它，宿主与发布基线行为一致。
  target_compile_options(oicq PRIVATE -fno-gnu-unique)
  # 分发兼容：把 libstdc++/libgcc 静态链进来，目标机只需要 glibc >= 2.34。
  # 否则 GLIBCXX_3.4.29 会把 GCC 10 及更老的发行版（Debian 11）挡在外面。
  # --exclude-libs,ALL：把静态链进来的 libstdc++/libgcc 符号本地化，
  # 只留本项目自己的符号（用版本脚本会改变符号版本，反而破坏 interpose）。
  target_link_options(oicq PRIVATE -static-libstdc++ -static-libgcc -Wl,--exclude-libs,ALL)
  # 导出面。默认保留 init/performHook/OicqCompileFunctionHook（第三方 loader 会按名
  # 探测）；-DOICQ_STEALTH_EXPORTS=ON 只导出 interposer 符号，按名探测就拿不到了。
  # 自启动走 constructor，不依赖任何被 dlsym 的入口，实测两种构建注入行为一致。
  option(OICQ_STEALTH_EXPORTS "Hide init/performHook entry points from .dynsym" OFF)
  if(OICQ_STEALTH_EXPORTS)
    target_link_options(oicq PRIVATE
      -Wl,--version-script=${CMAKE_CURRENT_SOURCE_DIR}/src/platform/linux/oicq-stealth.map)
  endif()
endif()

# -------------------------------------------------------------------- checksec
if(UNIX AND NOT APPLE)
  add_custom_target(checksec
    COMMAND ${CMAKE_CURRENT_SOURCE_DIR}/scripts/checksec.sh $<TARGET_FILE:oicq>
    DEPENDS oicq
    COMMENT "Auditing forged observation surface"
    VERBATIM)
endif()

# ---------------------------------------------------------------------- tests
include(CTest)

if(BUILD_TESTING)
  # The runtime is plain JavaScript: exercise it in Node without Electron.
  find_program(OICQ_NODE NAMES node nodejs)
  if(OICQ_NODE)
    add_test(NAME runtime_smoke
             COMMAND ${OICQ_NODE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/runtime_smoke.js)
    add_test(NAME protocol_test
             COMMAND ${OICQ_NODE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/protocol_test.js)
    add_test(NAME kernel_test
             COMMAND ${OICQ_NODE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/kernel_test.js)
    add_test(NAME anti_recall_pro_test
             COMMAND ${OICQ_NODE} ${CMAKE_CURRENT_SOURCE_DIR}/tests/anti_recall_pro_test.js)
  else()
    message(STATUS "node not found; JavaScript tests skipped")
  endif()
endif()

if(BUILD_TESTING AND CMAKE_SYSTEM_NAME STREQUAL "Linux")
  add_executable(fake_v8_test
    tests/fake_v8_test.cc
    ${OICQ_CORE_SOURCES}
    src/platform/linux/inline_hook.cc
    src/platform/linux/entry.cc
    ${OICQ_GENERATED})
  add_dependencies(fake_v8_test oicq_runtime)
  target_include_directories(fake_v8_test PRIVATE src/include src)
  target_compile_options(fake_v8_test PRIVATE -Wall -Wextra)
  target_link_libraries(fake_v8_test PRIVATE ${CMAKE_DL_LIBS} pthread)
  add_test(NAME fake_v8_test COMMAND fake_v8_test)
  set_tests_properties(fake_v8_test PROPERTIES ENVIRONMENT "OICQ_AUTOINIT=0")

  add_executable(dlopen_smoke tests/dlopen_smoke.cc)
  target_compile_definitions(dlopen_smoke PRIVATE OICQ_SO_PATH="$<TARGET_FILE:oicq>")
  target_compile_options(dlopen_smoke PRIVATE -Wall -Wextra)
  target_link_libraries(dlopen_smoke PRIVATE ${CMAKE_DL_LIBS})
  add_dependencies(dlopen_smoke oicq)
  add_test(NAME dlopen_smoke COMMAND dlopen_smoke)
  set_tests_properties(dlopen_smoke PROPERTIES ENVIRONMENT "OICQ_AUTOINIT=0")
endif()
