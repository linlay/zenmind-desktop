import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=fs.readFileSync(new URL('../src/renderer/pages/functional-market/marketPageModel.ts',import.meta.url),'utf8');
const module={exports:{}};
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(compiled,{module,exports:module.exports});
const {parseMarketTab,DEFAULT_MARKET_TAB,getMarketTabDefinitions}=module.exports;
test('market query entry uses the same visible categories as the Desktop market navigation',()=>{
 const visible=getMarketTabDefinitions(key=>key).map(item=>item.id);
 assert.deepEqual([...visible],['skills','mcps','websiteApps','pets','skins']);
 for(const tab of visible)assert.equal(parseMarketTab(tab),tab);
 for(const tab of ['plugins','agents','sandboxImages','cli','softwarePackages','unknown','',null,undefined,{}])assert.equal(parseMarketTab(tab),DEFAULT_MARKET_TAB);
});
