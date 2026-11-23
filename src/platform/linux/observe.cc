// observe — 观测面一致性层（Linux）
//
// 目标：让 QQ 自己读到的“我有没有被注入”的答案是干净的，而不去改它的代码。
// 所有自检最终都落在 libc 出口上，因此这里只改写这些出口的返回值：
//
//   open/open64/openat/openat64      /proc/self/{maps,smaps,environ}
//   fopen/freopen                    同上（glibc stdio 走内部 __read 别名，拦 read 无效）
//   stat/lstat/fstatat/statx/access  私有产物路径（/tmp/oicq、~/.oicq、qq.desktop）
//   opendir/readdir/readdir64/scandir 目录项
//   readlink/readlinkat              /proc/self/fd/N 指向 memfd 时回原路径
//   dl_iterate_phdr                  跳过本对象与 OICQ_SHIELD_HIDE 里的模块
//   getenv/secure_getenv             LD_PRELOAD、对非 oicq 调用者隐藏 OICQ_*
//
// 三条硬约束（都是实测撞出来的，见 experiments/forge/README.md）：
//   1. 不清空 envp、不 unsetenv：QQ 启动器会 execv 自己一次，变量一旦被抹掉，
//      新镜像就不再有 LD_PRELOAD，整个注入层消失。这里只过滤读取结果。
//   2. 不拦 dlsym：glibc 用 dlsym 调用点的返回地址解析 RTLD_NEXT，转一手会改变语义。
//   3. 子进程（--type=）不安装：Chromium 子进程有 seccomp，memfd_create 可能直接
//      被 kill；主进程与 crashpad_handler 安装即可覆盖模块枚举来源。

#ifndef _GNU_SOURCE
#define _GNU_SOURCE
#endif
#include <ctype.h>
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <link.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <linux/openat2.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef SYS_memfd_create
#define SYS_memfd_create 319
#endif
#ifndef MFD_CLOEXEC
#define MFD_CLOEXEC 0x0001U
#endif

#include "oicq/config.h"

extern "C" char** environ;

namespace {

// ------------------------------------------------------------------ 状态

struct ShieldState {
  bool installed = false;
  bool child = false;
  char self_base[64] = {0};   // 自己的文件名，例如 oicq.so
  char hide[8][96] = {{0}};   // 额外要隐藏的模块名（OICQ_SHIELD_HIDE）
  int hide_count = 0;
  void* target = nullptr;     // QQ 的 CompileFunction，用来定位被写过的那一页
  bool target_checked = false;
  unsigned long zeroed_kb = 0;            // 被清零的 Anonymous 计数，用于 smaps_rollup 自洽
  struct { unsigned long lo, hi; } hidden_ranges[16];
  int hidden_range_count = 0;
};

ShieldState& state() {
  static ShieldState instance;
  return instance;
}

// ------------------------------------------------------------------ 原生通道

long rsys3(long n, long a, long b, long c) {
  long r;
  __asm__ volatile("syscall"
                   : "=a"(r)
                   : "a"(n), "D"(a), "S"(b), "d"(c)
                   : "rcx", "r11", "memory");
  return r;
}

long rsys4(long n, long a, long b, long c, long d) {
  register long r10 __asm__("r10") = d;
  long r;
  __asm__ volatile("syscall"
                   : "=a"(r)
                   : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10)
                   : "rcx", "r11", "memory");
  return r;
}

// 手写解析：glibc 2.38 起 sscanf/strtol 会重定向到 __isoc23_*，把 .so 的最低
// glibc 要求抬到 2.38。分发时要兼容 2.34（Ubuntu 22.04 / Debian 12），所以不用它们。
bool parse_hex(const char* p, const char* end, unsigned long* out) {
  unsigned long value = 0;
  bool any = false;
  while (p < end) {
    char c = *p;
    int digit = -1;
    if (c >= '0' && c <= '9') digit = c - '0';
    else if (c >= 'a' && c <= 'f') digit = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F') digit = c - 'A' + 10;
    else break;
    value = value * 16 + static_cast<unsigned long>(digit);
    any = true;
    ++p;
  }
  if (!any) return false;
  *out = value;
  return true;
}

bool parse_dec(const char* p, int* out) {
  int value = 0;
  bool any = false;
  while (*p >= '0' && *p <= '9') {
    value = value * 10 + (*p - '0');
    any = true;
    ++p;
  }
  if (!any) return false;
  *out = value;
  return true;
}

bool starts_with(const char* s, const char* p) {
  return s != nullptr && p != nullptr && strncmp(s, p, strlen(p)) == 0;
}

bool contains(const char* s, const char* p) {
  return s != nullptr && p != nullptr && strstr(s, p) != nullptr;
}

// ------------------------------------------------------------------ 路径判定

