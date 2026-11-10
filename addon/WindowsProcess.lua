-- Hidden, non-elevating process creation. SimpleGraphic's SpawnProcess uses
-- a visible shell launch with an elevation retry; backend startup must not.
local ffi = require('ffi')
ffi.cdef[[
typedef struct {
 unsigned long cb;
 wchar_t *lpReserved, *lpDesktop, *lpTitle;
 unsigned long dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
 unsigned short wShowWindow, cbReserved2;
 unsigned char *lpReserved2;
 void *hStdInput, *hStdOutput, *hStdError;
} PoeAssistantStartupInfoW;
typedef struct { void *hProcess, *hThread; unsigned long dwProcessId, dwThreadId; } PoeAssistantProcessInfo;
int __stdcall MultiByteToWideChar(unsigned int, unsigned long, const char*, int, wchar_t*, int);
int __stdcall CreateProcessW(const wchar_t*, wchar_t*, void*, void*, int, unsigned long, void*, const wchar_t*, PoeAssistantStartupInfoW*, PoeAssistantProcessInfo*);
int __stdcall CloseHandle(void*);
unsigned long __stdcall GetLastError(void);
]]
local kernel = ffi.load('kernel32')
local function wide(text)
  local count = kernel.MultiByteToWideChar(65001, 8, text, #text, nil, 0)
  assert(count > 0, 'Invalid UTF-8 startup path')
  local buffer = ffi.new('wchar_t[?]', count + 1)
  assert(kernel.MultiByteToWideChar(65001, 8, text, #text, buffer, count) > 0, 'Could not convert startup path')
  return buffer
end
return function(executable, arguments)
  local info = ffi.new('PoeAssistantStartupInfoW'); info.cb = ffi.sizeof(info)
  local process = ffi.new('PoeAssistantProcessInfo')
  local command = wide('"' .. executable .. '" ' .. arguments)
  local ok = kernel.CreateProcessW(wide(executable), command, nil, nil, 0, 0x08000000, nil, nil, info, process)
  assert(ok ~= 0, 'Windows could not start the bundled assistant (error ' .. tonumber(kernel.GetLastError()) .. '). Run setup again.')
  local pid = tonumber(process.dwProcessId)
  kernel.CloseHandle(process.hThread); kernel.CloseHandle(process.hProcess)
  return pid
end
