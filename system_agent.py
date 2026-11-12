#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OS Agent (System Telemetry Daemon)
Đọc số liệu thật của hệ điều hành cho trang Giám sát hệ thống:
- CPU: % sử dụng của cả máy (psutil so thời gian CPU bận và rảnh giữa hai lần đo)
- RAM: bộ nhớ vật lý đang dùng / tổng cộng
- Ổ đĩa: dung lượng ổ hệ thống, tốc độ đọc ghi và độ trễ trung bình mỗi lần đọc ghi
  lấy từ bộ đếm I/O của hệ điều hành, loại ổ (SSD/HDD, NVMe/SATA)
- Mạng: tốc độ tải xuống / tải lên của card mạng chính, ping TCP tới máy chủ Gemini
- GPU: bộ đếm hiệu năng "GPU Engine" của Windows (Task Manager cũng dùng),
  không đọc được thì dùng nvidia-smi nếu có card NVIDIA
- Đo tốc độ ổ đĩa: đọc ghi thẳng xuống ổ, không qua bộ đệm (cache) của hệ điều hành
Cung cấp REST API tại http://127.0.0.1:5001/api/metrics cho giao diện Web.
"""

import base64
import json
import mmap
import os
import random
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

try:
    import psutil
except ImportError:
    print("[LỖI] Thiếu thư viện 'psutil'. Vui lòng chạy lệnh: pip install -r requirements.txt")
    sys.exit(1)

PORT = 5001
HOST = "127.0.0.1"
INTERVAL = 1.0          # chu kỳ đo (giây)
GEMINI_HOST = "generativelanguage.googleapis.com"

IS_WINDOWS = os.name == "nt"
IS_LINUX = sys.platform.startswith("linux")
MB = 1024 * 1024
GB = 1024 * MB
CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SYSTEM_DRIVE = (os.environ.get("SystemDrive", "C:") + "\\") if IS_WINDOWS else "/"
# Card mạng ảo, VPN hoặc loopback, không chọn làm card chính
VIRTUAL_NIC_WORDS = ("loopback", "virtual", "vethernet", "vmware", "virtualbox", "vbox",
                     "hyper-v", "docker", "veth", "virbr", "br-", "pseudo", "teredo",
                     "isatap", "bluetooth", "tailscale", "zerotier", "wsl")

# None nghĩa là chưa đo được, giao diện sẽ hiện "--" thay vì một con số đặt sẵn
system_metrics = {
    "connected": True,
    "timestamp": None,
    # CPU
    "cpuPercent": None,
    "cpuCoresLogical": psutil.cpu_count(logical=True),
    "cpuCoresPhysical": psutil.cpu_count(logical=False),
    # RAM
    "ramUsedMb": None,
    "ramTotalMb": None,
    "ramFreeMb": None,
    "ramPercent": None,
    "ramTotalGb": None,
    # Dung lượng ổ hệ thống
    "diskDrive": SYSTEM_DRIVE.rstrip("\\"),
    "diskTotalGb": None,
    "diskUsedGb": None,
    "diskFreeGb": None,
    "diskUsagePercent": None,
    "diskTotalMb": None,
    "diskUsedMb": None,
    # Đọc ghi ổ đĩa của cả máy
    "diskReadSpeedMb": None,
    "diskWriteSpeedMb": None,
    "diskLatencyMs": None,          # độ trễ trung bình mỗi lần đọc ghi, None khi không có đọc ghi
    "diskBenchmarkReadMb": None,    # kết quả lần đo tốc độ gần nhất
    "diskType": None,
    # Mạng
    "netInterface": None,
    "netLinkMbps": None,
    "netDownlinkMbps": None,
    "netUplinkMbps": None,
    "netTotalRecvMb": None,
    "netTotalSentMb": None,
    "netRttMs": None,
    "netRttOk": None,
    "netRttError": "",
    # GPU
    "gpuPercent": None,
    "gpuSource": None,
    "gpuEngine": "",
    "gpuError": "Đang tìm nguồn đọc mức dùng GPU",
}
metrics_lock = threading.Lock()
children = []           # tiến trình PowerShell đọc GPU, tắt khi agent dừng


def update_metrics(**fields):
    with metrics_lock:
        system_metrics.update(fields)


def read_metrics():
    with metrics_lock:
        return dict(system_metrics)


# ---------------------------------------------------------------- loại ổ đĩa

def powershell_args(script):
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    return ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-EncodedCommand", encoded]


PS_DISK = r"""
$ErrorActionPreference = 'SilentlyContinue'
$letter = $env:SystemDrive.TrimEnd(':')
$num = (Get-Partition -DriveLetter $letter).DiskNumber
$disk = Get-PhysicalDisk | Where-Object { "$($_.DeviceId)" -eq "$num" } | Select-Object -First 1
if (-not $disk) { $disk = Get-PhysicalDisk | Select-Object -First 1 }
if ($disk) { "$($disk.MediaType)|$($disk.BusType)" }
"""
# PowerShell thường in tên, phòng khi in mã số thì đổi lại
MEDIA_CODES = {"0": "", "3": "HDD", "4": "SSD", "5": "SCM", "unspecified": "", "unknown": ""}
BUS_CODES = {"17": "NVMe", "11": "SATA", "7": "USB", "8": "RAID", "10": "SAS", "3": "ATA",
             "1": "SCSI", "12": "SD", "13": "MMC", "0": "", "unknown": ""}


def detect_disk_type():
    """Loại ổ chứa hệ điều hành, ví dụ 'SSD NVMe' hoặc 'HDD SATA'."""
    media = bus = ""
    if IS_WINDOWS:
        out = subprocess.run(powershell_args(PS_DISK), capture_output=True, text=True,
                             encoding="utf-8", errors="replace", timeout=30,
                             stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW).stdout
        lines = [l for l in out.splitlines() if "|" in l]
        if lines:
            media, bus = (part.strip() for part in lines[-1].split("|")[:2])
            media = MEDIA_CODES.get(media.lower(), media)
            bus = BUS_CODES.get(bus.lower(), bus)
    elif IS_LINUX:
        st = os.stat("/")
        path = os.path.realpath(f"/sys/dev/block/{os.major(st.st_dev)}:{os.minor(st.st_dev)}")
        for _ in range(3):                  # đi qua LVM hoặc ổ mã hóa tới phân vùng thật
            slaves = os.path.join(path, "slaves")
            if os.path.isdir(slaves) and os.listdir(slaves):
                path = os.path.realpath(os.path.join(slaves, sorted(os.listdir(slaves))[0]))
            else:
                break
        if os.path.exists(os.path.join(path, "partition")):
            path = os.path.dirname(path)    # từ phân vùng lên ổ đĩa chứa nó
        try:
            with open(os.path.join(path, "queue", "rotational")) as f:
                media = {"1": "HDD", "0": "SSD"}.get(f.read().strip(), "")
        except OSError:
            pass
        dev = os.path.basename(path)
        bus = "NVMe" if dev.startswith("nvme") else ("USB" if "/usb" in path else
                                                    ("SATA" if dev.startswith("sd") else ""))
    return " ".join(x for x in (media, bus) if x) or None


def disk_type_worker():
    try:
        disk_type = detect_disk_type()
    except Exception as e:
        print(f"[CẢNH BÁO] Không đọc được loại ổ đĩa: {e}", flush=True)
        return
    update_metrics(diskType=disk_type or "Chưa rõ loại ổ")
    if disk_type:
        print(f"[OK] Ổ hệ thống: {disk_type}", flush=True)


# ---------------------------------------------------------------- đo tốc độ ổ đĩa

BENCH_SIZE = 64 * MB        # file đo
BENCH_CHUNK = MB            # mỗi lần đọc ghi tuần tự 1 MB
BENCH_BLOCK = 4096          # mỗi lần đọc ngẫu nhiên 4 KB
bench_lock = threading.Lock()


def _random_read_latency(read_block):
    """Đọc ngẫu nhiên các khối 4 KB tối đa 1,5 giây, trả về độ trễ trung bình (ms)."""
    blocks = BENCH_SIZE // BENCH_BLOCK
    times = []
    deadline = time.perf_counter() + 1.5
    while len(times) < 2000 and time.perf_counter() < deadline:
        offset = random.randrange(blocks) * BENCH_BLOCK
        t0 = time.perf_counter()
        read_block(offset)
        times.append(time.perf_counter() - t0)
    return sum(times) / len(times) * 1000


def _bench_linux(path):
    buf = mmap.mmap(-1, BENCH_CHUNK)        # vùng nhớ căn theo trang, đúng yêu cầu của O_DIRECT
    buf.write(os.urandom(BENCH_CHUNK))
    view = memoryview(buf)
    small = view[:BENCH_BLOCK]
    fd = None
    try:
        # O_DIRECT: bỏ qua page cache, đọc ghi thẳng xuống ổ
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_DIRECT, 0o600)
        t0 = time.perf_counter()
        for off in range(0, BENCH_SIZE, BENCH_CHUNK):
            os.pwrite(fd, view, off)
        os.fsync(fd)
        write_s = time.perf_counter() - t0
        t0 = time.perf_counter()
        for off in range(0, BENCH_SIZE, BENCH_CHUNK):
            os.preadv(fd, [view], off)
        read_s = time.perf_counter() - t0
        latency = _random_read_latency(lambda off: os.preadv(fd, [small], off))
    finally:
        if fd is not None:
            os.close(fd)
        small.release()
        view.release()
        buf.close()
    return write_s, read_s, latency


def _bench_windows(path):
    import ctypes
    from ctypes import wintypes

    k32 = ctypes.WinDLL("kernel32", use_last_error=True)
    k32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID,
                                wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    k32.CreateFileW.restype = wintypes.HANDLE
    k32.ReadFile.argtypes = [wintypes.HANDLE, wintypes.LPVOID, wintypes.DWORD,
                             ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    k32.ReadFile.restype = wintypes.BOOL
    k32.WriteFile.argtypes = [wintypes.HANDLE, wintypes.LPCVOID, wintypes.DWORD,
                              ctypes.POINTER(wintypes.DWORD), wintypes.LPVOID]
    k32.WriteFile.restype = wintypes.BOOL
    k32.SetFilePointerEx.argtypes = [wintypes.HANDLE, ctypes.c_longlong,
                                     ctypes.POINTER(ctypes.c_longlong), wintypes.DWORD]
    k32.SetFilePointerEx.restype = wintypes.BOOL
    k32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    k32.FlushFileBuffers.restype = wintypes.BOOL
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    k32.CloseHandle.restype = wintypes.BOOL
    k32.VirtualAlloc.argtypes = [wintypes.LPVOID, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
    k32.VirtualAlloc.restype = wintypes.LPVOID
    k32.VirtualFree.argtypes = [wintypes.LPVOID, ctypes.c_size_t, wintypes.DWORD]
    k32.VirtualFree.restype = wintypes.BOOL

    GENERIC_READ, GENERIC_WRITE = 0x80000000, 0x40000000
    CREATE_ALWAYS, FILE_BEGIN = 2, 0
    FILE_ATTRIBUTE_NORMAL = 0x80
    FILE_FLAG_NO_BUFFERING = 0x20000000     # bỏ qua bộ đệm của Windows, đọc ghi thẳng xuống ổ
    MEM_COMMIT_RESERVE, MEM_RELEASE, PAGE_READWRITE = 0x3000, 0x8000, 0x04
    INVALID_HANDLE = wintypes.HANDLE(-1).value

    def check(ok):
        if not ok:
            raise ctypes.WinError(ctypes.get_last_error())

    # FILE_FLAG_NO_BUFFERING bắt buộc vùng nhớ, kích thước và vị trí đọc ghi chia hết cho
    # kích thước sector. VirtualAlloc trả vùng nhớ căn theo 64 KB nên luôn đạt.
    buf = k32.VirtualAlloc(None, BENCH_CHUNK, MEM_COMMIT_RESERVE, PAGE_READWRITE)
    if not buf:
        raise ctypes.WinError(ctypes.get_last_error())
    ctypes.memmove(buf, os.urandom(BENCH_CHUNK), BENCH_CHUNK)
    handle = k32.CreateFileW(path, GENERIC_READ | GENERIC_WRITE, 0, None, CREATE_ALWAYS,
                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_NO_BUFFERING, None)
    if handle is None or handle == INVALID_HANDLE:
        err = ctypes.get_last_error()
        k32.VirtualFree(buf, 0, MEM_RELEASE)
        raise ctypes.WinError(err)
    done = wintypes.DWORD(0)
    try:
        t0 = time.perf_counter()
        for _ in range(BENCH_SIZE // BENCH_CHUNK):
            check(k32.WriteFile(handle, buf, BENCH_CHUNK, ctypes.byref(done), None))
        check(k32.FlushFileBuffers(handle))
        write_s = time.perf_counter() - t0

        check(k32.SetFilePointerEx(handle, 0, None, FILE_BEGIN))
        t0 = time.perf_counter()
        for _ in range(BENCH_SIZE // BENCH_CHUNK):
            check(k32.ReadFile(handle, buf, BENCH_CHUNK, ctypes.byref(done), None))
        read_s = time.perf_counter() - t0

        def read_block(offset):
            check(k32.SetFilePointerEx(handle, offset, None, FILE_BEGIN))
            check(k32.ReadFile(handle, buf, BENCH_BLOCK, ctypes.byref(done), None))

        latency = _random_read_latency(read_block)
    finally:
        k32.CloseHandle(handle)
        k32.VirtualFree(buf, 0, MEM_RELEASE)
    return write_s, read_s, latency


def benchmark_disk_real():
    """Đo tốc độ đọc ghi thật của ổ chứa thư mục tạm.
    Bản cũ ghi file rồi đọc lại ngay, lúc đó dữ liệu còn nằm trong RAM (cache của hệ điều hành)
    nên số đo là tốc độ RAM. Bản này mở file ở chế độ không qua cache."""
    path = os.path.join(tempfile.gettempdir(), f"io_bench_{os.getpid()}.bin")
    try:
        if IS_WINDOWS:
            write_s, read_s, latency = _bench_windows(path)
        elif IS_LINUX and hasattr(os, "O_DIRECT"):
            write_s, read_s, latency = _bench_linux(path)
        else:
            raise OSError("hệ điều hành này chưa hỗ trợ đo không qua cache")
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    size_mb = BENCH_SIZE / MB
    return round(size_mb / read_s, 1), round(size_mb / write_s, 1), round(latency, 3)


# ---------------------------------------------------------------- GPU

# Mỗi engine (3D, Video Decode, Copy...) của mỗi card: cộng mức dùng của mọi tiến trình,
# rồi lấy engine bận nhất. Task Manager cũng tính mức dùng GPU theo cách này.
PS_GPU = r"""
$ErrorActionPreference = 'SilentlyContinue'
while ($true) {
  $samples = @((Get-Counter -Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 1 -MaxSamples 1).CounterSamples)
  $engines = @{}
  foreach ($s in $samples) {
    if ($null -eq $s) { continue }
    if ($s.InstanceName -match 'luid_(0x[0-9a-f]+_0x[0-9a-f]+)_phys_(\d+)_eng_(\d+)_engtype_(.*)$') {
      $key = $Matches[1] + '|' + $Matches[2] + '|' + $Matches[3] + '|' + $Matches[4]
      $engines[$key] = [double]$engines[$key] + [double]$s.CookedValue
    }
  }
  $bestValue = 0.0
  $bestEngine = ''
  foreach ($key in $engines.Keys) {
    if ($engines[$key] -gt $bestValue) {
      $bestValue = $engines[$key]
      $bestEngine = $key.Split('|')[3]
    }
  }
  $result = [ordered]@{
    ok = ($engines.Count -gt 0)
    percent = [math]::Round([math]::Min($bestValue, 100.0), 1)
    engine = $bestEngine
  }
  try {
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
  } catch {
    exit
  }
}
"""


def gpu_from_windows_counters():
    """Chạy một tiến trình PowerShell lâu dài, mỗi giây in một dòng JSON.
    Trả về False nếu bộ đếm không dùng được, để chuyển sang nvidia-smi."""
    worked = False
    for _ in range(5):
        try:
            proc = subprocess.Popen(powershell_args(PS_GPU), stdout=subprocess.PIPE,
                                    stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL,
                                    text=True, encoding="utf-8", errors="replace",
                                    creationflags=CREATE_NO_WINDOW)
        except OSError as e:
            print(f"[CẢNH BÁO] Không chạy được PowerShell để đọc GPU: {e}", flush=True)
            return worked
        children.append(proc)
        bad = 0
        for line in proc.stdout:
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if data.get("ok"):
                if not worked:
                    print("[OK] Đọc mức dùng GPU từ bộ đếm hiệu năng của Windows", flush=True)
                worked, bad = True, 0
                update_metrics(gpuPercent=data.get("percent"), gpuSource="windows-counters",
                               gpuEngine=data.get("engine") or "", gpuError="")
            else:
                bad += 1
                if not worked and bad >= 3:
                    proc.kill()
                    return False
                update_metrics(gpuPercent=None, gpuError="Bộ đếm GPU tạm thời không có số liệu")
        proc.wait()
        if not worked:
            return False
        time.sleep(3)                       # PowerShell bị tắt ngang thì chạy lại
    update_metrics(gpuPercent=None, gpuError="Mất kết nối với bộ đếm GPU của Windows")
    return True


def gpu_from_nvidia_smi():
    cmd = ["nvidia-smi", "--query-gpu=utilization.gpu", "--format=csv,noheader,nounits"]
    announced = False
    while True:
        try:
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=10,
                                 stdin=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW).stdout
            values = [float(x) for x in out.split() if x.replace(".", "", 1).isdigit()]
            if not values:
                raise RuntimeError("nvidia-smi không trả số liệu")
            update_metrics(gpuPercent=max(values), gpuSource="nvidia-smi", gpuEngine="", gpuError="")
            if not announced:
                print("[OK] Đọc mức dùng GPU bằng nvidia-smi", flush=True)
                announced = True
        except Exception as e:
            update_metrics(gpuPercent=None, gpuSource="nvidia-smi", gpuError=f"nvidia-smi lỗi: {e}")
        time.sleep(5)       # gọi thưa để card rời trên laptop còn được nghỉ


def gpu_worker():
    if IS_WINDOWS and gpu_from_windows_counters():
        return
    if shutil.which("nvidia-smi"):
        gpu_from_nvidia_smi()
        return
    if IS_WINDOWS:
        msg = "Không đọc được bộ đếm GPU của Windows (tên bộ đếm đổi khi Windows không dùng tiếng Anh)"
    else:
        msg = "Máy này không có công cụ đọc mức dùng GPU (hiện hỗ trợ card NVIDIA qua nvidia-smi)"
    update_metrics(gpuPercent=None, gpuSource=None, gpuError=msg)
    print("[CẢNH BÁO] " + msg, flush=True)


# ---------------------------------------------------------------- ping tới máy chủ Gemini

def rtt_worker():
    """Đo thời gian bắt tay TCP tới cổng 443 của máy chủ Gemini, 10 giây một lần."""
    while True:
        try:
            addr = socket.getaddrinfo(GEMINI_HOST, 443, type=socket.SOCK_STREAM)[0][4]
            t0 = time.perf_counter()
            with socket.create_connection(addr[:2], timeout=4):
                rtt = round((time.perf_counter() - t0) * 1000, 1)
            update_metrics(netRttMs=rtt, netRttOk=True, netRttError="")
        except socket.gaierror:
            update_metrics(netRttMs=None, netRttOk=False,
                           netRttError="Không phân giải được tên miền máy chủ Gemini")
        except OSError:
            update_metrics(netRttMs=None, netRttOk=False,
                           netRttError="Không mở được kết nối tới máy chủ Gemini")
        time.sleep(10)


# ---------------------------------------------------------------- vòng đo định kỳ

def rate(cur, old, field, dt):
    """Hiệu số của bộ đếm cộng dồn chia cho thời gian, ra tốc độ mỗi giây."""
    return max(0, getattr(cur, field) - getattr(old, field)) / dt


def is_virtual_nic(name):
    low = name.lower()
    return low == "lo" or any(word in low for word in VIRTUAL_NIC_WORDS)


def telemetry_background_worker():
    """Vòng lặp ngầm đo mỗi giây để API trả lời ngay, không phải chờ đo"""
    psutil.cpu_percent(interval=None)       # lần gọi đầu luôn ra 0, gọi mồi trước
    last_time = time.monotonic()
    last_disk = psutil.disk_io_counters()
    last_net = psutil.net_io_counters(pernic=True)
    warned = set()

    while True:
        time.sleep(INTERVAL)
        try:
            now = time.monotonic()
            dt = max(0.001, now - last_time)
            last_time = now
            fields = {}

            # 1. CPU của cả máy
            fields["cpuPercent"] = psutil.cpu_percent(interval=None)

            # 2. RAM vật lý
            vm = psutil.virtual_memory()
            used = vm.total - vm.available
            fields.update(
                ramUsedMb=round(used / MB),
                ramTotalMb=round(vm.total / MB),
                ramFreeMb=round(vm.available / MB),
                ramPercent=round(used * 100 / vm.total, 1),
                ramTotalGb=round(vm.total / GB, 1),
            )

            # 3. Dung lượng ổ hệ thống
            du = psutil.disk_usage(SYSTEM_DRIVE)
            fields.update(
                diskTotalGb=round(du.total / GB, 1),
                diskUsedGb=round(du.used / GB, 1),
                diskFreeGb=round(du.free / GB, 1),
                diskUsagePercent=round(du.percent, 1),
                diskTotalMb=round(du.total / MB),
                diskUsedMb=round(du.used / MB),
            )

            # 4. Đọc ghi ổ đĩa: bộ đếm I/O vật lý của hệ điều hành, lúc rảnh thì đúng là gần 0
            cur_disk = psutil.disk_io_counters()
            if cur_disk and last_disk:
                ios = (cur_disk.read_count - last_disk.read_count) + (cur_disk.write_count - last_disk.write_count)
                io_ms = (cur_disk.read_time - last_disk.read_time) + (cur_disk.write_time - last_disk.write_time)
                fields.update(
                    diskReadSpeedMb=round(rate(cur_disk, last_disk, "read_bytes", dt) / MB, 2),
                    diskWriteSpeedMb=round(rate(cur_disk, last_disk, "write_bytes", dt) / MB, 2),
                    diskLatencyMs=round(io_ms / ios, 2) if ios > 0 and io_ms >= 0 else None,
                )
            last_disk = cur_disk

            # 5. Mạng: card chính là card có nhiều dữ liệu đi qua nhất từ lúc bật máy
            cur_net = psutil.net_io_counters(pernic=True)
            stats = psutil.net_if_stats()
            nics = [k for k in cur_net if k in last_net and not is_virtual_nic(k)
                    and (k not in stats or stats[k].isup)]
            if nics:
                main = max(nics, key=lambda k: cur_net[k].bytes_recv + cur_net[k].bytes_sent)
                fields.update(
                    netInterface=main,
                    netLinkMbps=(stats[main].speed if main in stats else 0) or None,
                    netDownlinkMbps=round(rate(cur_net[main], last_net[main], "bytes_recv", dt) * 8 / 1e6, 2),
                    netUplinkMbps=round(rate(cur_net[main], last_net[main], "bytes_sent", dt) * 8 / 1e6, 2),
                    netTotalRecvMb=round(cur_net[main].bytes_recv / MB, 1),
                    netTotalSentMb=round(cur_net[main].bytes_sent / MB, 1),
                )
            last_net = cur_net

            fields["timestamp"] = time.time()
            update_metrics(**fields)
        except Exception as e:
            # in lỗi ra một lần, không nuốt im lặng
            if repr(e) not in warned:
                warned.add(repr(e))
                print(f"[CẢNH BÁO] Lỗi khi đo: {e!r}", flush=True)


class MetricsHandler(BaseHTTPRequestHandler):
    def _set_headers(self, status=200):
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.end_headers()

    def _send_json(self, status, payload):
        self._set_headers(status)
        self.wfile.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_OPTIONS(self):
        self._set_headers(204)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/metrics":
            self._send_json(200, read_metrics())
        elif path == "/api/benchmark-disk":
            if not bench_lock.acquire(blocking=False):
                self._send_json(409, {"ok": False, "message": "Đang đo, đợi lần đo trước xong."})
                return
            try:
                print(f"[*] Đang đo ổ đĩa: ghi rồi đọc {BENCH_SIZE // MB} MB không qua cache...", flush=True)
                r, w, seek = benchmark_disk_real()
                update_metrics(diskBenchmarkReadMb=r)
                print(f"[OK] Đọc {r} MB/s, ghi {w} MB/s, đọc ngẫu nhiên 4 KB {seek} ms", flush=True)
                self._send_json(200, {
                    "ok": True,
                    "readSpeedMb": r,
                    "writeSpeedMb": w,
                    "seekMs": seek,
                    "message": f"Đo thực tế thành công: Đọc {r} MB/s, Ghi {w} MB/s",
                })
            except Exception as e:
                self._send_json(500, {"ok": False, "message": f"Lỗi khi đo ổ đĩa: {e}"})
            finally:
                bench_lock.release()
        elif path == "/":
            self._send_json(200, {
                "service": "OS Telemetry Agent",
                "status": "running",
                "port": PORT,
                "endpoints": ["/api/metrics", "/api/benchmark-disk"],
            })
        else:
            self._send_json(404, {"error": "Not Found"})

    def log_message(self, format, *args):
        return


def stop_children():
    for proc in children:
        try:
            if proc.poll() is None:
                proc.terminate()
        except Exception:
            pass


def run_server():
    print("=" * 60)
    print("   HỆ ĐIỀU HÀNH - OS TELEMETRY AGENT")
    print("   Đọc số liệu thật của hệ điều hành qua psutil")
    print("=" * 60)
    print("[*] Đang khởi tạo các luồng đo ngầm...")

    try:
        # ThreadingHTTPServer: lúc đang đo ổ đĩa vẫn trả số liệu cho trang được
        httpd = ThreadingHTTPServer((HOST, PORT), MetricsHandler)
    except OSError as e:
        print(f"[LỖI] Không mở được cổng {PORT}: {e}. Có thể agent đang chạy ở cửa sổ khác.")
        return
    httpd.daemon_threads = True
    for target in (telemetry_background_worker, gpu_worker, rtt_worker, disk_type_worker):
        threading.Thread(target=target, daemon=True).start()

    print(f"[OK] OS Agent đã chạy tại: http://{HOST}:{PORT}")
    print(f"[OK] API cung cấp số liệu: http://{HOST}:{PORT}/api/metrics")
    print("[*] Nhấn Ctrl + C để dừng agent khi không sử dụng.\n", flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[!] Đang tắt OS Agent...")
    finally:
        httpd.server_close()
        stop_children()
        print("[OK] Đã dừng an toàn.")


if __name__ == "__main__":
    run_server()
