-- Read-only access to the CURRENT PoB data and calculator. No generated Lua.
local lab = {}
local nativeNew = new
-- PoB supports both automatic constructors and explicit :ClassName(...)
-- constructors. Keep compatibility local to the addon; never replace globals
-- or retry a constructor that has already started running.
function lab.new(className, ...)
  local classes = assert(common and common.classes, 'PoB class registry is unavailable.')
  if not classes[className] then LoadModule('Classes/' .. className) end
  local class = assert(classes[className], 'PoB class is unavailable: ' .. className)
  if rawget(class, '_unconstructedMeta') or not rawget(class, '_constructor') and type(rawget(class, className)) == 'function' then
    local object = nativeNew(className)
    local constructor = object[className] -- transitions PoB's unconstructed guard
    assert(type(constructor) == 'function', 'PoB constructor is unavailable: ' .. className)
    constructor(object, ...)
    return object
  end
  assert(type(rawget(class, '_constructor')) == 'function', 'Unsupported PoB constructor: ' .. className)
  return nativeNew(className, ...)
end
local new = lab.new
local function scalar(value, depth, seen)
  if type(value) == 'number' then return value == value and value ~= math.huge and value ~= -math.huge and value or nil end
  if type(value) == 'string' or type(value) == 'boolean' then return value end
  if type(value) ~= 'table' or (depth or 0) <= 0 then return nil end
  seen = seen or {}; if seen[value] then return nil end; seen[value] = true
  local out, count = {}, 0
  for k, v in pairs(value) do
    if type(k) == 'string' or type(k) == 'number' then
      local child = scalar(v, depth - 1, seen)
      if child ~= nil then out[k] = child; count = count + 1 end
      if count >= 250 then out._truncated = true; break end
    end
  end
  seen[value] = nil; return out
end
lab.scalar = scalar

local function legacy(name) return tostring(name or ''):lower():find('legacy') or tostring(name or ''):lower():find('pre[%s%-]') or tostring(name or ''):lower():find('before ') end
local function currentUnique(raw, args)
  local item = new('Item', raw, 'UNIQUE')
  assert(item.base and not item.unreleased, 'Unique is not released/recognized.')
  if item.versionList then item.selectedVersion = #item.versionList end
  if item.usesVariantGroups then
    for key, selection in pairs(args.variants or {}) do
      local id = assert(tonumber(key), 'Invalid variant group.')
      assert(item:IsVariantGroupOptionEligible(id, selection) and not legacy(item.variantList[selection]), 'Legacy or ineligible variant is blocked.')
      item.variantGroupSelections[id] = selection
    end
    item:NormaliseVariantSelections()
  elseif item.variantList then
    if args.variant then item.variant = tonumber(args.variant) end
    assert(item.variant and item.variantList[item.variant] and not legacy(item.variantList[item.variant]), 'Legacy variant is blocked.')
  end
  return item