bool is_proc_leaf(const char* path, const char* leaf) {
  if (path == nullptr || strncmp(path, "/proc/", 6) != 0) return false;
  const char* seg = path + 6;
  const char* slash = strchr(seg, '/');
  if (slash == nullptr) return false;
  size_t seg_len = static_cast<size_t>(slash - seg);
  char pid[24];
  snprintf(pid, sizeof pid, "%d", static_cast<int>(getpid()));
  bool ok = (seg_len == 4 && strncmp(seg, "self", 4) == 0) ||
            (seg_len == 11 && strncmp(seg, "thread-self", 11) == 0) ||
            (seg_len == strlen(pid) && strncmp(seg, pid, seg_len) == 0);
  if (!ok) return false;
  const char* rest = slash + 1;
  if (strncmp(rest, "task/", 5) == 0) {
    const char* tid = rest + 5;
    const char* next = strchr(tid, '/');
    if (next == nullptr) return false;
    rest = next + 1;
  }
  return strcmp(rest, leaf) == 0;
}

const char* home_dir() {
  static char cached[256];
  static bool ready = false;
  if (!ready) {
    const char* h = getenv("HOME");
    snprintf(cached, sizeof cached, "%s", h != nullptr ? h : "");
    ready = true;
  }
  return cached;
}

bool is_private_path(const char* path) {
  if (path == nullptr) return false;
  if (starts_with(path, "/tmp/oicq")) return true;
  const char* h = home_dir();
  if (h[0] == '\0') return false;
  char buf[512];
  snprintf(buf, sizeof buf, "%s/.oicq", h);
  if (starts_with(path, buf)) return true;
  snprintf(buf, sizeof buf, "%s/.local/share/applications/qq.desktop", h);
  return strcmp(path, buf) == 0;
}

// 行内匹配：/proc 的行没有 NUL 结尾，strstr 会扫到后面的行去（第一版就踩了这个）
bool hidden_line(const char* line, size_t len) {
  const ShieldState& s = state();
  auto has = [&](const char* needle) {
    size_t k = strlen(needle);
    if (k == 0 || len < k) return false;
    for (size_t i = 0; i + k <= len; ++i)
      if (memcmp(line + i, needle, k) == 0) return true;
    return false;
  };
  if (s.self_base[0] != '\0' && has(s.self_base)) return true;
  for (int i = 0; i < s.hide_count; ++i)
    if (has(s.hide[i])) return true;
  return false;
}

bool hidden_module(const char* name) {
  if (name == nullptr) return false;
  const ShieldState& s = state();
  if (s.self_base[0] != '\0' && contains(name, s.self_base)) return true;
  for (int i = 0; i < s.hide_count; ++i)
    if (contains(name, s.hide[i])) return true;
  return false;
}

// ------------------------------------------------------------------ 内容改写

void blank_span(char* s, size_t n) {
  for (size_t i = 0; i < n; ++i)
    if (s[i] != '\n') s[i] = ' ';
}

// 把 "Anonymous:     4 kB" 改写成 "Anonymous:     0 kB"，保持行长度与格式
unsigned long zero_counter(char* line, size_t len) {
  const char* colon = static_cast<const char*>(memchr(line, ':', len));
  if (colon == nullptr) return 0;
  const char* num = colon + 1;
  const char* end = line + len;
  while (num < end && *num == ' ') ++num;
  const char* kB = nullptr;
  for (const char* p = num; p + 1 < end; ++p)
    if (p[0] == 'k' && p[1] == 'B') { kB = p; break; }
  if (kB == nullptr) return 0;
  size_t width = static_cast<size_t>(kB - num);
  if (width < 2 || width > 64) return 0;
  unsigned long original = strtoul(num, nullptr, 10);
  char* field = const_cast<char*>(num);
  memset(field, ' ', width);   // 原地改写，绝不越界
  field[0] = '0';
  return original;
}

// 读真实内容（内联 syscall，绕过本层与其它 preload）
char* read_raw(const char* path, size_t* out_len) {
  long fd = rsys3(SYS_openat, AT_FDCWD, reinterpret_cast<long>(path), O_RDONLY | O_CLOEXEC);
  if (fd < 0) return nullptr;
  size_t cap = 64 * 1024, n = 0;
  char* buf = static_cast<char*>(malloc(cap + 1));
  if (buf == nullptr) {
    rsys3(SYS_close, fd, 0, 0);
    return nullptr;
  }
  for (;;) {
    if (n + 8192 > cap) {
      cap *= 2;
      char* grown = static_cast<char*>(realloc(buf, cap + 1));
      if (grown == nullptr) break;
      buf = grown;
    }
    long got = rsys3(SYS_read, fd, reinterpret_cast<long>(buf + n), 8192);
    if (got <= 0) break;
    n += static_cast<size_t>(got);
  }
  rsys3(SYS_close, fd, 0, 0);
  buf[n] = '\0';           // 后续要按行 sscanf/strstr，必须自己收尾
  *out_len = n;
  return buf;
}

