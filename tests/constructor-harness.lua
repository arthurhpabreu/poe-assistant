-- Model the three upstream construction contracts, with guarded allocation
-- reproducing the reported error. Native checks use pinned upstream sources.
return function(protocol, create)
  common.classes = {}
  local counts, loads = {}, {}
  LoadModule = function(file)
    local kind = assert(file:match('^Classes/(.+)$'))
    loads[kind] = (loads[kind] or 0) + 1
    local class = { _className = kind }
    local constructor = function(self, ...)
      counts[kind] = (counts[kind] or 0) + 1
      for key, value in pairs(create(kind, ...)) do self[key] = value end
      return self
    end
    class.__index = class
    if protocol == 'automatic' then class._constructor = constructor
    else
      class[kind] = constructor
      if protocol == 'guarded' then
        class._unconstructedMeta = { __index = function(object, key)
          if key == kind then setmetatable(object, class); return class[kind] end
          error("Object of class '" .. kind .. "' was used before it was constructed (accessed '" .. tostring(key) .. "').")
        end }
      end
    end
    common.classes[kind] = class
  end
  new = function(kind, ...)
    local class = assert(common.classes[kind], 'Class was not loaded')
    if protocol ~= 'automatic' then assert(select('#', ...) == 0, 'Constructor arguments passed to allocation') end
    local object = setmetatable({}, class._unconstructedMeta or class)
    object.Object = object
    if protocol == 'automatic' then class._constructor(object, ...) end
    return object
  end
  return counts, loads
end
