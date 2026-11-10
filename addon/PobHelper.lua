-- PoB Helper: native sidebar and versioned, asynchronous file bridge.
-- No generated Lua or shell code is accepted from the model.
return function(main, config)
  local json = require('dkjson')
  local runtime = config.runtime:gsub('\\', '/')
  local instance = tostring(os.time()) .. '-' .. tostring({}):gsub('[^%w]', '')
  local originalInit, originalFrame = main.Init, main.OnFrame
  local originalKeyDown, originalKeyUp = main.OnKeyDown, main.OnKeyUp
  local clock, sequence, epoch = 0, 0, 0
  local ui = { messages = {}, status = 'Starting assistant...', settings = {} }
  local host, width, x, height, advanced, collapsed, disabled, buildKey
  local lastText, lastWrapWidth, handledCommand, pendingAck, applying, transaction
  local cards, wide, showDetails = {}, false, false
  local lastSnapshot, lastSnapshotAt, heartbeatAt = nil, 0, 0
  local modelProvider, modelSelections = 'codex', {}
  -- Standard PoB's font renderer is ASCII-only; keep original JSON/XML in UTF-8.
  local function display(text)
    text = tostring(text or '')
    local replacements = { ['á']='a', ['à']='a', ['ã']='a', ['â']='a', ['ä']='a', ['é']='e', ['è']='e', ['ê']='e', ['ë']='e', ['í']='i', ['ì']='i', ['î']='i', ['ï']='i', ['ó']='o', ['ò']='o', ['õ']='o', ['ô']='o', ['ö']='o', ['ú']='u', ['ù']='u', ['û']='u', ['ü']='u', ['ç']='c', ['ñ']='n', ['Á']='A', ['À']='A', ['Ã']='A', ['Â']='A', ['É']='E', ['Ê']='E', ['Í']='I', ['Ó']='O', ['Õ']='O', ['Ô']='O', ['Ú']='U', ['Ç']='C', ['…']='...', ['—']='-', ['–']='-', ['“']='"', ['”']='"', ['‘']="'", ['’']="'", ['·']='|', ['×']='x', ['→']='->', ['≥']='>=', ['≤']='<=' }
    for from, to in pairs(replacements) do text = text:gsub(from, to) end
    return text:gsub('[\194-\244][\128-\191]*', '?')
  end
  local function read(file)
    local f = io.open(runtime .. '/' .. file, 'rb')
    if not f then return end
    local text = f:read('*a'); f:close()
    return json.decode(text)
  end
  local function write(file, object)
    local name = runtime .. '/' .. file
    local f = assert(io.open(name .. '.tmp', 'wb'))
    f:write(type(object) == 'string' and object or json.encode(object)); f:close()
    os.remove(name)
    assert(os.rename(name .. '.tmp', name))
  end
  local function request(kind, data)
    sequence = sequence + 1
    local id = instance .. '-' .. sequence
    data = data or {}; data.type = kind; data.id = id; data.protocol = 1; data.sessionId = config.id
    data.buildKey = buildKey; data.createdAt = os.time() * 1000
    write('inbox/' .. id .. '.json', data)
  end
  local function currentBuild()
    return main.mode == 'BUILD' and main.modes.BUILD and main.modes.BUILD.savers and main.modes.BUILD
  end
  local function numericOutput(output)
    local result = {}
    for key, value in pairs(output or {}) do
      if type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge then result[key] = value end
    end
    return result
  end
  local function revision(xml)
    local document, parseError = common.xml.ParseXML(xml)
    assert(not parseError, 'Could not calculate the build revision.')
    local function canonical(node)
      if type(node) == 'string' then
        local value = node:gsub('^%s+', ''):gsub('%s+$', '')
        return value ~= '' and value or nil
      end
      if node.elem == 'PlayerStat' or node.elem == 'MinionStat' or node.elem == 'FullDPSSkill' then return nil end
      local attributes, keys, children = {}, {}, {}
      for key in pairs(node.attrib or {}) do if not (node.elem == 'Build' and key == 'viewMode') then keys[#keys + 1] = key end end
      table.sort(keys)
      for _, key in ipairs(keys) do attributes[#attributes + 1] = { key, node.attrib[key] } end
      for _, child in ipairs(node) do local value = canonical(child); if value then children[#children + 1] = value end end
      return { node.elem, attributes, children }
    end
    return json.encode(canonical(document[1]))
  end
  local function snapshot()
    local build = currentBuild()
    local state = { protocol = 1, sessionId = config.id, instanceId = instance, timestamp = os.time() * 1000, mode = main.mode, buildKey = buildKey, pobVersion = launch.versionNumber }
    if build then
      state.xml = assert(build:SaveDB('PoB Helper snapshot'))
      state.revision = revision(state.xml)
      state.name = build.buildName; state.fileName = build.dbFileName; state.level = build.characterLevel
      state.targetVersion = build.targetVersion; state.treeVersion = build.spec and build.spec.treeVersion
      state.output = numericOutput(build.calcsTab and build.calcsTab.mainOutput)
      state.mainSkill = build.mainSocketGroup; state.view = build.viewMode
      state.config = build.configTab and build.configTab.input
      -- Config values are scalar; cyclic runtime objects are deliberately excluded.
      local scalarConfig = {}
      for k, v in pairs(state.config or {}) do if type(v) == 'string' or type(v) == 'boolean' or type(v) == 'number' then scalarConfig[k] = v end end
      state.config = scalarConfig
    end
    write('snapshot.json', state); lastSnapshot = state; lastSnapshotAt = GetTime()
    return state
  end
  local function wrap(text, maxWidth, size, font)
    local result = {}
    size = size or 17; font = font or 'VAR'
    text = display(text):gsub('%^x%x%x%x%x%x%x', ''):gsub('%^%d', '')
    for line in (text .. '\n'):gmatch('(.-)\n') do
      local current = ''
      for word in line:gmatch('%S+') do
        local candidate = current == '' and word or current .. ' ' .. word
        if current ~= '' and DrawStringWidth(size, font, candidate) > maxWidth then
          result[#result + 1] = current; current = word
        else current = candidate end
        while DrawStringWidth(size, font, current) > maxWidth and #current > 1 do
          local low, high, count = 1, math.min(#current, math.max(1, math.floor(maxWidth) * 2)), 1
          while low <= high do
            local middle = math.floor((low + high) / 2)
            if DrawStringWidth(size, font, current:sub(1, middle)) <= maxWidth then count = middle; low = middle + 1 else high = middle - 1 end
          end
          result[#result + 1] = current:sub(1, count); current = current:sub(count + 1)
        end
      end
      result[#result + 1] = current
    end
    return table.concat(result, '\n')
  end
  local function messageRows(text, maxWidth)
    local rows, code = {}, false
    if #text > 100000 then text = text:sub(1, 100000) .. '\n\nLong message preview. Copy reply to read the full text.' end
    for line in (display(text):gsub('\r', '') .. '\n'):gmatch('(.-)\n') do
      if line:match('^%s*```') then code = not code
      else
        local heading = not code and (line:match('^#+%s+(.+)') or line:match('^%*%*(.-)%*%*:?$'))
        local bullet = not code and line:match('^%s*[-*+]%s+(.+)')
        local value = heading or bullet and ('- ' .. bullet) or line
        if not code then value = value:gsub('%*%*(.-)%*%*', '%1'):gsub('`(.-)`', '%1'):gsub('%[([^%]]+)%]%((https?://[^%)]+)%)', '%1 (%2)') end
        local size, font = heading and 19 or code and 15 or 18, code and 'FIXED' or 'VAR'
        local indent = bullet and 10 or 0
        for part in (wrap(value, maxWidth - indent, size, font) .. '\n'):gmatch('(.-)\n') do
          rows[#rows + 1] = { text = part, size = size, font = font, heading = type(heading) == 'string', code = code, indent = indent, height = part == '' and 10 or size + 6 }
        end
      end
    end
    return rows
  end
  local function changeSummary(op)
    local section = op.path:match('PathOfBuilding/([^/]+)') or 'build'
    local names = { Build = 'character', Tree = 'passive tree', Items = 'equipment', Skills = 'skills and gems', Config = 'configuration', Notes = 'notes', Party = 'party setup' }
    local action = ({ remove = 'Remove from', append_xml = 'Add to', replace_build = 'Replace', replace_xml = 'Update', set_text = 'Update', set_attribute = 'Update' })[op.type] or 'Update'
    local attribute = op.path:match('/@([^/]+)$')
    return action .. ' ' .. (names[section] or section:lower()) .. (attribute and (': ' .. attribute .. ' = ' .. tostring(op.value):sub(1, 80)) or '')
  end
  local function updateConversation()
    local c = host.controls
    local signature = json.encode({ ui.messages or {}, ui.proposal or false, showDetails, ui.settings.access or 'full', ui.busy or false, ui.workMessage or '' })
    local changed = signature ~= lastText or c.conversation.width ~= lastWrapWidth
    local atBottom = (c.chatScroll.offsetMax or 0) - (c.chatScroll.offset or 0) < 28
    if changed then
      cards = {}
      local function add(role, title, text)
        local rows = messageRows(text, c.conversation.width - 58 - (role == 'user' and 20 or 0))
        local cardHeight = 42
        for _, row in ipairs(rows) do cardHeight = cardHeight + row.height end
        cards[#cards + 1] = { role = role, title = title, rows = rows, height = cardHeight }
      end
      if #(ui.messages or {}) == 0 then
        add('assistant', 'YOUR BUILD, YOUR GOAL', '### What would you like to do?\nTell me in your own words. I can compare items, improve passives and explain mechanics using your open build.' .. (ui.settings.access ~= 'pob' and '\n\nYou can also ask me to work with files and commands on this PC.' or '') .. '\n\nInclude your league and budget when they matter.')
      end
      for _, message in ipairs(ui.messages or {}) do
        add(message.role, message.role == 'user' and 'YOU' or message.role == 'assistant' and 'POB ASSISTANT' or 'UPDATE', message.text)
      end
      if ui.busy then add('system', 'WORKING', ui.workMessage and ui.workMessage ~= '' and ui.workMessage or 'I am working on your request. Large builds can take time. You can stop with Cancel.') end
      if ui.proposal then
        local lines = { '### ' .. tostring(ui.proposal.title), tostring(#(ui.proposal.operations or {})) .. ' proposed changes. Review them, then choose Apply changes.' }
        for _, op in ipairs(ui.proposal.operations or {}) do
          lines[#lines + 1] = '\n- ' .. changeSummary(op)
          if showDetails then
            local value = tostring(op.value)
            lines[#lines + 1] = '\n' .. op.path .. '\n```\n' .. value:sub(1, 12000) .. '\n```'
            if #value > 12000 then lines[#lines + 1] = '\nLarge value preview. Use Copy changes for the full proposal.' end
          end
        end
        add('proposal', showDetails and 'CHANGE DETAILS' or 'READY FOR REVIEW', table.concat(lines, '\n'))
      end
      lastText = signature; lastWrapWidth = c.conversation.width
    end
    local total = 8
    for _, card in ipairs(cards) do total = total + card.height + 12 end
    c.chatScroll:SetContentDimension(total, c.conversation.height)
    if changed and atBottom then c.chatScroll:SetOffset(c.chatScroll.offsetMax or 0) end
    c.latest.shown = not advanced and (c.chatScroll.offsetMax or 0) - (c.chatScroll.offset or 0) > 28
  end
  local function drawConversation(self)
    local cx, cy = self.x, self.y
    SetViewport(cx, cy, self.width - 20, self.height)
    local top = 8 - (host.controls.chatScroll.offset or 0)
    for _, card in ipairs(cards) do
      local left = card.role == 'user' and 20 or 0
      local cardWidth = self.width - 24 - (card.role == 'user' and 20 or 0)
      if top + card.height > 0 and top < self.height then
        if card.role == 'user' then SetDrawColor(0.075, 0.15, 0.19)
        elseif card.role == 'proposal' then SetDrawColor(0.16, 0.135, 0.075)
        elseif card.role == 'system' then SetDrawColor(0.075, 0.085, 0.10)
        else SetDrawColor(0.09, 0.105, 0.13) end
        DrawImage(nil, left, top, cardWidth, card.height)
        if card.role == 'user' then SetDrawColor(0.40, 0.80, 0.87)
        elseif card.role == 'system' then SetDrawColor(0.60, 0.66, 0.73)
        else SetDrawColor(0.92, 0.77, 0.46) end
        DrawImage(nil, left, top, 3, card.height)
        DrawString(left + 14, top + 10, 'LEFT', 13, 'VAR', card.title)
        local rowY = top + 32
        for _, row in ipairs(card.rows) do
          if row.heading then SetDrawColor(0.98, 0.87, 0.64)
          elseif row.code then SetDrawColor(0.65, 0.83, 0.86)
          else SetDrawColor(0.88, 0.90, 0.93) end
          DrawString(left + 14 + row.indent, rowY, 'LEFT', row.size, row.font, row.text)
          rowY = rowY + row.height
        end
      end
      top = top + card.height + 12
    end
    SetViewport()
  end
  local function selectedModel()
    local c = host.controls
    local option = c.model.list[c.model.selIndex]
    return option and (option.custom and c.customModel.buf or option.id) or ''
  end
  local function populateModels(provider, selected)
    local c = host.controls
    local options = { { id = '', label = 'Model: CLI default' } }
    local selection = 1
    for _, model in ipairs(ui.models and ui.models[provider] or {}) do
      options[#options + 1] = { id = model.id, label = display(model.label) }
      if model.id == selected then selection = #options end
    end
    options[#options + 1] = { label = 'Custom model...', custom = true }
    if selected ~= '' and selection == 1 then selection = #options; c.customModel:SetText(selected) end
    if selection ~= #options then c.customModel:SetText('') end
    c.model:SetList(options); c.model.selIndex = selection
    c.model.dropped = false
    modelProvider = provider
  end
  local function settingsValue()
    local model = selectedModel()
    modelSelections[modelProvider] = model
    return {
      provider = host.controls.provider.selIndex == 2 and 'claude' or 'codex',
      model = model,
      modelSelections = modelSelections,
      effort = ({ '', 'low', 'medium', 'high', 'xhigh', 'max' })[host.controls.effort.selIndex] or '',
      executable = host.controls.executable.buf,
      research = host.controls.research.selIndex == 1,
      access = host.controls.access.selIndex == 2 and 'pob' or 'full',
    }
  end
  local function saveSettings()
    request('settings', { settings = settingsValue() })
  end
  local function send(text)
    text = text or host.controls.input.buf
    if ui.busy or text:match('^%s*$') then return end
    request('chat', { text = text, settings = settingsValue() })
    host.controls.input:SetText(''); host:SelectControl(host.controls.input)
  end
  local function initializeControls()
    host = new('ControlHost')
    host.controls.provider = new('DropDownControl', nil, { 0, 112, 118, 24 }, { 'Codex CLI', 'Claude CLI' }, function()
      modelSelections[modelProvider] = selectedModel()
      local provider = host.controls.provider.selIndex == 2 and 'claude' or 'codex'
      populateModels(provider, modelSelections[provider] or '')
      host.controls.executable:SetText(''); saveSettings()
    end)
    host.controls.model = new('DropDownControl', nil, { 0, 112, 200, 24 }, { { id = '', label = 'Model: CLI default' }, { label = 'Custom model...', custom = true } }, function(_, option)
      if not option.custom then saveSettings() end
    end)
    host.controls.customModel = new('EditControl', nil, { 0, 144, 200, 24 }, '', nil, nil, 150)
    host.controls.customModel:SetPlaceholder('Custom model ID')
    host.controls.settings = new('ButtonControl', nil, { 0, 144, 100, 26 }, 'Settings', function() advanced = not advanced end)
    host.controls.wide = new('ButtonControl', nil, { 0, 144, 82, 26 }, 'Wider', function() wide = not wide end)
    host.controls.copy = new('ButtonControl', nil, { 0, 144, 106, 26 }, 'Copy reply', function()
      if showDetails and ui.proposal then Copy(json.encode(ui.proposal.operations, { indent = true })); return end
      for index = #(ui.messages or {}), 1, -1 do if ui.messages[index].role == 'assistant' then Copy(ui.messages[index].text); return end end
    end)
    host.controls.latest = new('ButtonControl', nil, { 0, 144, 72, 26 }, 'Latest', function() host.controls.chatScroll:SetOffset(host.controls.chatScroll.offsetMax or 0) end)
    host.controls.conversation = new('Control', nil, { 0, 184, 300, 300 })
    host.controls.conversation.Draw = drawConversation
    host.controls.conversation.OnKeyDown = function(self, key)
      if key == 'LEFTBUTTON' then return self:IsMouseOver() and self or nil end
      if key == 'PAGEDOWN' then host.controls.chatScroll:Scroll(5)
      elseif key == 'PAGEUP' then host.controls.chatScroll:Scroll(-5)
      elseif key == 'HOME' then host.controls.chatScroll:SetOffset(0)
      elseif key == 'END' then host.controls.chatScroll:SetOffset(host.controls.chatScroll.offsetMax or 0) end
      return self
    end
    host.controls.chatScroll = new('ScrollBarControl', nil, { 0, 184, 16, 300 }, 72)
    host.controls.input = new('EditControl', nil, { 0, 0, 300, 84 }, '', nil, nil, 12000, nil, 18)
    host.controls.input:SetPlaceholder('Tell me what you want to do...')
    local inputKey = host.controls.input.OnKeyDown
    host.controls.input.OnKeyDown = function(self, key, doubleClick)
      if (key == 'RETURN' or key == 'ENTER') and IsKeyDown('CTRL') then send(); return self end
      return inputKey(self, key, doubleClick)
    end
    host.controls.send = new('ButtonControl', nil, { 0, 0, 100, 28 }, 'Send', function() send() end)
    host.controls.cancel = new('ButtonControl', nil, { 0, 0, 100, 28 }, 'Cancel', function() request('cancel') end)
    host.controls.clear = new('ButtonControl', nil, { 0, 0, 104, 28 }, 'Clear chat', function() request('clear_chat') end)
    host.controls.apply = new('ButtonControl', nil, { 0, 0, 160, 28 }, 'Apply changes', function() request('apply') end)
    host.controls.details = new('ButtonControl', nil, { 0, 0, 90, 28 }, 'Details', function() showDetails = not showDetails end)
    host.controls.undo = new('ButtonControl', nil, { 0, 0, 110, 27 }, 'Undo', function() request('undo') end)
    host.controls.toggle = new('ButtonControl', nil, { 0, 10, 34, 24 }, '<', function() collapsed = not collapsed end)
    host.controls.executable = new('EditControl', nil, { 0, 214, 300, 25 }, '', nil, nil, 1000)
    host.controls.executable:SetPlaceholder('.exe or .js (auto-detect when empty)')
    host.controls.effort = new('DropDownControl', nil, { 0, 278, 160, 25 }, { 'CLI default', 'low', 'medium', 'high', 'xhigh', 'max' })
    host.controls.research = new('DropDownControl', nil, { 0, 342, 250, 25 }, { 'Forum / Reddit / wiki', 'Web research off' })
    host.controls.access = new('DropDownControl', nil, { 0, 406, 250, 25 }, { 'Full machine access', 'PoB tools only' })
    host.controls.save = new('ButtonControl', nil, { 0, 450, 150, 28 }, 'Save settings', function() saveSettings(); advanced = false end)
    host.controls.login = new('ButtonControl', nil, { 0, 492, 130, 28 }, 'Sign in', function() request('login', { settings = settingsValue() }) end)
    host.controls.authcheck = new('ButtonControl', nil, { 0, 492, 130, 28 }, 'Check login', function() request('auth_status', { settings = settingsValue() }) end)
  end
  local function syncUi()
    local nextUi = read('ui.json')
    if nextUi and nextUi.sessionId == config.id then
      local changedSettings = json.encode(nextUi.settings or {}) ~= json.encode(ui.settings or {})
      local changedModels = json.encode(nextUi.models or {}) ~= json.encode(ui.models or {})
      local pendingModel = host and selectedModel() or ''
      if host and nextUi.chatClearedAt and nextUi.chatClearedAt ~= ui.chatClearedAt then
        host.controls.input:SetText(''); host.controls.chatScroll:SetOffset(0)
        showDetails = false; lastText = nil
      end
      ui = nextUi
      if changedSettings and host then
        host.controls.provider.selIndex = ui.settings.provider == 'claude' and 2 or 1
        modelSelections = ui.settings.modelSelections or {}
        modelSelections[ui.settings.provider or 'codex'] = ui.settings.model or ''
        populateModels(ui.settings.provider or 'codex', ui.settings.model or '')
        host.controls.executable:SetText(ui.settings.executable or '')
        local effort = { [''] = 1, low = 2, medium = 3, high = 4, xhigh = 5, max = 6 }
        host.controls.effort.selIndex = effort[ui.settings.effort or ''] or 1
        host.controls.research.selIndex = ui.settings.research == false and 2 or 1
        host.controls.access.selIndex = ui.settings.access == 'pob' and 2 or 1
      elseif changedModels and host then
        populateModels(modelProvider, pendingModel)
      end
    end
  end
  local function processCommand()
    local command = read('command.json')
    if not command or command.id == handledCommand then return end
    handledCommand = command.id
    local function ack(result, error)
      write('ack.json', { protocol = 1, id = command.id, sessionId = config.id, result = result, error = error })
    end
    local ok, result = pcall(function()
      assert(command.protocol == 1 and command.sessionId == config.id, 'Invalid session.')
      assert(command.deadline >= os.time() * 1000, 'Command expired.')
      local build = assert(currentBuild(), 'Open a build first.')
      assert(command.expectedBuildKey == buildKey, 'The open build changed.')
      local currentXml = build:SaveDB('Compare')
      assert((command.expectedRevision or revision(command.expectedXml)) == revision(currentXml), 'The build changed during analysis. Run a new analysis.')
      local args = command.args or {}
      if command.name == 'tree' then
        local nodes = {}
        local query = tostring(args.query or ''):lower()
        for id, node in pairs(build.spec.nodes or build.spec.tree.nodes) do
          local allocated = build.spec.allocNodes[id] ~= nil
          if (not args.allocatedOnly or allocated) and (query == '' or (node.name or ''):lower():find(query, 1, true) or table.concat(node.sd or {}, ' '):lower():find(query, 1, true)) then
            local links = {}; for _, other in pairs(node.linked or {}) do links[#links + 1] = type(other) == 'table' and other.id or other end
            nodes[#nodes + 1] = { id = id, name = node.name, type = node.type, stats = node.sd, allocated = allocated, linked = links }
          end
        end
        table.sort(nodes, function(a, b) return tonumber(a.id) < tonumber(b.id) end)
        local total = #nodes
        local limit = math.max(1, math.min(100, math.floor(tonumber(args.limit) or 40)))
        while #nodes > limit do table.remove(nodes) end
        return { nodes = nodes, total = total, treeVersion = build.spec.treeVersion }
      elseif command.name == 'evaluate' then
        local override = { addNodes = {}, removeNodes = {} }
        assert(#(args.addNodes or {}) + #(args.removeNodes or {}) <= 100, 'Maximum 100 nodes per comparison.')
        for _, name in ipairs({ 'addNodes', 'removeNodes' }) do
          for _, id in ipairs(args[name] or {}) do
            local node = assert(build.spec.nodes[tonumber(id)], 'Passive node ID not found: ' .. tostring(id))
            assert(node.type ~= 'Mastery', 'Masteries require an effect selection; this comparison cannot simulate them in isolation.')
            override[name][node] = true
          end
        end
        if args.itemText then
          assert(type(args.itemText) == 'string' and #args.itemText < 30000, 'Invalid item text.')
          assert(build.itemsTab.slots[args.slot], 'Invalid item slot.')
          override.repSlotName = args.slot
          override.repItem = new('Item', args.itemText)
          assert(override.repItem.base, 'Item not recognized by the current PoB.')
        end
        local calculator, base = build.calcsTab.calcs.getMiscCalculator(build)
        base = numericOutput(base)
        local candidate = numericOutput(calculator(override))
        local delta = {}; for key, value in pairs(candidate) do if base[key] then delta[key] = value - base[key] end end
        return { base = base, candidate = candidate, delta = delta, note = 'Real PoB calculation. Does not validate connectivity, point budget or item legality.' }
      elseif command.name == 'apply' then
        assert(type(args.xml) == 'string' and #args.xml < 8000000, 'Invalid XML.')
        assert(not args.xml:find('<!DOCTYPE') and not args.xml:find('<!ENTITY'), 'XML containing external entities is blocked.')
        local parsed, err = common.xml.ParseXML(args.xml)
        assert(not err and parsed and parsed[1] and parsed[1].elem == 'PathOfBuilding', 'Invalid XML: ' .. tostring(err))
        local target
        for _, section in ipairs(parsed[1]) do if type(section) == 'table' and section.elem == 'Build' then target = section.attrib.targetVersion end end
        assert(target == build.targetVersion, 'Target version differs from the current build.')
        local before = assert(build:SaveDB('Recovery'))
        write('recovery.xml', before)
        local fileName, name, importLink, view = build.dbFileName, build.buildName, build.importLink, build.viewMode
        local oldDisable = main.disableDevAutoSave
        main.disableDevAutoSave = true; applying = true
        local applied, failure = pcall(function()
          build.abortSave = true; build:Shutdown()
          build:Init(fileName, name, args.xml, false, importLink)
          assert(build.savers and build.targetVersion == target and not main.newMode, 'Could not initialize the proposed build.')
          build.viewMode = view; build.modFlag = true; build.buildFlag = true
        end)
        if not applied then
          main.newMode = nil
          local restored, restoreError = pcall(function() build.abortSave = true; build:Shutdown(); build:Init(fileName, name, before, false, importLink); build.viewMode = view; build.modFlag = true end)
          applying = false; main.disableDevAutoSave = oldDisable
          assert(restored, 'Manual recovery required: recovery.xml. ' .. tostring(restoreError))
          error('Proposal rejected; build restored: ' .. tostring(failure))
        end
        applying = false; main.disableDevAutoSave = oldDisable
        pendingAck = command
        transaction = { xml = before, fileName = fileName, name = name, importLink = importLink, view = view }
        return { pending = true }
      else error('Command not allowed.') end
    end)
    if not ok then ack(nil, tostring(result)) elseif not result.pending then ack(result) end
  end
  main.Init = function(self, ...)
    originalInit(self, ...)
    local ready, initError = pcall(initializeControls)
    if not ready then host = nil; ConPrintf('PoB Helper disabled: %s', tostring(initError)); return end
    buildKey = instance .. '-0'
    local build = self.modes.BUILD
    local initBuild = build.Init
    build.Init = function(b, ...)
      if not applying then epoch = epoch + 1; buildKey = instance .. '-' .. epoch end
      return initBuild(b, ...)
    end
    local other = read('snapshot.json')
    if other and other.instanceId ~= instance and os.time() * 1000 - (other.timestamp or 0) < 12000 then
      disabled = 'PoB Helper is connected to another PoB window.'
    else
      -- Fixed installer-created script; never constructed from model output.
      os.execute('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "' .. config.startScript .. '" -Session "' .. config.sessionFile .. '"')
    end
  end
  main.OnKeyDown = function(self, key, doubleClick)
    if key == 'F8' then collapsed = not collapsed; return end
    originalKeyDown(self, key, doubleClick)
  end
  main.OnKeyUp = function(self, key) if key ~= 'F8' then originalKeyUp(self, key) end end
  local function panelFrame()
    if GetTime() - clock > 450 then
      syncUi(); clock = GetTime()
      if disabled then
        local owner = read('snapshot.json')
        if not owner or os.time() * 1000 - (owner.timestamp or 0) > 12000 then disabled = nil end
      end
      if not disabled then
        if GetTime() - heartbeatAt > 15000 then
          heartbeatAt = GetTime()
          local heartbeat = read('heartbeat.json')
          if not heartbeat or os.time() * 1000 - (heartbeat.time or 0) > 12000 then
            os.execute('powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File "' .. config.startScript .. '" -Session "' .. config.sessionFile .. '"')
          end
        end
        if GetTime() - lastSnapshotAt > 1200 then snapshot() end
        processCommand()
      end
    end
  end
  local function recover(self, command, failure)
    local recovery = transaction
    transaction = nil; pendingAck = nil
    local oldDisable = main.disableDevAutoSave; main.disableDevAutoSave = true; applying = true
    local restored, restoreError = pcall(function()
      main.newMode = nil
      local build = main.modes.BUILD
      build.abortSave = true; build:Shutdown()
      build:Init(recovery.fileName, recovery.name, recovery.xml, false, recovery.importLink)
      build.viewMode = recovery.view; build.modFlag = true; build.buildFlag = true
      originalFrame(self)
      snapshot()
    end)
    applying = false; main.disableDevAutoSave = oldDisable
    write('ack.json', { protocol = 1, id = command.id, sessionId = config.id, error = restored and ('Proposal rejected; build restored: ' .. tostring(failure)) or ('Manual recovery required: recovery.xml. ' .. tostring(restoreError)) })
    if not restored then error(restoreError) end
  end
  local function addonFrame(self)
    if not host then return originalFrame(self) end
    local fullWidth, fullHeight = GetVirtualScreenSize()
    height = fullHeight
    local narrow = fullWidth < 980 or fullHeight < 620
    local isCollapsed = collapsed or narrow
    width = wide and math.min(760, fullWidth - 620) or math.min(600, math.max(440, math.floor(fullWidth * 0.36)))
    if fullWidth < 980 then width = math.max(320, fullWidth - 620) end
    x = isCollapsed and fullWidth - 108 or fullWidth - width
    local ok, errorMessage = pcall(panelFrame)
    if not ok then ui.status = 'Integration error: ' .. tostring(errorMessage) end
    local view = { x = x, y = 0, width = isCollapsed and 108 or width, height = isCollapsed and 44 or height }
    local cx, cy = GetCursorPos()
    local inPanel = cx >= x and (not isCollapsed or cy <= 44)
    if isCollapsed then host:SelectControl() end
    local events, remaining = {}, {}
    if not self.popups[1] then
      for _, event in ipairs(self.inputEvents) do
        local pointer = event.key and (event.key:find('BUTTON') or event.key:find('WHEEL'))
        local chat = host.controls.conversation
        local chatWheel = pointer and event.key:find('WHEEL') and not advanced and not isCollapsed and cx >= chat.x and cx < chat.x + chat.width and cy >= chat.y and cy < chat.y + chat.height
        if pointer and not inPanel then host:SelectControl() end
        if chatWheel then
          if event.type == 'KeyDown' then host.controls.chatScroll:Scroll(event.key == 'WHEELDOWN' and 1 or -1) end
        elseif inPanel and pointer or host.selControl and not pointer then events[#events + 1] = event else remaining[#remaining + 1] = event end
      end
      host:ProcessControlsInput(events, view)
      self.inputEvents = remaining
    end
    local getSize = GetVirtualScreenSize
    if not isCollapsed then GetVirtualScreenSize = function() return x, fullHeight end end
    local success, frameError = pcall(originalFrame, self)
    GetVirtualScreenSize = getSize -- restored even when PoB raises an error
    if not success and transaction then
      recover(self, pendingAck, frameError)
    elseif not success then error(frameError) end
    if pendingAck then
      local command = pendingAck; pendingAck = nil
      local saved, snapshotError = pcall(snapshot)
      if saved then
        transaction = nil
        write('ack.json', { protocol = 1, id = command.id, sessionId = config.id, result = { applied = true, buildKey = buildKey, committedXml = lastSnapshot.xml, committedRevision = lastSnapshot.revision } })
      else
        recover(self, command, snapshotError)
      end
    end
    SetDrawLayer(90); SetViewport()
    SetDrawColor(0.035, 0.045, 0.06); DrawImage(nil, x, 0, fullWidth - x, isCollapsed and 44 or height)
    SetDrawColor(0.45, 0.34, 0.18); DrawImage(nil, x, 0, 1, isCollapsed and 44 or height)
    if isCollapsed then
      for name, control in pairs(host.controls) do control.shown = name == 'toggle' end
      host.controls.toggle.x = x + 8; host.controls.toggle.width = 92; host.controls.toggle.label = narrow and 'AI (resize)' or 'AI  [F8]'
      host:DrawControls(view); SetDrawLayer(0); return
    end
    SetDrawColor(0.93, 0.81, 0.57); DrawString(x + 18, 14, 'LEFT', 22, 'VAR', 'PoB Assistant')
    SetDrawColor(0.4, 0.76, 0.65); DrawString(fullWidth - 166, 20, 'LEFT', 13, 'VAR', ui.settings.access == 'pob' and 'PoB tools only' or 'Full local access')
    SetDrawColor(0.7, 0.74, 0.8)
    local status = disabled or ui.status or 'Ready'
    local statusLines = wrap(status, width - 48, 15)
    if ui.busy or ui.authPending then SetDrawColor(0.95, 0.72, 0.32) else SetDrawColor(0.35, 0.77, 0.61) end
    DrawImage(nil, x + 18, 53, 6, 6)
    SetDrawColor(0.78, 0.82, 0.87)
    local count = 0; for line in (statusLines .. '\n'):gmatch('(.-)\n') do if count < 2 then DrawString(x + 32, 47 + count * 19, 'LEFT', 15, 'VAR', line) end; count = count + 1 end
    SetDrawColor(0.52, 0.59, 0.67)
    DrawString(x + 18, 89, 'LEFT', 13, 'VAR', display('PoB ' .. tostring(launch.versionNumber) .. '  |  ' .. tostring(currentBuild() and currentBuild().buildName or 'Open a build')))
    for name, control in pairs(host.controls) do
      local configControl = name == 'executable' or name == 'effort' or name == 'research' or name == 'access' or name == 'save' or name == 'login' or name == 'authcheck'
      local chatControl = name == 'conversation' or name == 'chatScroll' or name == 'copy' or name == 'latest' or name == 'wide' or name == 'input' or name == 'send' or name == 'clear' or name == 'apply' or name == 'details' or name == 'undo'
      control.shown = configControl and advanced or not configControl and (not chatControl or not advanced)
      control.enabled = not disabled or name == 'toggle'
    end
    local c = host.controls
    c.toggle.x = fullWidth - 48; c.toggle.width = 32; c.toggle.label = '>'
    c.provider.x = x + 14; c.model.x = x + 140; c.model.width = width - 154
    c.settings.x = x + 14
    c.settings.label = advanced and 'Back to chat' or 'Settings'
    c.wide.x = x + 122; c.wide.label = wide and 'Narrower' or 'Wider'
    c.copy.x = x + 212; c.latest.x = x + 326
    c.copy.label = showDetails and ui.proposal and 'Copy changes' or 'Copy reply'
    c.customModel.x = x + 124; c.customModel.width = width - 138
    local modelOption = c.model.list[c.model.selIndex]
    c.customModel.shown = modelOption and modelOption.custom or false
    if c.customModel.shown then c.wide.shown = false; c.copy.shown = false; c.latest.shown = false end
    c.provider.enabled = not ui.busy and not ui.authPending and not disabled
    c.model.enabled = c.provider.enabled; c.customModel.enabled = c.provider.enabled
    local proposalBar = ui.proposal ~= nil or ui.canUndo
    c.input.x = x + 14; c.input.y = height - 140; c.input.width = width - 28
    c.send.x = x + 14; c.send.y = height - 43; c.send.enabled = not ui.busy and not disabled
    c.cancel.x = x + 124; c.cancel.y = height - 43; c.cancel.enabled = ui.busy or ui.authPending
    c.clear.x = fullWidth - 118; c.clear.y = height - 43
    c.clear.enabled = not ui.busy and not ui.authPending and not disabled and (#(ui.messages or {}) > 0 or ui.proposal ~= nil or c.input.buf ~= '')
    c.apply.x = x + 14; c.apply.y = height - 204; c.apply.enabled = ui.proposal ~= nil and not ui.busy and not disabled
    c.details.x = x + 184; c.details.y = height - 204; c.details.label = showDetails and 'Summary' or 'Details'
    c.undo.x = x + 284; c.undo.y = height - 204; c.undo.enabled = ui.canUndo and not ui.busy and not disabled
    c.apply.shown = not advanced and ui.proposal ~= nil; c.details.shown = c.apply.shown
    c.undo.shown = not advanced and ui.canUndo or false
    c.conversation.x = x + 14; c.conversation.width = width - 28
    c.conversation.height = math.max(70, c.input.y - c.conversation.y - (proposalBar and 82 or 38))
    c.chatScroll.x = fullWidth - 30; c.chatScroll.height = c.conversation.height
    c.executable.x = x + 14; c.executable.width = width - 28
    c.effort.x = x + 14; c.research.x = x + 14; c.research.width = width - 28; c.access.x = x + 14; c.access.width = width - 28; c.save.x = x + 14
    c.login.x = x + 14; c.authcheck.x = x + 158
    c.login.enabled = not ui.busy and not ui.authPending and not disabled
    c.authcheck.enabled = not ui.busy and not ui.authPending and not disabled
    updateConversation()
    if c.customModel.shown then c.latest.shown = false end
    local hasReply = false
    for _, message in ipairs(ui.messages or {}) do if message.role == 'assistant' then hasReply = true end end
    c.copy.enabled = (hasReply or showDetails and ui.proposal ~= nil) and not disabled
    if not advanced then
      SetDrawColor(0.68, 0.74, 0.82)
      DrawString(x + 16, c.input.y - 23, 'LEFT', 14, 'VAR', 'Message')
      DrawString(fullWidth - 16, c.input.y - 23, 'RIGHT', 13, 'VAR', 'Ctrl+Enter to send')
      SetDrawColor(0.18, 0.22, 0.28); DrawImage(nil, x + 14, c.input.y - 31, width - 28, 1)
    end
    if advanced then
      SetDrawColor(0.7, 0.74, 0.8)
      DrawString(x + 14, 187, 'LEFT', 15, 'VAR', 'CLI path (optional)')
      DrawString(x + 14, 251, 'LEFT', 15, 'VAR', 'Reasoning effort')
      DrawString(x + 14, 315, 'LEFT', 15, 'VAR', 'Current sources')
      DrawString(x + 14, 379, 'LEFT', 15, 'VAR', 'Agent access')
      local selectedProvider = c.provider.selIndex == 2 and 'claude' or 'codex'
      local authText = ui.authPending and 'Complete sign-in in your browser.' or ui.auth and ui.auth.provider == selectedProvider and (ui.auth.signedIn and 'Signed in through your CLI.' or 'Not signed in.') or 'Login status not checked.'
      DrawString(x + 14, 533, 'LEFT', 14, 'VAR', authText)
    end
    host:DrawControls(view)
    if self.popups[1] then SetDrawColor(0, 0, 0, 0.6); DrawImage(nil, x, 0, width, height) end
    SetDrawLayer(0)
  end
  main.OnFrame = function(self)
    if not host then return originalFrame(self) end
    local ok, failure = pcall(addonFrame, self)
    if not ok then
      host = nil
      pcall(write, 'addon-error.log', tostring(failure))
      ConPrintf('PoB Helper disabled: %s', tostring(failure))
    end
  end
  local originalShutdown = main.Shutdown
  main.Shutdown = function(self, ...)
    local state = read('snapshot.json')
    if state and state.instanceId == instance then pcall(write, 'snapshot.json', { sessionId = config.id, instanceId = instance, timestamp = 0, mode = 'CLOSED' }) end
    if originalShutdown then return originalShutdown(self, ...) end
  end
end