int memfd_from(const char* data, size_t len) {
  long fd = rsys3(SYS_memfd_create, reinterpret_cast<long>("procview"), MFD_CLOEXEC, 0);
  if (fd < 0) return -1;
  size_t off = 0;
  while (off < len) {
    long n = rsys3(SYS_write, fd, reinterpret_cast<long>(data + off), len - off);
    if (n <= 0) {
      rsys3(SYS_close, fd, 0, 0);
      return -1;
    }
    off += static_cast<size_t>(n);
  }
  rsys3(SYS_lseek, fd, 0, SEEK_SET);
  return static_cast<int>(fd);
}

void resolve_target();

// maps：直接删掉命中隐藏模块的行（不留空行——按行解析的校验器遇到空白行会 CHECK 失败）
size_t filter_maps(char* buf, size_t len) {
  size_t read_at = 0, write_at = 0;
  while (read_at < len) {
    size_t end = read_at;
    while (end < len && buf[end] != '\n') ++end;
    size_t line_len = end - read_at;
    bool hide = line_len > 0 && buf[read_at] != ' ' && hidden_line(buf + read_at, line_len);
    if (hide) {
      unsigned long lo = 0, hi = 0;
      if (sscanf(buf + read_at, "%lx-%lx", &lo, &hi) == 2 && lo != 0 && hi > lo) {
        ShieldState& st = state();
        if (st.hidden_range_count < 16) {
          st.hidden_ranges[st.hidden_range_count].lo = lo;
          st.hidden_ranges[st.hidden_range_count].hi = hi;
          ++st.hidden_range_count;
        }
      }
    } else {
      memmove(buf + write_at, buf + read_at, line_len);
      write_at += line_len;
      if (end < len) buf[write_at++] = '\n';
    }
    read_at = end + 1;
  }
  return write_at;
}

// smaps：整块删除（header + 缩进的明细行）；顺便把被写过的那一页的计数清零
size_t filter_smaps(char* buf, size_t len) {
  resolve_target();
  ShieldState& s = state();
  s.zeroed_kb = 0;
  size_t read_at = 0, write_at = 0;
  bool drop = false;
  unsigned long block_lo = 0, block_hi = 0;
  while (read_at < len) {
    size_t end = read_at;
    while (end < len && buf[end] != '\n') ++end;
    size_t line_len = end - read_at;
    bool header = line_len > 12 && buf[read_at] != ' ' &&
                  isxdigit(static_cast<unsigned char>(buf[read_at]));
    if (header) {
      unsigned long lo = 0, hi = 0;
      const char* dash = static_cast<const char*>(memchr(buf + read_at, '-', line_len));
      if (dash != nullptr && parse_hex(buf + read_at, dash, &lo) &&
          parse_hex(dash + 1, buf + read_at + line_len, &hi)) {
        block_lo = lo;
        block_hi = hi;
      }
      drop = hidden_line(buf + read_at, line_len);
    }
    if (!drop) {
      memmove(buf + write_at, buf + read_at, line_len);
      if (s.target != nullptr) {
        unsigned long addr = reinterpret_cast<unsigned long>(s.target);
        bool in_block = addr >= block_lo && addr < block_hi;
        if (in_block && (starts_with(buf + write_at, "Anonymous:") ||
                         starts_with(buf + write_at, "Private_Dirty:") ||
                         starts_with(buf + write_at, "Shared_Dirty:"))) {
          s.zeroed_kb += zero_counter(buf + write_at, line_len);
        }
      }
      write_at += line_len;
      if (end < len) buf[write_at++] = '\n';
    }
    read_at = end + 1;
  }
  return write_at;
}

// environ：删掉条目（只改读取结果，绝不动 envp 块——否则 re-exec 丢 LD_PRELOAD）
size_t filter_environ(char* buf, size_t len) {
  size_t read_at = 0, write_at = 0;
  while (read_at < len) {
    size_t end = read_at;
    while (end < len && buf[end] != '\0') ++end;
    char* entry = buf + read_at;
    bool hide = starts_with(entry, "LD_PRELOAD=") || starts_with(entry, "OICQ_") ||
                starts_with(entry, "FORGE_");
    if (!hide) {
      memmove(buf + write_at, buf + read_at, end - read_at);
      write_at += end - read_at;
      if (end < len) buf[write_at++] = '\0';
    }
    read_at = end + 1;
  }
  return write_at;
}

// numa_maps 与 maps 同为按 VMA 的文件，只是列不同
size_t filter_numa_maps(char* buf, size_t len) {
  size_t read_at = 0, write_at = 0;
  while (read_at < len) {
    size_t end = read_at;
    while (end < len && buf[end] != '\n') ++end;
    size_t line_len = end - read_at;
    bool hide = line_len > 0 && hidden_line(buf + read_at, line_len);
    if (!hide) {
      memmove(buf + write_at, buf + read_at, line_len);
      write_at += line_len;
      if (end < len) buf[write_at++] = '\n';
    }
    read_at = end + 1;
  }
  return write_at;
}

