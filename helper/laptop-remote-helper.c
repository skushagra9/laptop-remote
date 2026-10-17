// laptop-remote-helper: the only part of laptop-remote that runs as root.
//
// It accepts a fixed set of verbs and never takes an arbitrary SMC key or
// value from the caller, so granting it passwordless sudo exposes exactly
// these actions and nothing else:
//
//   status                     print JSON with the charging switch state
//   charging on|off            allow or inhibit battery charging
//   lid-sleep allow|prevent    let the Mac sleep, or keep it awake with the lid closed
//
// Charging is controlled through the SMC. Current Apple Silicon firmware
// (macOS 26+) exposes CHTE; older firmware exposes CH0B/CH0C. The helper
// probes for whichever exists.

#include <IOKit/IOKitLib.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

#define KERNEL_INDEX_SMC 2
#define SMC_CMD_READ_BYTES 5
#define SMC_CMD_WRITE_BYTES 6
#define SMC_CMD_READ_KEYINFO 9

// Must match the AppleSMC user client ABI byte for byte.
typedef struct {
  char major;
  char minor;
  char build;
  char reserved[1];
  UInt16 release;
} SMCVersion;

typedef struct {
  UInt16 version;
  UInt16 length;
  UInt32 cpuPLimit;
  UInt32 gpuPLimit;
  UInt32 memPLimit;
} SMCPLimitData;

typedef struct {
  UInt32 dataSize;
  UInt32 dataType;
  char dataAttributes;
} SMCKeyInfo;

typedef struct {
  UInt32 key;
  SMCVersion vers;
  SMCPLimitData pLimitData;
  SMCKeyInfo keyInfo;
  char result;
  char status;
  char data8;
  UInt32 data32;
  unsigned char bytes[32];
} SMCKeyData;

static io_connect_t conn;

static UInt32 fourcc(const char *key) {
  return ((UInt32)key[0] << 24) | ((UInt32)key[1] << 16) | ((UInt32)key[2] << 8) | (UInt32)key[3];
}

static int smc_open(void) {
  io_service_t service = IOServiceGetMatchingService(kIOMainPortDefault, IOServiceMatching("AppleSMC"));
  if (!service) return -1;
  kern_return_t kr = IOServiceOpen(service, mach_task_self(), 0, &conn);
  IOObjectRelease(service);
  return kr == kIOReturnSuccess ? 0 : -1;
}

static int smc_call(SMCKeyData *in, SMCKeyData *out) {
  size_t out_size = sizeof(SMCKeyData);
  kern_return_t kr = IOConnectCallStructMethod(conn, KERNEL_INDEX_SMC, in, sizeof(SMCKeyData), out, &out_size);
  return (kr == kIOReturnSuccess && out->result == 0) ? 0 : -1;
}

static int smc_key_info(const char *key, SMCKeyInfo *info) {
  SMCKeyData in = {0}, out = {0};
  in.key = fourcc(key);
  in.data8 = SMC_CMD_READ_KEYINFO;
  if (smc_call(&in, &out) != 0) return -1;
  *info = out.keyInfo;
  return 0;
}

static int smc_read(const char *key, unsigned char *bytes, UInt32 *size) {
  SMCKeyInfo info;
  if (smc_key_info(key, &info) != 0) return -1;
  SMCKeyData in = {0}, out = {0};
  in.key = fourcc(key);
  in.keyInfo.dataSize = info.dataSize;
  in.data8 = SMC_CMD_READ_BYTES;
  if (smc_call(&in, &out) != 0) return -1;
  memcpy(bytes, out.bytes, info.dataSize);
  *size = info.dataSize;
  return 0;
}

static int smc_write(const char *key, const unsigned char *bytes, UInt32 size) {
  SMCKeyInfo info;
  if (smc_key_info(key, &info) != 0 || info.dataSize != size) return -1;
  SMCKeyData in = {0}, out = {0};
  in.key = fourcc(key);
  in.keyInfo.dataSize = size;
  in.data8 = SMC_CMD_WRITE_BYTES;
  memcpy(in.bytes, bytes, size);
  return smc_call(&in, &out);
}

