-- Minimal native API harness: verifies rollback spans the first calculation frame.
local memory, objects, serial = {}, {}, 0
local function encode(value)
  -- Deterministic representation with an object registry for fake file I/O.
  local function stable(v)
    if type(v) ~= 'table' then return type(v) .. ':' .. tostring(v) end
    local keys = {}; for k in pairs(v) do keys[#keys + 1] = k end
    table.sort(keys, function(a,b) return tostring(a)<tostring(b) end)
    local out = {}; for _, k in ipairs(keys) do out[#out + 1] = tostring(k) .. '=' .. stable(v[k]) end
    return '{' .. table.concat(out, ';') .. '}'
  end
  local key = stable(value); objects[key] = value; return key
end
package.preload.dkjson = function() return { encode = encode, decode = function(text) return objects[text] end } end
local function decodeFile(name) return objects[memory['/runtime/' .. name]] end
io.open = function(name, mode)
  if mode:find('r') and not memory[name] then return nil end
  return { read = function() return memory[name] end, write = function(_, text) memory[name] = text end, close = function() end }
end
os.rename = function(a,b) memory[b] = memory[a]; memory[a] = nil; return true end
os.remove = function(a) memory[a] = nil; return true end
os.execute = function() error('Managed startup must not depend on PowerShell') end
local backendStarts, startup = {}, {}
SpawnProcess = function(executable, arguments) backendStarts[#backendStarts+1]={executable,arguments} end
os.time = function() return 1000 end
local now = 2000
GetTime = function() return now end
GetVirtualScreenSize = function() return 1500, 900 end
GetCursorPos = function() return 0, 0 end
IsKeyDown = function() return false end
DrawStringWidth = function(_,_,text) return #text * 7 end
local drawn = {}
local viewport
DrawString = function(x,y,_,_,_,text) if not viewport or x >= 0 and x < viewport.width and y >= 0 and y < viewport.height then drawn[#drawn + 1] = text end end; DrawImage = function() end; SetDrawColor = function() end
SetDrawLayer = function() end; SetViewport = function(x,y,width,height) viewport = width and {width=width,height=height} or nil end; ConPrintf = function() end
launch = { versionNumber = 'test' }
local controlHost
new = function(kind, anchor, rect, init, callback)
  local control = { controls = {}, list = type(init) == 'table' and init or {}, selFunc = callback, buf = init or '', selIndex = 1, x = rect and rect[1] or 0, y = rect and rect[2] or 0, width = rect and rect[3] or 0, height = rect and rect[4] or 0 }
  if kind == 'ControlHost' then controlHost = control end
  control.SetList = function(self,list) self.list = list end
  control.SetContentDimension = function(self,content,view) self.offsetMax = math.max(0, content - view); self.offset = math.min(self.offset or 0,self.offsetMax) end
  control.SetOffset = function(self,offset) self.offset = math.max(0, math.min(self.offsetMax or 0,offset)) end
  control.Scroll = function(self,amount) self:SetOffset((self.offset or 0) + 72 * amount) end
  control.SetText = function(self,text) self.buf = text end
  control.SetPlaceholder = function(self,text) self.placeholder = text end
  control.SelectControl = function(self, selected) self.selControl = selected end
  control.ProcessControlsInput = function() end; control.DrawControls = function(self) for _,c in pairs(self.controls) do if c.shown and c.Draw then c:Draw() end end end
  control.OnKeyDown = function(self) return self end
  return control
end
common = { xml = { ParseXML = function(text)
  return { { elem = 'PathOfBuilding', { elem = 'Build', attrib = { targetVersion = '3_0', content = text } } } }
end } }
local build = { state = 'original', savers = {}, targetVersion = '3_0', buildName = 'test', characterLevel = 1, viewMode = 'TREE', configTab = { input = {} }, spec = { allocNodes = {}, nodes = { [1] = { id=1, name='Life', type='Normal', sd={} }, [2]={id=2,name='Life',type='Normal',sd={}} } }, calcsTab = { mainOutput = { Life = 60 } } }
build.SaveDB = function(self) return self.state end
build.Shutdown = function(self) self.savers = nil end
build.Init = function(self,_,_,xml) self.state = xml; self.savers = {}; self.failFrame = xml == 'candidate'; self.targetVersion = '3_0' end
local frames = 0
local main = { modes = { BUILD = build }, mode='BUILD', inputEvents={}, popups={}, Init=function() end, OnKeyDown=function() end, OnKeyUp=function() end, OnFrame=function() frames=frames+1; if build.failFrame then error('synthetic calculation failure') end end }
addon(main, { id='test-session', runtime='/runtime', node='bundled-node.exe', backendEntry='fixed.mjs', sessionFile='fixed.json', launchProcess=SpawnProcess, reportStartup=function(stage,details) startup[#startup+1]={stage=stage,details=details} end })
main:Init(); main:OnFrame()
assert(backendStarts[1][1]=='bundled-node.exe' and backendStarts[1][2]=='"fixed.mjs" --session "fixed.json"', 'Managed startup did not invoke bundled Node directly')
assert(startup[1].stage=='rendered' and startup[1].details.panel=='expanded', 'Rendering was not confirmed independently of backend readiness')
memory['/runtime/ui.json'] = encode({ sessionId='test-session', messages={{role='user',text='Help me'},{role='assistant',text='### Build result\n- **Life:** 60\n\nA readable answer.'}}, settings={provider='codex',model='codex-test'}, models={codex={{id='codex-test',label='Codex test'}},claude={{id='sonnet',label='Sonnet'}}} })
now = now + 500; main:OnFrame()
local c = controlHost.controls
assert(not c.analyze and not c.optimize, 'chat shortcut buttons remain')
assert(not c.transcript and c.conversation and c.copy, 'conversation cards were not initialized')
local visible = table.concat(drawn, '\n')
assert(visible:find('POB ASSISTANT') and visible:find('YOU') and visible:find('Build result'), 'message roles or headings were not rendered')
assert(not visible:find('###', 1, true) and not visible:find('**', 1, true), 'Markdown markers leaked into the chat')
assert(c.model.list[c.model.selIndex].id == 'codex-test', 'saved model not selected')
c.provider.selIndex = 2; c.provider.selFunc()
assert(c.model.list[c.model.selIndex].id == '', 'Codex model leaked into Claude selection')
c.model.selIndex = 2; c.model.selFunc(2, c.model.list[2])
c.provider.selIndex = 1; c.provider.selFunc()
assert(c.model.list[c.model.selIndex].id == 'codex-test', 'Codex choice was lost')
c.provider.selIndex = 2; c.provider.selFunc()
assert(c.model.list[c.model.selIndex].id == 'sonnet', 'Claude choice was lost')
c.model.selIndex = #c.model.list; c.customModel:SetText('custom-model')
c.input:SetText('inspect my build'); c.send.selFunc()
local sent
for file, content in pairs(memory) do
  if file:find('/inbox/') then local data = objects[content]; if data.type == 'chat' then sent = data end end
end
assert(sent and sent.settings.provider == 'claude' and sent.settings.model == 'custom-model', 'custom model was not passed to the chat request')
c.input:SetText('unfinished draft'); c.clear.selFunc()
local clear
for file, content in pairs(memory) do
  if file:find('/inbox/') then local data = objects[content]; if data.type == 'clear_chat' then clear = data end end
end
assert(clear and clear.buildKey == sent.buildKey, 'clear request did not target the current build')
assert(c.input.buf == 'unfinished draft', 'draft was cleared before the backend confirmed')
memory['/runtime/ui.json'] = encode({ sessionId='test-session', messages={}, settings=sent.settings, chatClearedAt=1000000 })
now = now + 500; main:OnFrame()
assert(c.input.buf == 'unfinished draft' and build.state == 'original', 'clearing history erased the composer draft or modified the build')
memory['/runtime/ui.json'] = nil
local baseline = assert(decodeFile('snapshot.json'))
memory['/runtime/command.json'] = encode({ protocol=1, sessionId='test-session', id='apply-1', deadline=2000000, expectedBuildKey=baseline.buildKey, expectedXml='original', name='apply', args={xml='candidate'} })
now = now + 1500; main:OnFrame()
assert(build.state == 'original', 'failed first-frame calculation did not roll back')
local ack = assert(decodeFile('ack.json'))
assert(ack.error and ack.error:find('restored'), 'failed candidate was not acknowledged as restored')
assert(GetVirtualScreenSize() == 1500, 'virtual screen size leaked after failure')
memory['/runtime/command.json'] = encode({ protocol=1, sessionId='test-session', id='tree-2', deadline=2000000, expectedBuildKey=baseline.buildKey, expectedXml='original', name='tree', args={limit=-1} })
now = now + 1500; main:OnFrame()
ack = assert(decodeFile('ack.json'))
assert(not ack.error and #ack.result.nodes == 1, 'negative tree limit was not clamped')
memory['/runtime/ui.json'] = encode({ sessionId='test-session', messages={}, settings=sent.settings, proposal={id='proposal-1',title='Test',operations={}} })
now = now + 500; main:OnFrame()
assert(not c.wide, 'obsolete Wider button remains')
c.apply.selFunc(); c.apply.selFunc()
local count, applyRequest = 0
for file, content in pairs(memory) do if file:find('/inbox/') then local data = objects[content]; if data.type == 'apply' then count=count+1; applyRequest=data end end end
assert(count == 1 and applyRequest.proposalId == 'proposal-1', 'duplicate click queued two applications or lost proposal identity')
now = now + 500; main:OnFrame(); assert(not c.apply.enabled, 'Apply stayed enabled while awaiting confirmation')
memory['/runtime/ui.json'] = encode({ sessionId='test-session', messages={}, settings=sent.settings, lastRequest={id='later-settings',state='complete'}, requestResults={[applyRequest.id]={state='failed'}} })
now = now + 500; main:OnFrame()
assert(c.send.enabled, 'a later status overwrote the application result and stranded pending state')
c.settings.selFunc(); main:OnFrame()
assert(c.save.y + c.save.height <= c.login.y and c.login.y + c.login.height <= c.updates.y, 'settings action buttons overlap')
c.settings.selFunc()
memory['/runtime/command.json'] = encode({ protocol=1, sessionId='test-session', id='apply-success', deadline=2000000, expectedBuildKey=baseline.buildKey, expectedXml='original', name='apply', args={xml='accepted'} })
now = now + 1500; main:OnFrame()
local receipt = assert(decodeFile('receipts/apply-success.json'))
assert(receipt.result.applied and build.state == 'accepted', 'successful application has no durable commit receipt')
local committedRevision = receipt.result.committedRevision
build.state = 'manually edited'; now = now + 1500; main:OnFrame()
assert(decodeFile('receipts/apply-success.json').result.committedRevision == committedRevision, 'a later manual edit changed the immutable receipt')
GetVirtualScreenSize=function() return 850,500 end
main:OnFrame()
assert(c.toggle.label=='PoE Assistant [F8]' and table.concat(drawn,'\n'):find('Maximize PoB to open chat'), 'Small-window installation badge is not discoverable')
return true