// smaps_rollup 是汇总，不含模块名；要与被清零的 smaps 保持自洽，扣掉同一笔
size_t filter_smaps_rollup(char* buf, size_t len) {
  const ShieldState& s = state();
  if (s.zeroed_kb == 0) return filter_numa_maps(buf, len);
  size_t start = 0;
  while (start < len) {
    size_t end = start;
    while (end < len && buf[end] != '\n') ++end;
    if (starts_with(buf + start, "Anonymous:") || starts_with(buf + start, "Private_Dirty:")) {
      const char* colon = static_cast<const char*>(memchr(buf + start, ':', end - start));
      if (colon != nullptr) {
        const char* num = colon + 1;
        const char* line_end = buf + end;
        while (num < line_end && *num == ' ') ++num;
        unsigned long value = strtoul(num, nullptr, 10);
        unsigned long adjusted = value > s.zeroed_kb ? value - s.zeroed_kb : 0;
        char field[32];
        int n = snprintf(field, sizeof field, "%lu", adjusted);
        size_t width = static_cast<size_t>(line_end - num);
        if (n > 0 && static_cast<size_t>(n) <= width) {
          memset(const_cast<char*>(num), ' ', width);
          memcpy(const_cast<char*>(num), field, static_cast<size_t>(n));
        }
      }
    }
    start = end + 1;
  }
  return len;
}

size_t filter_status(char* buf, size_t len) {
  size_t start = 0;
  while (start < len) {
    size_t end = start;
    while (end < len && buf[end] != '\n') ++end;
    if (starts_with(buf + start, "TracerPid:")) {
      size_t colon = start + strlen("TracerPid:");
      for (size_t k = colon; k < end; ++k) buf[k] = ' ';
    }
    start = end + 1;
  }
  return len;
}

char* forge_payload(const char* path, size_t* out_len) {
  size_t n = 0;
  char* buf = read_raw(path, &n);
  if (buf == nullptr) return nullptr;
  if (is_proc_leaf(path, "maps")) {
    n = filter_maps(buf, n);
  } else if (is_proc_leaf(path, "smaps")) {
    n = filter_smaps(buf, n);
  } else if (is_proc_leaf(path, "environ")) {
    n = filter_environ(buf, n);
  } else if (is_proc_leaf(path, "status")) {
    n = filter_status(buf, n);
  } else if (is_proc_leaf(path, "numa_maps")) {
    n = filter_numa_maps(buf, n);
  } else if (is_proc_leaf(path, "smaps_rollup")) {
    n = filter_smaps_rollup(buf, n);
  }
  *out_len = n;
  return buf;
}

int forge_fd(const char* path) {
  if (!state().installed || path == nullptr) return -1;
  if (!(is_proc_leaf(path, "maps") || is_proc_leaf(path, "smaps") ||
        is_proc_leaf(path, "environ") || is_proc_leaf(path, "status") ||
        is_proc_leaf(path, "numa_maps") || is_proc_leaf(path, "smaps_rollup")))
    return -1;
  size_t n = 0;
  char* buf = forge_payload(path, &n);
  if (buf == nullptr) return -1;
  int fd = memfd_from(buf, n);
  free(buf);
  return fd;
}

// fd → 原路径，供 readlink(/proc/self/fd/N) 还原
constexpr int kFdMax = 1024;
struct FdSlot {
  int fd;
  char path[160];
};
FdSlot g_fdmap[kFdMax];

void fdmap_put(int fd, const char* path) {
  if (fd < 0) return;
  for (int i = 0; i < kFdMax; ++i) {
    if (g_fdmap[i].fd == 0 || g_fdmap[i].fd == fd) {
      g_fdmap[i].fd = fd;
      snprintf(g_fdmap[i].path, sizeof g_fdmap[i].path, "%s", path);
      return;
    }
  }
}

const char* fdmap_get(int fd) {
  for (int i = 0; i < kFdMax; ++i)
    if (g_fdmap[i].fd == fd) return g_fdmap[i].path;
  return nullptr;
}

void fdmap_del(int fd) {
  for (int i = 0; i < kFdMax; ++i)
    if (g_fdmap[i].fd == fd) g_fdmap[i].fd = 0;
}

// ------------------------------------------------------------------ 目录

struct DirSlot {
  DIR* dir;
  char path[160];
};
DirSlot g_dirmap[128];

const char* dirmap_path(DIR* d) {
  for (auto& slot : g_dirmap)
    if (slot.dir == d) return slot.path;
  return "";
}

