/**
 * 카카오톡 알림 연결 도우미  ·  Cloudflare Pages Function
 *
 * 경로: /kakao
 *
 * 카카오 '나에게 보내기'를 쓰려면 리프레시 토큰이 하나 필요하다.
 * 그걸 받아 내는 과정이 번거로워서, 버튼 한 번으로 끝나게 만든 페이지다.
 *
 * 받은 토큰은 Cloudflare 저장소(KV, 이름 FLOW)에 바로 넣는다. 화면에는 띄우지 않는다.
 * 예약 실행기(worker/cron.js)가 거기서 꺼내 쓰고, 만료가 다가오면 알아서 새 토큰으로 바꾼다.
 * 저장이 끝나면 곧바로 시험 메시지를 한 통 보내서, 연결이 됐는지 형 폰으로 바로 확인하게 한다.
 */

const PAGE = (origin) => `<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>카카오톡 알림 연결</title>
<style>
:root{--bg:#FAF9F6;--t1:#1F1F1F;--t2:#5C5B55;--t3:#9B9891;--line:#E6E2DA;
  --gold:#D4AF7C;--surface:#fff;--soft:#F5F3EF}
@media (prefers-color-scheme:dark){:root{--bg:#0E0E0D;--t1:#F3F1EC;--t2:#A8A49C;--t3:#75726A;
  --line:#2A2A26;--surface:#1A1A18;--soft:#1F1F1C}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--t1);line-height:1.6;word-break:keep-all;
  font-family:Pretendard,"IBM Plex Sans KR",-apple-system,BlinkMacSystemFont,"Apple SD Gothic Neo",sans-serif}
.w{max-width:560px;margin:0 auto;padding:36px 20px 80px}
h1{font-size:22px;margin:0 0 6px;letter-spacing:-.02em}
.sub{color:var(--t2);font-size:14px;margin-bottom:26px}
.card{background:var(--soft);border-radius:14px;padding:18px;margin-bottom:14px}
.card h2{font-size:15px;margin:0 0 10px}
ol{margin:0;padding-left:18px}
li{margin-bottom:9px;font-size:14px;color:var(--t2)}
li b{color:var(--t1)}
code{background:var(--surface);border:1px solid var(--line);border-radius:6px;
  padding:2px 6px;font-size:13px;word-break:break-all}
input{width:100%;padding:13px 14px;border:1px solid var(--line);border-radius:11px;
  background:var(--surface);color:var(--t1);font:500 14px/1.3 inherit;margin-top:8px}
button{width:100%;padding:15px;border:0;border-radius:12px;background:#1F1F1F;color:#FAF9F6;
  font:700 15px/1 inherit;cursor:pointer;margin-top:12px}
button.ghost{background:var(--surface);color:var(--t1);border:1px solid var(--line);margin-top:8px}
.tok{background:var(--surface);border:1px solid var(--line);border-radius:11px;padding:13px;
  font:500 13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;margin-top:8px}
.lbl{font-size:12px;font-weight:700;color:var(--t3);letter-spacing:.04em;margin-top:14px}
.warn{font-size:13px;color:var(--t2);margin-top:14px}
.err{background:#FCEDEC;color:#B4322F;border-radius:11px;padding:13px;font-size:14px;margin-top:12px}
@media (prefers-color-scheme:dark){.err{background:#2A1817;color:#F0696A}}
.ok{color:#2E8B62;font-weight:700}
</style></head><body><div class="w">
<h1>카카오톡 알림 연결</h1>
<div class="sub">개장 전과 마감 뒤에 섹터 흐름 요약을 카카오톡 '나와의 채팅'으로 받습니다.</div>

<div class="card">
  <h2>먼저 카카오에서 앱을 하나 만드세요</h2>
  <ol>
    <li><b>developers.kakao.com</b> 접속 후 카카오 계정으로 로그인</li>
    <li>내 애플리케이션 → <b>애플리케이션 추가하기</b>. 앱 이름은 아무거나</li>
    <li>앱 설정 → <b>플랫폼</b> → Web 플랫폼 등록 →<br><code>${origin}</code></li>
    <li>제품 설정 → 카카오 로그인 → <b>활성화 ON</b></li>
    <li>같은 화면 아래 <b>Redirect URI 등록</b> →<br><code>${origin}/kakao</code></li>
    <li>제품 설정 → 카카오 로그인 → 동의항목 →<br><b>카카오톡 메시지 전송</b>을 찾아 선택 동의로 설정</li>
    <li>앱 설정 → 앱 키 → <b>REST API 키</b> 복사</li>
  </ol>
  <div class="warn">메뉴 이름은 카카오가 가끔 바꿉니다. 비슷한 이름을 찾으면 됩니다.</div>
</div>

<div class="card">
  <h2>복사한 REST API 키를 넣으세요</h2>
  <input id="key" placeholder="REST API 키" autocomplete="off" spellcheck="false">
  <input id="sec" placeholder="Client Secret (카카오가 요구할 때만)" autocomplete="off" spellcheck="false" style="display:none">
  <button id="go">카카오 로그인하고 연결하기</button>
  <div class="warn">연결하면 알림용 토큰이 이 사이트의 저장소에 보관됩니다. 화면에도 채팅에도 띄우지 않습니다.</div>
</div>

<div id="out"></div>
</div>
<script>
const KEY='lucent.kakao.key', SEC='lucent.kakao.sec';
const el=(s)=>document.querySelector(s);
const q=new URLSearchParams(location.search);
const origin=location.origin;
const ls={get:k=>{try{return localStorage.getItem(k)}catch(e){return null}},
  set:(k,v)=>{try{v?localStorage.setItem(k,v):localStorage.removeItem(k)}catch(e){}}};

el('#key').value=ls.get(KEY)||'';
if(ls.get(SEC)){ el('#sec').value=ls.get(SEC); el('#sec').style.display='block'; }
el('#go').onclick=()=>{
  const k=el('#key').value.trim();
  if(!k){ el('#key').focus(); return; }
  ls.set(KEY,k); ls.set(SEC,el('#sec').value.trim());
  const u='https://kauth.kakao.com/oauth/authorize?response_type=code'
    +'&client_id='+encodeURIComponent(k)
    +'&redirect_uri='+encodeURIComponent(origin+'/kakao')
    +'&scope=talk_message';
  location.href=u;
};

function show(html){ el('#out').innerHTML=html; }

(async()=>{
  const err=q.get('error');
  if(err){ show('<div class="err"><b>카카오가 거절했습니다.</b><br>'+err
    +'<br>'+(q.get('error_description')||'')
    +'<br><br>동의항목에서 <b>카카오톡 메시지 전송</b>이 켜져 있는지, Redirect URI 가 정확한지 확인하세요.</div>'); return; }
  const code=q.get('code');
  if(!code) return;
  const k=ls.get(KEY), sec=ls.get(SEC)||'';
  if(!k){ show('<div class="err">REST API 키가 없습니다. 이 페이지에서 키를 넣고 다시 시작하세요.</div>'); return; }
  history.replaceState(null,'',location.pathname);
  show('<div class="card">연결하는 중입니다.</div>');
  try{
    const r=await fetch('/kakao',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({code,key:k,secret:sec,redirect:origin+'/kakao'})});
    const j=await r.json();
    if(!r.ok||j.error){
      const msg=String(j.error_description||j.error||('HTTP '+r.status));
      if(/KOE010|client_secret|invalid_client/i.test(msg+' '+(j.error_code||''))){
        el('#sec').style.display='block';
        throw new Error('이 카카오 앱은 Client Secret 을 요구합니다. 앱 설정 → 보안(또는 앱 키)에서 Client Secret 코드를 복사해 위 두 번째 칸에 넣고, 버튼을 다시 누르세요.');
      }
      throw new Error(msg);
    }
    if(j.saved){
      show('<div class="card"><h2 class="ok">연결됐습니다</h2>'
        +'<div class="warn" style="margin-top:4px">'+(j.test==='ok'
          ?'카카오톡 <b>나와의 채팅</b>에 시험 메시지를 한 통 보냈습니다. 확인해 보세요.'
          :'연결은 됐는데 시험 메시지가 안 갔습니다. 동의항목에서 <b>카카오톡 메시지 전송</b>이 켜져 있는지 확인하세요.<br>'+String(j.test||''))
        +'<br><br>이제 평일 <b>08:37</b> 개장 전, <b>15:37</b> 마감 뒤에 요약이 옵니다. 휴장일에는 쉽니다.'
        +'<br>토큰은 두 달마다 만료되는데, 그 전에 알아서 새것으로 바꿉니다. 더 하실 일은 없습니다.</div></div>');
      return;
    }
    // 저장소가 아직 연결되지 않은 경우에만 예전 방식으로 값을 보여준다
    show('<div class="card"><h2 class="ok">받았습니다</h2>'
      +'<div class="lbl">KAKAO_REST_KEY</div><div class="tok" id="t1"></div>'
      +'<button class="ghost" data-c="t1">이 값 복사</button>'
      +'<div class="lbl">KAKAO_REFRESH_TOKEN</div><div class="tok" id="t2"></div>'
      +'<button class="ghost" data-c="t2">이 값 복사</button>'
      +'<div class="warn">이 두 개를 GitHub 저장소 → Settings → Secrets and variables → Actions →'
      +' New repository secret 에 <b>같은 이름</b>으로 하나씩 넣으세요.<br><br>'
      +'넣고 나면 이 창을 닫으셔도 됩니다. 값은 다시 못 보니 지금 옮기세요.</div></div>');
    el('#t1').textContent=k;
    el('#t2').textContent=j.refresh_token||'(없음)';
    document.querySelectorAll('[data-c]').forEach(b=>b.onclick=async()=>{
      try{ await navigator.clipboard.writeText(el('#'+b.dataset.c).textContent);
        b.textContent='복사했습니다'; setTimeout(()=>b.textContent='이 값 복사',1600);
      }catch(e){ b.textContent='복사가 막혀 있습니다. 직접 긁어서 복사하세요'; }
    });
  }catch(e){
    show('<div class="err"><b>토큰을 못 받았습니다.</b><br>'+String(e.message||e)+'</div>');
  }
})();
</script></body></html>`;