static int key_exists(const char *key) {
  SMCKeyInfo info;
  return smc_key_info(key, &info) == 0;
}

typedef enum { BACKEND_NONE, BACKEND_CHTE, BACKEND_CH0B } Backend;

static Backend detect_backend(void) {
  if (key_exists("CHTE")) return BACKEND_CHTE;
  if (key_exists("CH0B") && key_exists("CH0C")) return BACKEND_CH0B;
  return BACKEND_NONE;
}

static const char *backend_name(Backend b) {
  switch (b) {
    case BACKEND_CHTE: return "CHTE";
    case BACKEND_CH0B: return "CH0B";
    default: return "none";
  }
}

// Returns 1 when charging is inhibited, 0 when allowed, -1 when unknown.
static int charging_inhibited(Backend b) {
  unsigned char bytes[32];
  UInt32 size;
  if (b == BACKEND_CHTE) {
    if (smc_read("CHTE", bytes, &size) != 0 || size < 1) return -1;
    return bytes[0] != 0;
  }
  if (b == BACKEND_CH0B) {
    if (smc_read("CH0B", bytes, &size) != 0 || size < 1) return -1;
    return bytes[0] != 0;
  }
  return -1;
}

static int set_charging(Backend b, int enable) {
  if (b == BACKEND_CHTE) {
    unsigned char v[4] = {enable ? 0x00 : 0x01, 0, 0, 0};
    return smc_write("CHTE", v, 4);
  }
  if (b == BACKEND_CH0B) {
    unsigned char v = enable ? 0x00 : 0x02;
    if (smc_write("CH0B", &v, 1) != 0) return -1;
    return smc_write("CH0C", &v, 1);
  }
  return -1;
}

static int run_pmset_disablesleep(int disable) {
  pid_t pid = fork();
  if (pid < 0) return -1;
  if (pid == 0) {
    char *argv[] = {"/usr/bin/pmset", "-a", "disablesleep", disable ? "1" : "0", NULL};
    char *envp[] = {"PATH=/usr/bin:/bin:/usr/sbin:/sbin", NULL};
    execve(argv[0], argv, envp);
    _exit(127);
  }
  int status;
  if (waitpid(pid, &status, 0) < 0) return -1;
  return (WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : -1;
}

static int usage(void) {
  fprintf(stderr, "usage: laptop-remote-helper status | charging on|off | lid-sleep allow|prevent\n");
  return 2;
}

int main(int argc, char **argv) {
  if (argc < 2) return usage();

  if (strcmp(argv[1], "lid-sleep") == 0 && argc == 3) {
    int prevent;
    if (strcmp(argv[2], "prevent") == 0) prevent = 1;
    else if (strcmp(argv[2], "allow") == 0) prevent = 0;
    else return usage();
    if (run_pmset_disablesleep(prevent) != 0) {
      fprintf(stderr, "pmset failed (are you root?)\n");
      return 1;
    }
    return 0;
  }

  if (smc_open() != 0) {
    fprintf(stderr, "cannot open AppleSMC\n");
    return 1;
  }
  Backend b = detect_backend();
  int rc = 0;

  if (strcmp(argv[1], "status") == 0 && argc == 2) {
    int inhibited = charging_inhibited(b);
    printf("{\"backend\":\"%s\",\"chargingInhibited\":%s}\n", backend_name(b),
           inhibited < 0 ? "null" : (inhibited ? "true" : "false"));
  } else if (strcmp(argv[1], "charging") == 0 && argc == 3) {
    int enable;
    if (strcmp(argv[2], "on") == 0) enable = 1;
    else if (strcmp(argv[2], "off") == 0) enable = 0;
    else rc = usage();
    if (rc == 0) {
      if (b == BACKEND_NONE) {
        fprintf(stderr, "no supported charging key on this Mac\n");
        rc = 1;
      } else if (set_charging(b, enable) != 0) {
        fprintf(stderr, "SMC write failed (are you root?)\n");
        rc = 1;
      }
    }
  } else {
    rc = usage();
  }

  IOServiceClose(conn);
  return rc;
}