void dirmap_put(DIR* d, const char* path) {
  for (auto& slot : g_dirmap) {
    if (slot.dir == nullptr || slot.dir == d) {
      slot.dir = d;
      snprintf(slot.path, sizeof slot.path, "%s", path);
      return;
    }
  }
}

bool is_map_files_dir(const char* dir) {
  size_t n = strlen(dir);
  return n >= 10 && strcmp(dir + n - 10, "/map_files") == 0;
}

// map_files 的目录项名就是 VMA 地址范围；命中被隐藏的范围就过滤掉
bool hidden_map_range(const char* name) {
  unsigned long lo = 0, hi = 0;
  if (name == nullptr || sscanf(name, "%lx-%lx", &lo, &hi) != 2) return false;
  const ShieldState& s = state();
  for (int i = 0; i < s.hidden_range_count; ++i)
    if (lo == s.hidden_ranges[i].lo && hi == s.hidden_ranges[i].hi) return true;
  return false;
}

bool hide_entry(const char* dir, const char* name) {
  if (!state().installed || name == nullptr) return false;
  if (starts_with(dir, "/tmp") && (strcmp(name, "oicq") == 0 || starts_with(name, "oicq-probe")))
    return true;
  if (is_map_files_dir(dir) && hidden_map_range(name)) return true;
  return false;
}

}  // namespace

// ---------------------------------------------------------------------- hooks

