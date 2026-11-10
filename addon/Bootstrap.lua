-- Native managed bootstrap. Lua's Windows CRT accepts ANSI, not UTF-8 paths;
-- use ASCII paths relative to PoB for every Lua file operation. Node retains
-- the UTF-8 absolute paths returned by the native host.
return function(destination)
  local json = require('dkjson')
  local function read(file)
    local stream, failure = io.open(file, 'rb'); assert(stream, failure)
    local text = stream:read('*a'); stream:close()
    local value, _, problem = json.decode(text); assert(value, problem or ('Invalid JSON: ' .. file)); return value
  end
  local function write(file, value)
    local stream, failure = io.open(file .. '.tmp', 'wb'); assert(stream, failure)
    assert(stream:write(json.encode(value))); stream:close()
    os.remove(file); assert(os.rename(file .. '.tmp', file))
  end
  local base = GetScriptPath():gsub('\\', '/'):gsub('/$', '')
  local current = read(destination .. '/current.json')
  assert(current.repository == 'arthurhpabreu/poe-assistant', 'Unexpected addon identity')
  assert(type(current.releaseName) == 'string' and current.releaseName:match('^[%w%.%-]+$'), 'Invalid addon release')
  local config = read(destination .. '/data/session.json')
  assert(type(config.id) == 'string' and config.id:match('^pobhelper%-%w[%w%-]*$'), 'Invalid addon session')
  local relativeRoot = destination .. '/releases/' .. current.releaseName
  config.install = base; config.root = base .. '/' .. relativeRoot
  config.destination = base .. '/' .. destination; config.state = config.destination .. '/data'
  config.luaRoot = relativeRoot
  config.runtime = destination .. '/data/sessions/' .. config.id
  config.node = config.root .. '/runtime/node.exe'
  config.backendEntry = config.root .. '/src/launch-backend.mjs'
  config.launchProcess = assert(loadfile(relativeRoot .. '/addon/WindowsProcess.lua'))()
  config.sessionFile = config.state .. '/session.json'
  -- Verify the actual bridge directory, not only Node's ability to read it.
  local check = config.runtime .. '/native-write-check.tmp'
  local stream, failure = io.open(check, 'wb'); assert(stream, 'Assistant data is not writable: ' .. tostring(failure))
  stream:write('ok'); stream:close(); os.remove(check)
  local processId
  pcall(function()
    local ffi = require('ffi'); ffi.cdef('unsigned long GetCurrentProcessId(void);')
    processId = tonumber(ffi.C.GetCurrentProcessId())
  end)
  local nonce = os.getenv('POE_ASSISTANT_PROBE')
  local report = destination .. '/startup.json'
  if nonce then
    assert(nonce:match('^[a-f0-9%-]+$') and #nonce == 36, 'Invalid startup verification nonce')
    config.probe = read(destination .. '/verification/' .. nonce .. '/request.json')
    assert(config.probe.nonce == nonce, 'Startup verification mismatch')
    config.id = config.probe.sessionId; config.sessionFile = config.probe.sessionFile
    config.runtime = destination .. '/verification/' .. nonce .. '/runtime'
    report = destination .. '/verification/' .. nonce .. '/result.json'
  end
  local controller = {}
  config.reportStartup = function(stage, details)
    details = details or {}; details.stage = stage; details.time = os.time() * 1000
    details.install = base; details.release = current.releaseName; details.version = current.version
    details.nonce = nonce; details.processId = processId
    details.sessionId = config.id
    write(report, details)
    if stage == 'failed' then controller.failure = details.error end
  end
  config.reportStartup('loading')
  local original = PLoadModule
  PLoadModule = function(name, ...)
    if name ~= 'Modules/Main' then return original(name, ...) end
    local err, main = original(name, ...); PLoadModule = original
    if not err and main then
      local attached, problem = pcall(function()
        if config.probe then
          main.SaveSettings = function() end; main.CanExit = function() return true end
          main.ChangeUserPath = function(self)
            self.userPath = destination .. '/verification/' .. nonce .. '/user/'
            self.defaultBuildPath = self.userPath .. 'Builds/'; self.buildPath = self.defaultBuildPath
          end
          main.disableDevAutoSave = true
        end
        assert(loadfile(relativeRoot .. '/addon/PobHelper.lua'))()(main, config)
      end)
      if not attached then config.reportStartup('failed', { error = tostring(problem) }) end
    else config.reportStartup('failed', { error = tostring(err or 'PoB returned no main object') }) end
    return err, main
  end
  controller.configureLaunch = function(launch)
    local init = launch.OnInit
    launch.OnInit = function(self, ...)
      init(self, ...)
      if controller.failure then self:ShowPrompt(1, 0.5, 0.2, 'PoE Assistant could not start:\n' .. tostring(controller.failure) .. '\n\nRun setup again. Details: ' .. destination .. '/startup.json') end
    end
    if config.probe then
      launch.CheckForUpdate = function() end
      launch.ApplyUpdate = function() error('Updates are disabled in the installer verification.') end
      launch.OnExit = function() end
      launch.CanExit = function() return true end
      launch.ShowErrMsg = function(self, format, ...)
        config.reportStartup('failed', { error = string.format(format, ...) }); Exit()
      end
      local frame = launch.OnFrame
      launch.OnFrame = function(self, ...)
        frame(self, ...)
        if config.probeFinished then Exit() end
      end
      return
    end
    local officialApply = launch.ApplyUpdate
    launch.ApplyUpdate = function(self, mode)
      local spawn = SpawnProcess
      SpawnProcess = function(target, arguments, ...)
        local expected = (GetRuntimePath() .. '/Update'):gsub('\\', '/'):lower()
        if target:gsub('\\', '/'):lower() == expected and arguments == 'UpdateApply.lua Update/opFileRuntime.txt' then arguments = 'PoEAssistantUpdate.lua Update/opFileRuntime.txt' end
        return spawn(target, arguments, ...)
      end
      local ok, failure = pcall(officialApply, self, mode); SpawnProcess = spawn
      if not ok then error(failure) end
    end
  end
  return controller
end