export async function onRequestGet(context) {
  const origin = new URL(context.request.url).origin;
  return new Response(PAGE(origin), {
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 인가 코드를 토큰으로 바꾼다. 받은 값은 그대로 돌려주고 남기지 않는다. */
export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return json({ error: 'bad_request' }, 400);
  }
  const { code, key, secret, redirect } = body || {};
  if (!code || !key || !redirect) return json({ error: 'missing_params' }, 400);

  // 한 번 연결되면 같은 카카오 앱(같은 REST 키)으로만 다시 연결할 수 있다.
  // 이 주소를 아는 다른 사람이 자기 카카오로 덮어써서 알림을 가로채지 못하게 막는다.
  const kv0 = context.env && context.env.FLOW;
  if (kv0) {
    const cur = await kv0.get('kakao', 'json');
    if (cur && cur.key && cur.key !== key) {
      return json({
        error: 'locked',
        error_description: '이미 다른 카카오 앱으로 연결돼 있습니다. 처음 연결할 때 쓴 REST API 키로만 다시 연결할 수 있습니다.',
      }, 409);
    }
  }

  const fields = {
    grant_type: 'authorization_code',
    client_id: key,
    redirect_uri: redirect,
    code,
  };
  if (secret) fields.client_secret = secret;

  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: new URLSearchParams(fields),
  });
  const j = await r.json();
  if (!r.ok) return json(j, r.status);

  const kv = context.env && context.env.FLOW;
  if (!kv) {
    // 저장소가 없으면 예전처럼 값을 돌려준다. 형이 직접 옮겨야 한다.
    return json({ refresh_token: j.refresh_token, expires_in: j.refresh_token_expires_in });
  }

  await kv.put('kakao', JSON.stringify({
    key,
    secret: secret || null,
    refresh: j.refresh_token,
    saved_at: new Date().toISOString(),
  }));

  // 연결 확인용 시험 메시지. 형 폰에 바로 한 통 간다.
  let test = 'ok';
  try {
    const origin = new URL(redirect).origin;
    const tpl = {
      object_type: 'text',
      text: '[섹터 흐름판] 카카오톡 연결됐습니다.\n평일 08:37 개장 전, 15:37 마감 뒤에 요약이 옵니다.',
      link: { web_url: origin, mobile_web_url: origin },
      button_title: '열어보기',
    };
    const s = await fetch('https://kapi.kakao.com/v2/api/talk/memo/default/send', {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + j.access_token,
        'content-type': 'application/x-www-form-urlencoded;charset=utf-8',
      },
      body: new URLSearchParams({ template_object: JSON.stringify(tpl) }),
    });
    const sj = await s.json().catch(() => ({}));
    if (sj.result_code !== 0) test = JSON.stringify(sj).slice(0, 160);
  } catch (e) {
    test = String(e).slice(0, 160);
  }
  return json({ saved: true, test });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
