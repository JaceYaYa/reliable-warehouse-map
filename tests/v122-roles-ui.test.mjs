import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
const require=createRequire(import.meta.url),cache=new Map();
function load(file){if(cache.has(file))return cache.get(file);const exports={};cache.set(file,exports);const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;const localRequire=s=>{if(!s.startsWith('.'))return require(s);let path=resolve(dirname(file),s);if(!existsSync(path))path+=existsSync(path+'.tsx')?'.tsx':'.ts';return load(path)};runInNewContext(code,{exports,require:localRequire,console});return exports;}
const {AccountManager}=load(resolve('components/AccountManager.tsx'));
test('boss account screen creates employee/admin roles with no granular or boss assignment control',()=>{const html=renderToStaticMarkup(React.createElement(AccountManager,{viewer:{id:1,username:'boss',role:'admin'},onClose:()=>{}}));assert.match(html,/<select[^>]*aria-label="新增账号角色"/);assert.match(html,/<option value="employee"[^>]*>员工/);assert.match(html,/<option value="admin"[^>]*>管理员/);assert.doesNotMatch(html,/type="checkbox"|value="boss"|按勾选授权/);assert.match(html,/员工只读/);});
test('nonboss account screen exposes no account writes even with forged old saved grants',()=>{for(const role of ['admin','employee','warehouse']){const html=renderToStaticMarkup(React.createElement(AccountManager,{viewer:{id:2,username:'user2',role,permissions:['users.manage']},onClose:()=>{}}));assert.doesNotMatch(html,/创建账号|新增账号|设置角色/);}});

test('xmcxmc has the owner account interface while assignment remains employee/admin only',()=>{const html=renderToStaticMarkup(React.createElement(AccountManager,{viewer:{id:52,username:'xmcxmc',role:'admin',permissions:[]},onClose:()=>{}}));assert.match(html,/创建账号/);assert.match(html,/新增账号角色/);assert.doesNotMatch(html,/value="boss"|type="checkbox"/);});
