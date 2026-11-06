"use client";
import {useEffect,useState} from 'react';
export default function HandoffOwnerLogin(){
 const [enabled,setEnabled]=useState<boolean|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>{fetch('/api/handoff/login',{cache:'no-store'}).then(r=>r.json()).then(d=>setEnabled(d.enabled===true)).catch(()=>setError('登录入口读取失败，请刷新重试'));},[]);
 async function login(){setBusy(true);setError('');try{const response=await fetch('/api/handoff/login',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}),data=await response.json();if(!response.ok)throw new Error(data.error||'登录未完成');location.href='/';}catch(e){setError(e instanceof Error?e.message:'登录未完成，请重试');setBusy(false);}}
 return <main style={{maxWidth:540,margin:'60px auto',padding:24,fontFamily:'sans-serif',lineHeight:1.8}}><h1>老板首次登录</h1><p>使用拥有本网站的 ChatGPT 账号进入仓库系统。原仓库数据会完整保留。</p>{enabled===false?<p>请让部署助手先设置本站所有者登录配置。</p>:<><p><a href="/signin-with-chatgpt?return_to=%2Fhandoff" target="_top">先登录本站所有者的 ChatGPT 账号</a></p><button disabled={busy||enabled!==true} onClick={()=>void login()} style={{padding:'12px 24px',fontSize:18}}>进入老板账号</button><p>首次进入后，请由老板本人设置仓库登录密码。</p></>}{error&&<p role="alert">{error}</p>}</main>;
}