extern "C" {

#pragma GCC visibility push(default)

using open_fn = int (*)(const char*, int, ...);
using openat_fn = int (*)(int, const char*, int, ...);

static open_fn real_open;
static open_fn real_open64;
static openat_fn real_openat;
static openat_fn real_openat64;

int open(const char* path, int flags, ...) {
  mode_t mode = 0;
  if ((flags & O_CREAT) != 0) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  if (!real_open) real_open = reinterpret_cast<open_fn>(dlsym(RTLD_NEXT, "open"));
  int fd = forge_fd(path);
  if (fd >= 0) {
    fdmap_put(fd, path);
    return fd;
  }
  return real_open(path, flags, mode);
}

int open64(const char* path, int flags, ...) {
  mode_t mode = 0;
  if ((flags & O_CREAT) != 0) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  if (!real_open64) real_open64 = reinterpret_cast<open_fn>(dlsym(RTLD_NEXT, "open64"));
  int fd = forge_fd(path);
  if (fd >= 0) {
    fdmap_put(fd, path);
    return fd;
  }
  return real_open64(path, flags, mode);
}

int openat(int dirfd, const char* path, int flags, ...) {
  mode_t mode = 0;
  if ((flags & O_CREAT) != 0) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  if (!real_openat) real_openat = reinterpret_cast<openat_fn>(dlsym(RTLD_NEXT, "openat"));
  if ((flags & O_DIRECTORY) == 0) {
    int fd = forge_fd(path);
    if (fd >= 0) {
      fdmap_put(fd, path);
      return fd;
    }
  }
  return real_openat(dirfd, path, flags, mode);
}

int openat64(int dirfd, const char* path, int flags, ...) {
  mode_t mode = 0;
  if ((flags & O_CREAT) != 0) {
    va_list ap;
    va_start(ap, flags);
    mode = va_arg(ap, int);
    va_end(ap);
  }
  if (!real_openat64) real_openat64 = reinterpret_cast<openat_fn>(dlsym(RTLD_NEXT, "openat64"));
  if ((flags & O_DIRECTORY) == 0) {
    int fd = forge_fd(path);
    if (fd >= 0) {
      fdmap_put(fd, path);
      return fd;
    }
  }
  return real_openat64(dirfd, path, flags, mode);
}

int openat2(int dirfd, const char* path, struct open_how* how, size_t size) {
  static int (*real_openat2)(int, const char*, struct open_how*, size_t);
  if (!real_openat2) real_openat2 = reinterpret_cast<decltype(real_openat2)>(dlsym(RTLD_NEXT, "openat2"));
  int fd = forge_fd(path);
  if (fd >= 0) {
    fdmap_put(fd, path);
    return fd;
  }
  return real_openat2(dirfd, path, how, size);
}

using fopen_fn = FILE* (*)(const char*, const char*);

static fopen_fn real_fopen_fn;

// libstdc++ 的 basic_file_stdio 走 fopen，所以写路径也必须放行，否则载荷写不了盘
static bool mode_is_read_only(const char* mode) {
  if (mode == nullptr) return false;
  bool write = strchr(mode, 'w') != nullptr || strchr(mode, 'a') != nullptr ||
               strchr(mode, '+') != nullptr;
  return !write;
}

FILE* fopen(const char* path, const char* mode) {
  if (!real_fopen_fn) real_fopen_fn = reinterpret_cast<fopen_fn>(dlsym(RTLD_NEXT, "fopen"));
  int fd = forge_fd(path);
  if (fd >= 0) {
    FILE* file = fdopen(fd, mode);
    if (file != nullptr) {
      fdmap_put(fd, path);
      return file;
    }
    close(fd);
  }
  return real_fopen_fn(path, mode);
}

FILE* freopen(const char* path, const char* mode, FILE* stream) {
  static FILE* (*real_freopen)(const char*, const char*, FILE*);
  if (!real_freopen) real_freopen = reinterpret_cast<decltype(real_freopen)>(dlsym(RTLD_NEXT, "freopen"));
  int fd = forge_fd(path);
  if (fd >= 0) {
    FILE* file = fdopen(fd, mode);
    if (file != nullptr) {
      fdmap_put(fd, path);
      return file;
    }
    close(fd);
  }
  return real_freopen(path, mode, stream);
}

int close(int fd) {
  static int (*real_close)(int);
  if (!real_close) real_close = reinterpret_cast<decltype(real_close)>(dlsym(RTLD_NEXT, "close"));
  fdmap_del(fd);
  return real_close(fd);
}

ssize_t readlink(const char* path, char* buf, size_t n) {
  static ssize_t (*real_readlink)(const char*, char*, size_t);
  if (!real_readlink) real_readlink = reinterpret_cast<decltype(real_readlink)>(dlsym(RTLD_NEXT, "readlink"));
  if (state().installed && contains(path, "/map_files/")) {
    const char* last = strrchr(path, '/');
    if (last != nullptr && hidden_map_range(last + 1)) {
      errno = ENOENT;
      return -1;
    }
  }
  if (starts_with(path, "/proc/self/fd/") || starts_with(path, "/proc/thread-self/fd/")) {
    const char* slash = strrchr(path, '/');
    if (slash != nullptr) {
      int fd = 0;
      const char* orig = parse_dec(slash + 1, &fd) ? fdmap_get(fd) : nullptr;
      if (orig != nullptr) {
        size_t l = strlen(orig);
        if (l > n) l = n;
        memcpy(buf, orig, l);
        return static_cast<ssize_t>(l);
      }
    }
  }
  return real_readlink(path, buf, n);
}

ssize_t readlinkat(int dirfd, const char* path, char* buf, size_t n) {
  static ssize_t (*real_readlinkat)(int, const char*, char*, size_t);
  if (!real_readlinkat) real_readlinkat = reinterpret_cast<decltype(real_readlinkat)>(dlsym(RTLD_NEXT, "readlinkat"));
  if (starts_with(path, "/proc/self/fd/")) {
    const char* slash = strrchr(path, '/');
    if (slash != nullptr) {
      int fd = 0;
      const char* orig = parse_dec(slash + 1, &fd) ? fdmap_get(fd) : nullptr;
      if (orig != nullptr) {
        size_t l = strlen(orig);
        if (l > n) l = n;
        memcpy(buf, orig, l);
        return static_cast<ssize_t>(l);
      }
    }
  }
  return real_readlinkat(dirfd, path, buf, n);
}

int stat(const char* path, struct stat* st) {
  static int (*real_stat)(const char*, struct stat*);
  if (!real_stat) real_stat = reinterpret_cast<decltype(real_stat)>(dlsym(RTLD_NEXT, "stat"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  int fd = forge_fd(path);
  if (fd >= 0) {
    int rc = fstat(fd, st);
    close(fd);
    return rc;
  }
  return real_stat(path, st);
}

int lstat(const char* path, struct stat* st) {
  static int (*real_lstat)(const char*, struct stat*);
  if (!real_lstat) real_lstat = reinterpret_cast<decltype(real_lstat)>(dlsym(RTLD_NEXT, "lstat"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  return real_lstat(path, st);
}

int fstatat(int dirfd, const char* path, struct stat* st, int flags) {
  static int (*real_fstatat)(int, const char*, struct stat*, int);
  if (!real_fstatat) real_fstatat = reinterpret_cast<decltype(real_fstatat)>(dlsym(RTLD_NEXT, "fstatat"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  return real_fstatat(dirfd, path, st, flags);
}

int statx(int dirfd, const char* path, int flags, unsigned int mask, struct statx* st) {
  static int (*real_statx)(int, const char*, int, unsigned int, struct statx*);
  if (!real_statx) real_statx = reinterpret_cast<decltype(real_statx)>(dlsym(RTLD_NEXT, "statx"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  return real_statx(dirfd, path, flags, mask, st);
}

int access(const char* path, int mode) {
  static int (*real_access)(const char*, int);
  if (!real_access) real_access = reinterpret_cast<decltype(real_access)>(dlsym(RTLD_NEXT, "access"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  return real_access(path, mode);
}

int faccessat(int dirfd, const char* path, int mode, int flags) {
  static int (*real_faccessat)(int, const char*, int, int);
  if (!real_faccessat) real_faccessat = reinterpret_cast<decltype(real_faccessat)>(dlsym(RTLD_NEXT, "faccessat"));
  if (state().installed && is_private_path(path)) {
    errno = ENOENT;
    return -1;
  }
  return real_faccessat(dirfd, path, mode, flags);
}

DIR* opendir(const char* path) {
  static DIR* (*real_opendir)(const char*);
  if (!real_opendir) real_opendir = reinterpret_cast<decltype(real_opendir)>(dlsym(RTLD_NEXT, "opendir"));
  DIR* dir = real_opendir(path);
  if (dir != nullptr) dirmap_put(dir, path);
  return dir;
}

struct dirent* readdir(DIR* dir) {
  static struct dirent* (*real_readdir)(DIR*);
  if (!real_readdir) real_readdir = reinterpret_cast<decltype(real_readdir)>(dlsym(RTLD_NEXT, "readdir"));
  const char* path = dirmap_path(dir);
  struct dirent* entry = nullptr;
  while ((entry = real_readdir(dir)) != nullptr)
    if (!hide_entry(path, entry->d_name)) return entry;
  return nullptr;
}

struct dirent64* readdir64(DIR* dir) {
  static struct dirent64* (*real_readdir64)(DIR*);
  if (!real_readdir64) real_readdir64 = reinterpret_cast<decltype(real_readdir64)>(dlsym(RTLD_NEXT, "readdir64"));
  const char* path = dirmap_path(dir);
  struct dirent64* entry = nullptr;
  while ((entry = real_readdir64(dir)) != nullptr)
    if (!hide_entry(path, entry->d_name)) return entry;
  return nullptr;
}

// libuv 的 fs.readdir 走 scandir，不经过 opendir/readdir
int scandir(const char* dir, struct dirent*** namelist,
            int (*filter)(const struct dirent*),
            int (*compar)(const struct dirent**, const struct dirent**)) {
  static int (*real_scandir)(const char*, struct dirent***,
                             int (*)(const struct dirent*),
                             int (*)(const struct dirent**, const struct dirent**));
  if (!real_scandir) real_scandir = reinterpret_cast<decltype(real_scandir)>(dlsym(RTLD_NEXT, "scandir"));
  int n = real_scandir(dir, namelist, filter, compar);
  if (n <= 0) return n;
  for (int i = n - 1; i >= 0; --i) {
    if (!hide_entry(dir, (*namelist)[i]->d_name)) continue;
    free((*namelist)[i]);
    for (int k = i; k < n - 1; ++k) (*namelist)[k] = (*namelist)[k + 1];
    --n;
    (*namelist)[n] = nullptr;
  }
  return n;
}

int scandir64(const char* dir, struct dirent64*** namelist,
              int (*filter)(const struct dirent64*),
              int (*compar)(const struct dirent64**, const struct dirent64**)) {
  static int (*real_scandir64)(const char*, struct dirent64***,
                               int (*)(const struct dirent64*),
                               int (*)(const struct dirent64**, const struct dirent64**));
  if (!real_scandir64) real_scandir64 = reinterpret_cast<decltype(real_scandir64)>(dlsym(RTLD_NEXT, "scandir64"));
  int n = real_scandir64(dir, namelist, filter, compar);
  if (n <= 0) return n;
  for (int i = n - 1; i >= 0; --i) {
    if (!hide_entry(dir, (const char*)(*namelist)[i]->d_name)) continue;
    free((*namelist)[i]);
    for (int k = i; k < n - 1; ++k) (*namelist)[k] = (*namelist)[k + 1];
    --n;
    (*namelist)[n] = nullptr;
  }
  return n;
}

static thread_local int (*g_iter_cb)(struct dl_phdr_info*, size_t, void*);
static thread_local void* g_iter_data;

static int iter_trampoline(struct dl_phdr_info* info, size_t sz, void*) {
  if (hidden_module(info->dlpi_name)) return 0;
  if (g_iter_cb == nullptr) return 0;   // 回调里再次调用 dl_iterate_phdr：直接跳过
  return g_iter_cb(info, sz, g_iter_data);
}

int dl_iterate_phdr(int (*cb)(struct dl_phdr_info*, size_t, void*), void* data) {
  static int (*real_iter)(int (*)(struct dl_phdr_info*, size_t, void*), void*);
  if (!real_iter) real_iter = reinterpret_cast<decltype(real_iter)>(
      dlvsym(RTLD_NEXT, "dl_iterate_phdr", "GLIBC_2.2.5"));
  if (!state().installed) return real_iter(cb, data);
  g_iter_cb = cb;
  g_iter_data = data;
  int rc = real_iter(iter_trampoline, nullptr);
  g_iter_cb = nullptr;
  g_iter_data = nullptr;
  return rc;
}

void* dlopen(const char* file, int flags) {
  static void* (*real_dlopen)(const char*, int);
  if (!real_dlopen) real_dlopen = reinterpret_cast<decltype(real_dlopen)>(dlsym(RTLD_NEXT, "dlopen"));
  if (state().installed && file != nullptr && (flags & RTLD_NOLOAD) != 0 &&
      hidden_line(file, strlen(file))) {
    dlerror();          // 清掉上一次的错误，再自己种一个
    return nullptr;
  }
  return real_dlopen(file, flags);
}

char* getenv(const char* name) {
  static char* (*real_getenv)(const char*);
  if (!real_getenv) real_getenv = reinterpret_cast<decltype(real_getenv)>(dlsym(RTLD_NEXT, "getenv"));
  if (!state().installed || name == nullptr) return real_getenv(name);
  if (strcmp(name, "LD_PRELOAD") == 0) return nullptr;
  if (starts_with(name, "OICQ_") || starts_with(name, "FORGE_")) {
    // 载荷自己要读配置：用返回地址判断调用者是不是本对象
    Dl_info info;
    if (dladdr(__builtin_return_address(0), &info) && info.dli_fname != nullptr &&
        hidden_module(info.dli_fname))
      return real_getenv(name);
    return nullptr;
  }
  return real_getenv(name);
}

char* secure_getenv(const char* name) { return getenv(name); }

#pragma GCC visibility pop

}  // extern "C"

// ------------------------------------------------------------------ 安装

namespace {

bool in_child_process() {
  int fd = static_cast<int>(rsys3(SYS_openat, AT_FDCWD,
                                  reinterpret_cast<long>("/proc/self/cmdline"),
                                  O_RDONLY | O_CLOEXEC));
  if (fd < 0) return false;
  char buf[4096];
  long n = rsys3(SYS_read, fd, reinterpret_cast<long>(buf), sizeof buf - 1);
  rsys3(SYS_close, fd, 0, 0);
  if (n <= 0) return false;
  buf[n] = '\0';
  for (long i = 0; i + 7 < n; ++i)
    if (memcmp(buf + i, "--type=", 7) == 0) return true;
  return false;
}

void parse_hide_list(const char* spec) {
  if (spec == nullptr) return;
  ShieldState& s = state();
  const char* p = spec;
  while (*p != '\0' && s.hide_count < 8) {
    const char* colon = strchr(p, ':');
    size_t len = colon != nullptr ? static_cast<size_t>(colon - p) : strlen(p);
    if (len > 0 && len < sizeof s.hide[0]) {
      memcpy(s.hide[s.hide_count], p, len);
      s.hide[s.hide_count][len] = '\0';
      ++s.hide_count;
    }
    if (colon == nullptr) break;
    p = colon + 1;
  }
}

// 解析 QQ 的 CompileFunction：用来在 smaps 里定位被 mprotect 写过的那一页。
// 主可执行文件的符号在全局作用域里，RLD_DEFAULT 一次即可；dlopen("qq") 只作兜底。
void resolve_target() {
  ShieldState& s = state();
  if (s.target_checked) return;
  s.target_checked = true;
  void* symbol = dlsym(RTLD_DEFAULT, oicq::kMangledCompileFunctionLinux);
  if (symbol == nullptr) {
    void* handle = dlopen("qq", RTLD_LAZY);
    if (handle != nullptr) symbol = dlsym(handle, oicq::kMangledCompileFunctionLinux);
  }
  s.target = symbol;
}

}  // namespace

// 构造优先级 101：早于 oicq 自己的 autostart，保证它在读 OICQ_* 之前
// 拦截层已经就位（getenv 会按调用者放行）。
__attribute__((constructor(101))) static void install_observation_shield() {
  ShieldState& s = state();
  if (s.installed) return;
  if (in_child_process()) {
    s.child = true;
    return;
  }
  Dl_info info;
  if (dladdr(reinterpret_cast<void*>(&install_observation_shield), &info) &&
      info.dli_fname != nullptr) {
    const char* base = strrchr(info.dli_fname, '/');
    snprintf(s.self_base, sizeof s.self_base, "%s", base != nullptr ? base + 1 : info.dli_fname);
  } else {
    snprintf(s.self_base, sizeof s.self_base, "oicq.so");
  }
  // 读配置必须走真实 getenv：此时本对象的 getenv 还没生效，但保持显式
  static char* (*real_getenv)(const char*);
  if (real_getenv == nullptr) real_getenv = reinterpret_cast<decltype(real_getenv)>(dlsym(RTLD_NEXT, "getenv"));
  const char* toggle = real_getenv("OICQ_SHIELD");
  if (toggle != nullptr && strcmp(toggle, "0") == 0) return;
  parse_hide_list(real_getenv("OICQ_SHIELD_HIDE"));
  if (real_getenv("OICQ_SHIELD_DEBUG") != nullptr)
    fprintf(stderr, "[oicq/shield] self_base=%s hide_count=%d\n", s.self_base, s.hide_count);
  s.installed = true;
  if (s.target == nullptr) resolve_target();
}
