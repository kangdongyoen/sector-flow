/**
 * 카카오톡 알림 연결 도우미  ·  Cloudflare Pages Function
 *
 * 경로: /kakao
 *
 * 카카오 '나에게 보내기'를 쓰려면 리프레시 토큰이 하나 필요하다.
 * 그걸 받아 내는 과정이 번거로워서, 버튼 두 번으로 끝나게 만든 페이지다.
 *
 * 토큰은 이 페이지에 한 번 뜨고 어디에도 저장되지 않는다.
 * 서버 기록에도 남기지 않는다. 화면에서 복사해서 GitHub Secrets 에 직접 넣으면 된다.
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
</div>

<div class="card">
  <h2>복사한 REST API 키를 넣으세요</h2>
  <input id="key" placeholder="REST API 키" autocomplete="off" spellcheck="false">
  <button id="go">카카오 로그인하고 토큰 받기</button>
  <div class="warn">키와 토큰은 이 브라우저 밖으로 나가지 않습니다. 저장하거나 기록하지 않습니다.</div>
</div>

<div id="out"></div>
</div>
<script>
const KEY='lucent.kakao.key';
const el=(s)=>document.querySelector(s);
const q=new URLSearchParams(location.search);
const origin=location.origin;

el('#key').value=localStorage.getItem(KEY)||'';
el('#go').onclick=()=>{
  const k=el('#key').value.trim();
  if(!k){ el('#key').focus(); return; }
  localStorage.setItem(KEY,k);
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
  const k=localStorage.getItem(KEY);
  if(!k){ show('<div class="err">REST API 키가 없습니다. 이 페이지에서 키를 넣고 다시 시작하세요.</div>'); return; }
  show('<div class="card">토큰을 받는 중입니다.</div>');
  try{
    const r=await fetch('/kakao',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({code,key:k,redirect:origin+'/kakao'})});
    const j=await r.json();
    if(!r.ok||j.error) throw new Error(j.error_description||j.error||('HTTP '+r.status));
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
    history.replaceState(null,'',location.pathname);
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
  const { code, key, redirect } = body || {};
  if (!code || !key || !redirect) return json({ error: 'missing_params' }, 400);

  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: key,
    redirect_uri: redirect,
    code,
  });

  const r = await fetch('https://kauth.kakao.com/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body: form,
  });
  const j = await r.json();
  if (!r.ok) return json(j, r.status);
  return json({ refresh_token: j.refresh_token, expires_in: j.refresh_token_expires_in });
}

function json(o, status = 200) {
  return new Response(JSON.stringify(o), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
