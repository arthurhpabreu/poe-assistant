import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fengari from 'fengari';

function lua(source) {
  const L=fengari.lauxlib.luaL_newstate();fengari.lualib.luaL_openlibs(L);
  try {
    const code=fengari.lauxlib.luaL_dostring(L,fengari.to_luastring(source));
    assert.equal(code,0,code ? fengari.to_jsstring(fengari.lua.lua_tostring(L,-1)) : '');
  } finally { fengari.lua.lua_close(L); }
}

for(const protocol of ['automatic','guarded','explicit']) test(`addon constructors preserve arguments and initialize exactly once: ${protocol}`,async()=>{
  const lab=await fs.readFile('addon/BuildLab.lua','utf8'),contract=await fs.readFile('tests/constructor-harness.lua','utf8');
  lua(`
common={}
local configure=(function() ${contract} end)()
local attempts=0
local counts,loads=configure('${protocol}',function(kind,...)
 attempts=attempts+1
 if kind=='Broken' then error('Original constructor failure') end
 return {args={...},count=select('#',...),controls=kind=='ControlHost' and {} or nil}
end)
local originalNew=new
local lab=(function() ${lab} end)()
if '${protocol}'=='guarded' then
 LoadModule('Classes/ControlHost')
 local broken=new('ControlHost')
 local ok,problem=pcall(function() return broken.controls end)
 assert(not ok and problem:find('used before it was constructed'), 'Baseline did not reproduce the remote error')
end
local host=lab.new('ControlHost');assert(type(host.controls)=='table')
for _,kind in ipairs({'Control','ButtonControl','DropDownControl','EditControl','ScrollBarControl','Item'}) do
 local item=lab.new(kind,nil,{0,0,100,20},'fixture',nil)
 assert(item.count==4 and item.args[1]==nil and item.args[2][3]==100 and item.args[3]=='fixture' and item.args[4]==nil)
 assert(counts[kind]==1 and loads[kind]==1)
end
local before=attempts
local ok,problem=pcall(lab.new,'Broken','value')
assert(not ok and problem:find('Original constructor failure') and attempts==before+1, 'Constructor failure was retried or hidden')
assert(new==originalNew, 'Addon replaced the global allocator')
`);
});

for(const protocol of ['automatic','guarded']) test(`complete sidebar and native transactions use the local constructor adapter: ${protocol}`,async()=>{
  const [sidebar,lab,contract,harness]=await Promise.all(['addon/PobHelper.lua','addon/BuildLab.lua','tests/constructor-harness.lua','tests/native-harness.lua'].map(file=>fs.readFile(file,'utf8')));
  lua(`
constructorProtocol='${protocol}'
configureConstructorProtocol=(function() ${contract} end)()
loadConstructorLab=function() ${lab} end
addon=(function() ${sidebar} end)()
${harness}
`);
});