end
local function materialize(item)
  local keep = {}
  for _, field in ipairs({ 'enchantModLines', 'scourgeModLines', 'implicitModLines', 'explicitModLines', 'crucibleModLines', 'classRequirementModLines' }) do
    keep[field] = item[field]; local selected = {}
    for _, line in ipairs(item[field] or {}) do
      if item:CheckModLineVariant(line) then
        local copy = {}; for k,v in pairs(line) do copy[k] = v end
        copy.versionList = nil; copy.variantList = nil; copy.variantGroupList = nil
        selected[#selected + 1] = copy
      end
    end
    item[field] = selected
  end
  local versions, variants = item.versionList, item.variantList
  item.versionList = nil; item.variantList = nil
  local text = item:BuildRaw()
  item.versionList = versions; item.variantList = variants
  for field, value in pairs(keep) do item[field] = value end
  return text
end

local function modShape(line)
  local ranges = {}
  local text = line:gsub('{[^}]*}', ''):lower()
  local shape, position = {}, 1
  while position <= #text do
    local rs, re, low, high = text:find('%((%-?[%d%.]+)%-(%-?[%d%.]+)%)', position)
    local ns, ne = text:find('%-?%d+%.?%d*', position)
    if rs and (not ns or rs < ns) then
      shape[#shape + 1] = text:sub(position,rs - 1) .. '@'; ranges[#ranges + 1] = {tonumber(low),tonumber(high)}; position = re + 1
    elseif ns then
      shape[#shape + 1] = text:sub(position,ns - 1) .. '@'; local value = tonumber(text:sub(ns,ne)); ranges[#ranges + 1] = {value,value}; position = ne + 1
    else shape[#shape + 1] = text:sub(position); break end
  end
  return table.concat(shape), ranges
end
local function verifyUnique(item, raw)
  local reference = currentUnique(raw, { variants = item.variantGroupSelections, variant = item.variant })
  if item.quality and (item.quality ~= item.quality or item.quality < 0 or item.quality > 30) then return false, 'Invalid unique quality: ' .. item.name end
  if item.catalystQuality and (item.catalystQuality ~= item.catalystQuality or item.catalystQuality < 0 or item.catalystQuality > 20) then return false, 'Invalid unique catalyst quality: ' .. item.name end
  if item.baseName ~= reference.baseName then return false, 'Unique base does not match current database: ' .. item.name end
  if item.versionList and item.selectedVersion ~= #item.versionList then return false, 'Legacy unique version is blocked: ' .. item.name end
  for _, field in ipairs({ 'explicitModLines', 'implicitModLines', 'enchantModLines', 'scourgeModLines', 'crucibleModLines' }) do
    local templates = {}
    for _, line in ipairs(reference[field] or {}) do if reference:CheckModLineVariant(line) then
      local shape, ranges = modShape(line.line); templates[shape] = templates[shape] or {}; table.insert(templates[shape], ranges)
    end end
    for _, line in ipairs(item[field] or {}) do if item:CheckModLineVariant(line) then
      if line.range and (type(line.range) ~= 'number' or line.range ~= line.range or line.range < 0 or line.range > 1) then return false, 'Invalid unique roll range: ' .. item.name end
      if line.corruptedRange then return false, 'Unique corrupted scaling requires separate validation: ' .. item.name end
      local shape, ranges = modShape(line.line); local matched
      for index, expected in ipairs(templates[shape] or {}) do
        local valid = #ranges == #expected
        for i, range in ipairs(ranges) do if not expected[i] or range[1] < math.min(unpack(expected[i])) or range[2] > math.max(unpack(expected[i])) then valid = false end end
        if valid then matched = true; table.remove(templates[shape], index); break end
      end
      if not matched then return false, 'Unique modifier does not match current database (extra implicits/enchants need separate validation): ' .. item.name .. ': ' .. line.line end
    end end
    for _, remaining in pairs(templates) do if #remaining > 0 then return false, 'Current unique modifier is missing: ' .. item.name end end
  end
  return true
end

function lab.catalog(build, args)
  local query = tostring(args.query or ''):lower()
  assert(#query <= 180, 'Search query is too long.')
  local offset = math.max(0, math.floor(tonumber(args.offset) or 0))
  local limit = math.max(1, math.min(args.details and 5 or 40, math.floor(tonumber(args.limit) or 15)))
  local matches = {}
  local function match(name, text)
    return args.exact and name:lower() == query or not args.exact and (name .. ' ' .. text):lower():find(query, 1, true)
  end
  if args.kind == 'unique' then
    for category, list in pairs(build.data.uniques) do
      for _, raw in pairs(list) do
        local name = raw:match('^([^\r\n]+)') or ''
        if match(name, raw) then matches[#matches + 1] = { name = name, category = category, raw = raw } end
      end
    end
  elseif args.kind == 'skill' then
    for id, gem in pairs(build.data.gems) do
      local effect = build.data.skills[gem.grantedEffectId] or {}
      local name = gem.name or effect.name or id
      if match(name, effect.description or '') then matches[#matches + 1] = { name = name, id = id, gem = gem, effect = effect } end
    end
  else error('Catalog kind must be skill or unique.') end
  table.sort(matches, function(a,b) if a.name == b.name then return tostring(a.id or a.category) < tostring(b.id or b.category) end; return a.name < b.name end)
  local results = {}
  for i = offset + 1, math.min(#matches, offset + limit) do
    local entry = matches[i]
    if args.kind == 'unique' then
      local ok, item = pcall(currentUnique, entry.raw, args)
      if not ok and args.exact then error(item) end
      if ok then
      local groups = {}
      local variants = {}
      for groupId in pairs(item.variantGroups or {}) do
        local options = {}; for _, id in ipairs(item:GetVariantGroupOptions(groupId, false)) do if not legacy(item.variantList[id]) then options[#options + 1] = id; variants[tostring(id)] = item.variantList[id] end end
        groups[tostring(groupId)] = options
      end
      if not item.usesVariantGroups then for id, name in ipairs(item.variantList or {}) do if not legacy(name) then variants[tostring(id)] = name end end end
      results[#results + 1] = { name = entry.name, category = entry.category, base = item.baseName, currentVersion = item.versionList and item.versionList[#item.versionList],
        variants = variants, eligibleVariantGroups = groups, selectedVariants = scalar(item.variantGroupSelections, 2),
        itemText = args.details and materialize(item) or nil,
        note = 'Current installed PoB unique version only. Legacy variants are excluded. Drop availability and price require current-league evidence.' }
      end
    else
      local effect, gem = entry.effect, entry.gem
      results[#results + 1] = { id = entry.id, name = entry.name, grantedEffectId = gem.grantedEffectId, tags = scalar(gem.tags, 2),
        details = args.details and { gem = scalar(gem, 3), description = effect.description, castTime = effect.castTime,
          baseFlags = scalar(effect.baseFlags, 2), skillTypes = scalar(effect.skillTypes, 2), stats = scalar(effect.stats, 2),
          constantStats = scalar(effect.constantStats, 3), qualityStats = scalar(effect.qualityStats, 3),
          levels = { ['1'] = scalar((effect.levels or {})[1], 3), ['20'] = scalar((effect.levels or {})[20], 3), ['21'] = scalar((effect.levels or {})[21], 3) } } or nil }
    end
  end
  return { kind = args.kind, query = query, results = results, total = #matches, nextOffset = offset + limit < #matches and offset + limit or nil, source = 'current installed PoB data', targetVersion = build.targetVersion }
end

function lab.calcs(build, args)
  local env = assert(build.calcsTab.mainEnv, 'Calculator is not ready.')
  local actor = args.actor == 'minion' and assert(env.minion, 'No minion calculator.') or env.player
  local stats = args.stats or { 'FullDPS', 'TotalDPS', 'Life', 'ManaUnreserved', 'TotalEHP', 'FireResist', 'ColdResist', 'LightningResist', 'ChaosResist' }
  assert(#stats <= 12, 'Inspect at most 12 stats per call.')
  local results = {}
  for _, stat in ipairs(stats) do
    assert(type(stat) == 'string' and #stat < 100, 'Invalid stat.')
    results[stat] = { value = scalar(actor.output[stat], 3), breakdown = scalar((actor.breakdown or {})[stat], 5) }
  end
  local skills = {}
  for _, skill in ipairs(actor.activeSkillList or {}) do
    local effect = skill.activeEffect and skill.activeEffect.grantedEffect or {}
    skills[#skills + 1] = { name = effect.name, id = effect.id, flags = scalar(skill.skillFlags, 2), skillData = scalar(skill.skillData, 2) }
    if #skills >= 25 then break end
  end
  return { stats = results, activeSkills = skills, conditions = scalar(build.configTab.input, 2), source = 'live PoB main calculation' }
end

function lab.report(build)
  -- Init calculates before PoB's automatic level estimate. Settle that estimate
  -- and recalculate exactly as the first live frame does before reading output.
  local settled = false
  for _ = 1, 3 do
    if build.EstimatePlayerProgress then build:EstimatePlayerProgress() end
    local level = build.characterLevel
    wipeGlobalCache()
    build.outputRevision = (build.outputRevision or 0) + 1
    build.skillsTab:UpdateSocketGroups()
    build.calcsTab:BuildOutput()
    build:RefreshStatList() -- warnings and final automatic estimate use NEW output
    if build.characterLevel == level then settled = true; break end
  end
  assert(settled, 'Automatic level calculation did not converge; candidate rejected.')
  local output = {}
  for key, value in pairs(build.calcsTab.mainOutput) do if type(value) == 'number' and value == value and value ~= math.huge and value ~= -math.huge then output[key] = value end end
  local warnings = {}
  for _, warning in pairs(build.controls.warnings.lines or {}) do warnings[#warnings + 1] = warning:gsub('%^%d', '') end
  local normal, ascendancy, secondary = build.spec:CountAllocNodes()
  local errors, disconnected = {}, {}
  local available = build.characterLevel - 1 + 23 + (output.ExtraPoints or 0)
  if normal > available then errors[#errors + 1] = 'Passive points exceed the level budget including all campaign quests.' end
  if ascendancy > 8 or secondary > 8 then errors[#errors + 1] = 'Ascendancy point budget exceeded.' end
  for id, node in pairs(build.spec.allocNodes) do
    if node.type ~= 'ClassStart' and node.type ~= 'AscendClassStart' and not node.connectedToStart and #(node.intuitiveLeapLikesAffecting or {}) == 0 then disconnected[#disconnected + 1] = id end
  end
  if #disconnected > 0 then errors[#errors + 1] = 'Disconnected allocated passives: ' .. table.concat(disconnected, ',') end
  for _, warning in ipairs(warnings) do if warning:find('do not meet') or warning:find('too many') or warning:find('exceeding') then errors[#errors + 1] = warning end end
  local uniqueRaw = {}
  for _, list in pairs(build.data.uniques) do for _, raw in pairs(list) do uniqueRaw[raw:match('^([^\r\n]+)')] = raw end end
  local items, gems = {}, {}
  for id, item in pairs(build.itemsTab.items or {}) do
    local verified, reason
    local itemName = item.title or item.name
    if item.rarity == 'UNIQUE' then
      if not uniqueRaw[itemName] then verified = false; reason = 'Unique not found in current data: ' .. itemName
      else local ok; ok, verified, reason = pcall(verifyUnique, item, uniqueRaw[itemName]); if not ok then reason = tostring(verified); verified = false end end
      if not verified then errors[#errors + 1] = reason end
    end
    if not item.base then errors[#errors + 1] = 'Unrecognized item: ' .. tostring(item.name) end
    items[#items + 1] = { id = id, name = itemName, base = item.baseName, rarity = item.rarity,
      selectedVariants = scalar(item.variantGroupSelections, 2), recognized = item.base ~= nil, currentUniqueVerified = verified, uniqueIssue = reason }
  end
  for _, group in ipairs(build.skillsTab.socketGroupList or {}) do
    for _, gem in ipairs(group.gemList or {}) do
      gems[#gems + 1] = { name = gem.nameSpec, id = gem.gemId, recognized = gem.gemData ~= nil, enabled = gem.enabled, level = gem.level, quality = gem.quality }
      if gem.enabled and not gem.gemData then errors[#errors + 1] = 'Unrecognized enabled gem: ' .. tostring(gem.nameSpec) end
    end
  end
  return { output = output, warnings = warnings, points = { normal = normal, ascendancy = ascendancy, secondary = secondary },
    level = build.characterLevel, treeVersion = build.spec.treeVersion, conditions = scalar(build.configTab.input, 2), items = items, gems = gems,
    calcs = lab.calcs(build, {}), validation = { errors = errors, disconnected = disconnected, passiveBudget = available }, note = 'Actual PoB calculation. Warnings and data recognition are checks, not proof of market availability or every in-game interaction.' }
end
return lab
