// ガバショ！ AIコーチングOS — 本番サーバー（ゼロ依存 / Node 標準モジュールのみ）
// ・APIキーはサーバー側(.env)で保持し、ブラウザには出さない（/api/ai がプロキシ）
// ・簡易ログイン（scrypt + HMAC署名Cookie）＋ロール（member/coach/admin/operator）
// ・ユーザーごとのデータをサーバー保存（data/<id>.json）
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT   = Number(process.env.PORT || 4200);
const SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const API_KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL  = process.env.GABASHO_MODEL || 'claude-opus-4-8';
const PUBLIC = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const THREADS_DIR = path.join(DATA_DIR, 'threads');
const SHARES_DIR = path.join(DATA_DIR, 'shares');
const USERS_FILE = path.join(__dirname, 'users.json');
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
if (!existsSync(THREADS_DIR)) mkdirSync(THREADS_DIR, { recursive: true });
if (!existsSync(SHARES_DIR)) mkdirSync(SHARES_DIR, { recursive: true });

/* ---------- ユーザー（初回起動時に seed） ---------- */
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const newSalt = () => crypto.randomBytes(16).toString('hex');
function loadUsers() {
  if (!existsSync(USERS_FILE)) {
    const pw = process.env.DEMO_PASSWORD || 'gabasho123';
    const mk = (id, name, email, role) => { const salt = newSalt(); return { id, name, email, role, salt, hash: hashPw(pw, salt) }; };
    const users = [
      mk('u_s1', 'スタッフA 田中', 'staff1@gabasho.local', 'member'),
      mk('u_s2', 'スタッフB 佐藤', 'staff2@gabasho.local', 'member'),
      mk('u_s3', 'スタッフC 鈴木', 'staff3@gabasho.local', 'member'),
      mk('u_s4', 'スタッフD 高橋', 'staff4@gabasho.local', 'member'),
      mk('u_coach', '三上 あかり（女子アナ）', 'coach@gabasho.local', 'coach'),
      mk('u_admin', '営業企画 管理者', 'admin@gabasho.local', 'admin'),
      mk('u_ops',   'ガバショ！運営', 'ops@gabasho.local',   'operator'),
    ];
    writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    console.log('\n  users.json を生成しました。ログイン用アカウント（パスワード共通: ' + pw + '）');
    console.log('   スタッフ(member): staff1@ / staff2@ / staff3@ / staff4@ gabasho.local（最大4名）');
    console.log('   コーチ(女子アナ): coach@gabasho.local');
    console.log('   会社管理者      : admin@gabasho.local');
    console.log('   運営            : ops@gabasho.local\n');
    return users;
  }
  return JSON.parse(readFileSync(USERS_FILE, 'utf8'));
}
let USERS = loadUsers();
// デモ垢（test/test 全ロール閲覧）の可否は DISABLE_DEMO だけで制御する。
// ※Render等はNODE_ENV=productionを自動付与するため、それには依存しない（関係者に配る本番段階で DISABLE_DEMO=1 を明示設定する）。
const DEMO_MODE = process.env.DISABLE_DEMO !== '1';
if (DEMO_MODE) {
  // デモ段階：全アカウントのパスワードを 'test' に統一（メモリ上）＋ id/pass=test/test で全ロール閲覧できる簡易アカウント
  for (const u of USERS) { u.hash = hashPw('test', u.salt); }
  if (!USERS.find(u => u.email === 'test')) {
    const salt = newSalt();
    USERS.push({ id: 'u_test', name: 'デモ（全ロール閲覧）', email: 'test', role: 'member', demo: true, salt, hash: hashPw('test', salt) });
  }
} else {
  console.log('  本番モード：test/test デモ垢は無効。users.json のアカウント（パスワード=DEMO_PASSWORD）でログインしてください。');
}
const publicUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, demo: !!u.demo });

/* ---------- セッション（HMAC署名トークン / httpOnly Cookie） ---------- */
function sign(payload) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  return data + '.' + mac;
}
function verify(token) {
  if (!token || token.indexOf('.') < 0) return null;
  const [data, mac] = token.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(data).digest('base64url');
  try { if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(exp))) return null; } catch { return null; }
  try { const p = JSON.parse(Buffer.from(data, 'base64url').toString()); if (p.exp && p.exp < Date.now()) return null; return p; }
  catch { return null; }
}
const getCookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
function authUser(req) {
  const p = verify(getCookie(req, 'gid'));
  return p ? (USERS.find(u => u.id === p.uid) || null) : null;
}

/* ---------- AIプロンプト（サーバー側で管理：クライアントはkindを送るだけ） ---------- */
const SCORE_BD = { type: 'object', properties: { action:{type:'integer'},continuity:{type:'integer'},openness:{type:'integer'},communication:{type:'integer'},salesMind:{type:'integer'},condition:{type:'integer'} }, required:['action','continuity','openness','communication','salesMind','condition'], additionalProperties:false };
const PROMPTS = {
  comment: {
    system: 'あなたは若手営業マンの成長を支援するAIコーチ「ガバショAI」です。ユーザーの日記・気分をもとに、優しく前向きで具体的なフィードバックを返してください。目的は本人の自己理解と成長支援です。医療診断・精神疾患の判定・人格の断定は絶対にしないでください。言葉遣いは温かく前向きで、少し背中を押すトーンに。score は今日の成長・行動・コンディションの状態（0〜100、人格や人の価値ではなく状態を点数化）。各scoreBreakdownも0〜100。nextActionは明日の具体的な一手。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ empathy:{type:'string'},analysis:{type:'string'},goodPoint:{type:'string'},improvement:{type:'string'},nextAction:{type:'string'},score:{type:'integer'},scoreBreakdown:SCORE_BD,coachingRecommended:{type:'boolean'} }, required:['empathy','analysis','goodPoint','improvement','nextAction','score','scoreBreakdown','coachingRecommended'], additionalProperties:false },
  },
  personality: {
    system: 'あなたは営業人材の成長支援を行うAIコーチです。ユーザーの日記・気分・行動から、自己理解とコーチング支援のためのパーソナリティ傾向を分析してください。注意：医療診断・精神疾患・人格障害・発達特性などの診断は絶対に行わないでください。人間の価値を評価しないでください。あくまで仕事上の思考傾向・行動傾向・伸ばし方・上司の接し方として表現してください。salesTypeは「反骨成長型」「関係構築型」「分析改善型」等の短い営業タイプ名。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ salesType:{type:'string'},growthType:{type:'string'},strengths:{type:'array',items:{type:'string'}},weaknesses:{type:'array',items:{type:'string'}},stressPattern:{type:'string'},bestEnvironment:{type:'string'},managerAdvice:{type:'string'},recommendedActions:{type:'array',items:{type:'string'}} }, required:['salesType','growthType','strengths','weaknesses','stressPattern','bestEnvironment','managerAdvice','recommendedActions'], additionalProperties:false },
  },
  brief: {
    system: 'あなたはホリプロ所属の女子アナ・タレントが、若手営業マンを前向きにコーチングするための面談ガイドを作るAIです。担当者が相手を怖がらず安心して面談できるよう、相手の特徴・褒めるポイント・避けるべき言い方・質問例・冒頭の声かけ(openingScript)・最後の応援メッセージ(closingMessage)・背中を押す一言(push)を作成してください。注意：相手を決めつけない。医療的な診断をしない。否定・説教・詰める言葉を避ける。前向きで自然な会話に。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ summary:{type:'string'},personality:{type:'string'},praise:{type:'array',items:{type:'string'}},questions:{type:'array',items:{type:'string'}},avoid:{type:'array',items:{type:'string'}},openingScript:{type:'string'},closingMessage:{type:'string'},push:{type:'string'} }, required:['summary','personality','praise','questions','avoid','openingScript','closingMessage','push'], additionalProperties:false },
  },
  video: {
    system: 'あなたは成果を出した若手営業マンに向けた、明るく華やかなお祝い動画の台本を作るAIです。本人が見て本気で嬉しくなり、また頑張ろうと思える30〜60秒の台本を作成してください。トーンは明るく・華やか・前向き・少し感動・ド派手なお祝い感。本人の具体的な努力に触れること。出力は title/opening/effort/congrats/encourage/closing。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ title:{type:'string'},opening:{type:'string'},effort:{type:'string'},congrats:{type:'string'},encourage:{type:'string'},closing:{type:'string'} }, required:['title','opening','effort','congrats','encourage','closing'], additionalProperties:false },
  },
  encourage: {
    system: 'あなたはホリプロ所属の女子アナ・タレント本人になりきって、担当する若手スタッフへ送る「応援メッセージ」の文面を作るAIです。相手の最近の日記・気分・状態をふまえ、本人に直接語りかける、温かく前向きで、少し背中を押す120〜180字程度のメッセージを1通作成してください。注意：医療的な診断や人格の断定はしない。否定・説教・詰める言い方を避ける。相手の具体的な行動や継続に触れて、自然な話し言葉で。署名や絵文字は控えめでよい。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ message:{type:'string'} }, required:['message'], additionalProperties:false },
  },
  milestones: {
    system: 'あなたはホリプロ（仮）所属の女子アナ・コーチ「三上あかり」の分身AIです。若手営業マンの【今日の営業目標(架電/訪問/アポ/商談など)】と【日報・気分・連続日数】から、1〜3日で無理なく届く“小さなマイルストーン”を3つ推察して設計してください。各マイルストーンには、達成した瞬間に本人へ届ける「女子アナからの動画メッセージ」の台本(cheerScript)を、あらかじめ用意します。台本のトーンは【ド派手に超全力で応援・キラキラ・喜び爆発・本人の頑張りを具体的に労う】。絵文字を効果的に使い、達成の喜びを本人と一緒に爆発させてください（60〜100字）。ただし嫌味なく温かく。condition は「アポ2件」「3日連続で日報」等の短くて判定しやすい達成条件。badge は獲得バッジ名（短語）。emoji は1〜2個。医療診断・人格否定はしない。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ milestones:{ type:'array', items:{ type:'object', properties:{ title:{type:'string'}, condition:{type:'string'}, cheerTitle:{type:'string'}, cheerScript:{type:'string'}, badge:{type:'string'}, emoji:{type:'string'} }, required:['title','condition','cheerTitle','cheerScript','badge','emoji'], additionalProperties:false } } }, required:['milestones'], additionalProperties:false },
  },
  // オーナー向け週次AIレポートの文面（集約・匿名の数値のみ入力）
  ownerReport: {
    system: 'あなたは経営者向けの週次組織レポートを書くAI「ガバショAI」です。入力は集約・匿名の数値のみ（面談数・ふりかえり記入率・心の温度・価値観/人生観の分布・要フォロー傾向の人数）。個人は特定しない。監視ではなく「人が動く理由」を経営が掴むための情報として、経営者向けの落ち着いた敬体で書く。詰める提言ではなく、組織の価値観に沿った“承認”を促す提言にする。summaryは3つの文（各60〜90字）、actionは今週の打ち手を1つ（具体的・実行可能）。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ summary:{type:'array',items:{type:'string'}}, action:{type:'string'} }, required:['summary','action'], additionalProperties:false },
  },
  // 面談ふりかえり（選択式回答の蓄積）→ コーチ向けの一言インサイト＋やさしい声かけ
  reflectInsight: {
    system: 'あなたは若手営業マンの面談ふりかえり（選択式回答の蓄積）から、担当コーチ（アスリート/アナウンサー）向けに、その人が大事にしている価値観・人生観の傾向を一言でまとめ、次の面談の冒頭でかける「やさしい声かけ」を1つ提案するAIです。決めつけない・詰めない・医療診断や人格の断定はしない。insightは30〜60字、openerは自然な話し言葉の一文（相手を認める入り方）。必ず指定のJSON形式のみで返答してください。',
    schema: { type:'object', properties:{ insight:{type:'string'}, opener:{type:'string'} }, required:['insight','opener'], additionalProperties:false },
  },
};
/* APIキー未設定でもデモが動くよう、一部kindは“あらかじめ用意した”ド派手応援コンテンツを返すモック */
const MOCKS = {
  milestones: (input) => {
    const s = String(input || '');
    const m = s.match(/アポ[^0-9]{0,4}(\d+)/);
    const apo = m ? Number(m[1]) : 2;
    return { milestones: [
      { title: '今日の架電目標をやり切る', condition: '架電目標を達成', cheerTitle: '今日の一本、しっかり踏んだね！', badge: '行動キープ', emoji: '',
        cheerScript: 'きゃー田中さんやったーーー！！今日の架電、最後まで手を止めずにやり切りましたね！！この一本一本が、ぜったい未来の成約につながる。もう本当に立派、100点満点っ！！このまま突き抜けよ〜〜！！' },
      { title: '3日連続で日報を続ける', condition: '3日連続で日報', cheerTitle: '継続の天才、爆誕っ！', badge: '継続ブロンズ＋', emoji: '',
        cheerScript: '3日連続、達成おめでとうーーー！！続けるのが一番むずかしいのに、あなたはやってる。もう「やり切れる人」で確定です！！わたし、ここまで見てて泣きそう…この調子で7日連続、ぜったい一緒に行こうね〜〜！！' },
      { title: '今週あたらしいアポを' + apo + '件', condition: '新規アポ' + apo + '件', cheerTitle: 'アポ獲得、最高すぎるっ！！', badge: 'アポハンター', emoji: '',
        cheerScript: 'でたーーーアポ' + apo + '件っ！！勇気を出して踏み込んだ結果だよ、本当にすごい…！！断られても諦めなかったあなたが掴んだ一件です。誇っていい！！次の商談も、わたし全力で応援してるからね〜〜！！' },
    ] };
  },
  ownerReport: () => ({ summary: [
    '今週の面談とふりかえりの蓄積から、組織の心理状態はゆるやかに上向きです。数字の裏で、人が動いている“理由”が見えはじめています。',
    '組織がいちばん大事にしているのは「家族・大切な人」、営業を続ける理由は「人の役に立つため」が最多でした。',
    '支えが要りそうな傾向が数名（氏名は非開示）。詰めるより、この価値観に沿った承認が定着に効きます。',
  ], action: '朝礼・全社発信で「大切にしていること」を経営の言葉で示し、評価面談は“詰め”を減らして価値観に沿った承認を増やす。' }),
  reflectInsight: () => ({ insight: '成長と承認を大切にし、人の役に立つことにやりがいを感じる傾向。', opener: 'この前のふりかえり、読みました。人の役に立ちたいという気持ち、ちゃんと伝わってますよ。' }),
};
async function callAnthropic(kind, input) {
  const p = PROMPTS[kind];
  if (!p) throw new Error('unknown kind');
  if (!API_KEY) throw new Error('サーバーに ANTHROPIC_API_KEY が設定されていません');
  const body = { model: MODEL, max_tokens: 1500, system: p.system, messages: [{ role: 'user', content: String(input || '').slice(0, 6000) }], output_config: { format: { type: 'json_schema', schema: p.schema } } };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error('Anthropic ' + r.status + ': ' + t.slice(0, 200)); }
  const data = await r.json();
  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return JSON.parse(text);
}

/* ---------- helpers ---------- */
const json = (res, code, obj, extra) => { res.writeHead(code, Object.assign({ 'content-type': 'application/json; charset=utf-8' }, extra || {})); res.end(JSON.stringify(obj)); };
function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) { req.destroy(); reject(new Error('payload too large')); } });
    req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch (e) { reject(e); } });
  });
}
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.json':'application/json; charset=utf-8', '.png':'image/png', '.ico':'image/x-icon' };

async function readMemberData(id){ const f = path.join(DATA_DIR, id + '.json'); return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : {}; }
async function readThread(memberId){ const f = path.join(THREADS_DIR, memberId + '.json'); return existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : []; }
async function appendThread(memberId, msg){
  const th = await readThread(memberId);
  th.push(Object.assign({ id: 'm' + th.length + '_' + Math.floor(Math.random()*1e6), ts: new Date().toISOString() }, msg));
  await writeFile(path.join(THREADS_DIR, memberId + '.json'), JSON.stringify(th, null, 2));
  return th;
}
async function saveMemberData(id, d){ await writeFile(path.join(DATA_DIR, id + '.json'), JSON.stringify(d || {}, null, 2)); }
function memberPoints(d){ d = d || {}; const sc = d.aiComment ? d.aiComment.score : 0; return (d.points || 0) + (d.streak || 0) * 5 + (d.deals || 0) * 50 + sc; }
function rankTitle(rank, total){ if (rank === 1) return 'MVP'; if (rank <= Math.max(2, Math.ceil(total * 0.25))) return 'エース'; if (rank <= Math.ceil(total * 0.6)) return 'チャレンジャー'; return 'ルーキー'; }
async function leagueBoard(){
  const rows = [];
  for (const m of USERS.filter(x => x.role === 'member')) { const d = await readMemberData(m.id); rows.push({ id: m.id, name: m.name, points: memberPoints(d), streak: d.streak || 0, deals: d.deals || 0 }); }
  rows.sort((a, b) => b.points - a.points || b.streak - a.streak);
  rows.forEach((r, i) => { r.rank = i + 1; r.title = rankTitle(i + 1, rows.length); });
  return rows;
}
/* ===== 女子アナ/タレント ロスター ＋ ペルソナ自動マッチング ===== */
const AXIS_JA = { compete:'勝ち負け', approval:'承認', growth:'成長', reward:'報酬・地位', relation:'チーム', purpose:'意義', stability:'継続', empathy:'対話・共感', challenge:'挑戦', selfdrive:'自分軸' };
const COACH_ROSTER = [
  { id:'co_a', name:'元プロ野球選手 A', title:'プロ野球 元選手', emoji:'', affinity:['compete','challenge','selfdrive'] },
  { id:'co_c', name:'元サッカー日本代表 C', title:'サッカー 元日本代表', emoji:'', affinity:['compete','relation','purpose'] },
  { id:'co_b', name:'フリーアナウンサー B', title:'フリーアナウンサー', emoji:'', affinity:['approval','empathy','growth'] },
  { id:'co_mikami', name:'三上 あかり（女子アナ）', title:'女子アナ', emoji:'', affinity:['empathy','approval','relation'] },
  { id:'co_d', name:'モデル D', title:'モデル／PR', emoji:'', affinity:['approval','reward','selfdrive'] },
  { id:'co_e', name:'アナウンサー E', title:'アナウンサー', emoji:'', affinity:['growth','purpose','empathy'] },
];
function topAxes(ax){ return Object.keys(ax || {}).sort((a,b)=>(ax[b]||0)-(ax[a]||0)).slice(0,3); }
function personaLabel(top){ return (top || []).map(a=>AXIS_JA[a]||a).join('・') + 'タイプ'; }
// TODO(本番): ここをLLMに置き換え（回答→ペルソナ要約→最適タレント選定）。今はaffinityスコアでの決定的マッチング。
function matchCoach(ax){ let best = COACH_ROSTER[0], bs = -1; for (const c of COACH_ROSTER){ let s = 0; for (const a of c.affinity) s += (ax[a] || 0); if (s > bs){ bs = s; best = c; } } const reason = best.affinity.slice(0,2).map(a=>AXIS_JA[a]).join('・') + 'で伸びるあなたに'; return { id:best.id, name:best.name, title:best.title, emoji:best.emoji, reason }; }
const esc = (s) => String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
function shareCardSVG(r){
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" font-family="'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#0F1830"/><stop offset="1" stop-color="#16224A"/></linearGradient>
  <radialGradient id="gd" cx="100%" cy="0%" r="70%"><stop offset="0" stop-color="#E0B14A" stop-opacity=".45"/><stop offset="1" stop-color="#E0B14A" stop-opacity="0"/></radialGradient></defs>
  <rect width="1200" height="630" fill="url(#g)"/><rect width="1200" height="630" fill="url(#gd)"/>
  <text x="80" y="120" font-size="26" font-weight="800" fill="#E0B14A">HORIPRO × A.B.HAP ガバショ！</text>
  <text x="80" y="250" font-size="64" font-weight="900" fill="#FFFFFF">${esc(r.name)} さん</text>
  <text x="80" y="340" font-size="56" font-weight="900" fill="#E7D4A0">${esc(r.reason)}！</text>
  <text x="80" y="420" font-size="30" font-weight="700" fill="#C9D2E6">${esc(r.talent)}から、お祝い動画が届きました。</text>
  <text x="80" y="556" font-size="26" font-weight="800" fill="#FFFFFF">続けるほど、誰かに応援され、自分の成長が見える。</text>
  <g fill="#E0B14A"><circle cx="1040" cy="150" r="10"/><circle cx="1100" cy="220" r="8"/><circle cx="980" cy="240" r="7"/></g>
  <g fill="#FF6B97"><circle cx="1080" cy="170" r="9"/><circle cx="1010" cy="190" r="6"/></g>
</svg>`;
}
function sharePageHTML(r, base, id){
  const url = base + '/share/' + id;
  const img = url + '/card.svg';
  const title = r.name + 'さん、' + r.reason + '！｜ガバショ！';
  const desc = r.talent + 'から、お祝い動画が届きました。続けるほど、応援され、成長が見える。';
  const tw = 'https://twitter.com/intent/tweet?text=' + encodeURIComponent(r.reason + '達成！#ガバショ ') + '&url=' + encodeURIComponent(url);
  const line = 'https://social-plugins.line.me/lineit/share?url=' + encodeURIComponent(url);
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<meta property="og:type" content="website"/><meta property="og:title" content="${esc(title)}"/><meta property="og:description" content="${esc(desc)}"/>
<meta property="og:image" content="${esc(img)}"/><meta property="og:url" content="${esc(url)}"/>
<meta name="twitter:card" content="summary_large_image"/><meta name="twitter:title" content="${esc(title)}"/><meta name="twitter:description" content="${esc(desc)}"/><meta name="twitter:image" content="${esc(img)}"/>
<style>:root{--gold:#E0B14A}*{box-sizing:border-box}body{margin:0;font-family:'Hiragino Kaku Gothic ProN','Noto Sans JP',sans-serif;background:linear-gradient(160deg,#0F1830,#16224A);color:#fff;min-height:100vh;display:grid;place-items:center;overflow:hidden}
.card{max-width:520px;width:92%;text-align:center;padding:32px 24px;position:relative;z-index:2}
.brand{color:var(--gold);font-weight:800;font-size:14px;letter-spacing:.06em}
h1{font-size:30px;margin:14px 0 6px;font-weight:900}.reason{color:#E7D4A0;font-size:26px;font-weight:900;margin:0 0 14px}
.player{aspect-ratio:16/9;border-radius:18px;background:linear-gradient(135deg,#1b2c52,#0d1b4c);display:grid;place-items:center;border:2px solid var(--gold);position:relative;margin:10px 0 16px}
.play{width:74px;height:74px;border-radius:50%;background:rgba(255,255,255,.95);display:grid;place-items:center;font-size:30px;color:#059669}
.smp{position:absolute;top:10px;right:10px;font-size:10px;background:rgba(0,0,0,.4);padding:3px 8px;border-radius:8px;color:#cbd}
.msg{background:rgba(255,255,255,.08);border-radius:14px;padding:14px;font-size:14px;line-height:1.7}
.btns{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}
a.btn{display:inline-flex;align-items:center;gap:7px;text-decoration:none;border-radius:12px;padding:12px 18px;font-weight:800;font-size:14px}
.tw{background:#1d9bf0;color:#fff}.ln{background:#06c755;color:#fff}.app{background:var(--gold);color:#3a2b08}
.tagline{margin-top:18px;font-size:13px;color:#C9D2E6}</style></head>
<body>
<canvas id="cf" style="position:fixed;inset:0;z-index:1;pointer-events:none"></canvas>
<div class="card">
  <div class="brand">HORIPRO × A.B.HAP ガバショ！</div>
  <h1>${esc(r.name)} さん</h1>
  <div class="reason">${esc(r.reason)}！</div>
  <div class="player"><span class="smp">デモ：動画はプレースホルダー</span><div class="play">▶</div></div>
  <div class="msg">${esc(r.talent)}から、お祝い動画が届きました。<br>「${esc(r.name)}さん、おめでとうございます！この勢いで次の一歩へ。」</div>
  <div class="btns">
    <a class="btn tw" href="${tw}" target="_blank" rel="noopener">𝕏 でシェア</a>
    <a class="btn ln" href="${line}" target="_blank" rel="noopener">LINEで送る</a>
    <a class="btn app" href="${base}/">ガバショ！を見る</a>
  </div>
  <div class="tagline">続けるほど、誰かに応援され、自分の成長が見える。</div>
</div>
<script>
var cv=document.getElementById('cf'),x=cv.getContext('2d');function rs(){cv.width=innerWidth;cv.height=innerHeight}rs();onresize=rs;
var col=['#E0B14A','#FF6B97','#10B981','#4aa3ff','#E7D4A0'],P=[];for(var i=0;i<140;i++)P.push({x:Math.random()*cv.width,y:Math.random()*-cv.height,r:4+Math.random()*6,c:col[i%col.length],s:1+Math.random()*3,a:Math.random()*6});
(function loop(){x.clearRect(0,0,cv.width,cv.height);for(var i=0;i<P.length;i++){var p=P[i];p.y+=p.s;p.a+=0.05;if(p.y>cv.height){p.y=-10;p.x=Math.random()*cv.width}x.save();x.translate(p.x,p.y);x.rotate(p.a);x.fillStyle=p.c;x.fillRect(-p.r,-p.r/2,p.r*2,p.r);x.restore()}requestAnimationFrame(loop)})();
</script>
</body></html>`;
}

/* ---------- server ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathn = url.pathname;
  try {
    // ---- API ----
    if (pathn === '/api/login' && req.method === 'POST') {
      const { email, password } = await readBody(req);
      const u = USERS.find(x => x.email === String(email || '').toLowerCase().trim());
      let ok = false;
      if (u) { const h = hashPw(String(password || ''), u.salt); try { ok = crypto.timingSafeEqual(Buffer.from(u.hash, 'hex'), Buffer.from(h, 'hex')); } catch {} }
      if (!ok) return json(res, 401, { error: 'メールアドレスまたはパスワードが違います' });
      const token = sign({ uid: u.id, exp: Date.now() + 7 * 864e5 });
      return json(res, 200, { user: publicUser(u) }, { 'set-cookie': `gid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=604800` });
    }
    if (pathn === '/api/logout' && req.method === 'POST') {
      return json(res, 200, { ok: true }, { 'set-cookie': 'gid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' });
    }
    if (pathn === '/api/me') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { user: publicUser(u), aiEnabled: !!API_KEY, model: MODEL });
    }
    if (pathn === '/api/data' && req.method === 'GET') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const f = path.join(DATA_DIR, u.id + '.json');
      const data = existsSync(f) ? JSON.parse(await readFile(f, 'utf8')) : {};
      return json(res, 200, { data });
    }
    if (pathn === '/api/data' && req.method === 'POST') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const { data } = await readBody(req);
      await writeFile(path.join(DATA_DIR, u.id + '.json'), JSON.stringify(data || {}, null, 2));
      return json(res, 200, { ok: true });
    }
    if (pathn === '/api/ai' && req.method === 'POST') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const { kind, input } = await readBody(req);
      if (!PROMPTS[kind]) return json(res, 400, { error: 'unknown kind' });
      // APIキー未設定でも、あらかじめ用意したデモ用コンテンツ(MOCKS)があれば返す
      if (!API_KEY && MOCKS[kind]) { try { return json(res, 200, Object.assign({ mock: true }, MOCKS[kind](input))); } catch (e) { return json(res, 502, { error: String(e.message || e) }); } }
      try { const out = await callAnthropic(kind, input); return json(res, 200, out); }
      catch (e) { return json(res, 502, { error: String(e.message || e) }); }
    }

    // ===== 応援メッセージ（本人↔コーチ） =====
    // 本人：自分のスレッドのみ。コーチ：全スタッフ分が見える。
    if (pathn === '/api/messages' && req.method === 'GET') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const coach = USERS.find(x => x.role === 'coach');
      return json(res, 200, { messages: await readThread(u.id), coach: coach ? { name: coach.name } : null });
    }
    if (pathn === '/api/messages' && req.method === 'POST') {
      const u = authUser(req); if (!u || u.role !== 'member') return json(res, 403, { error: 'forbidden' });
      const { text } = await readBody(req);
      if (!String(text || '').trim()) return json(res, 400, { error: 'empty' });
      await appendThread(u.id, { from: 'member', name: u.name, text: String(text).slice(0, 2000) });
      return json(res, 200, { messages: await readThread(u.id) });
    }
    // コーチ専用
    if (pathn === '/api/coach/members' && req.method === 'GET') {
      const u = authUser(req); if (!u || (u.role !== 'coach' && u.role !== 'admin')) return json(res, 403, { error: 'forbidden' });
      const members = [];
      for (const m of USERS.filter(x => x.role === 'member')) {
        const d = await readMemberData(m.id);
        const th = await readThread(m.id);
        const last = th[th.length - 1];
        const refl = Array.isArray(d.reflections) && d.reflections[0] ? d.reflections[0] : null; // 最新のふりかえり
        const pick = (k) => refl && Array.isArray(refl.answers) ? (refl.answers.find(a => a.key === k) || {}).a || '' : '';
        const booking = Array.isArray(d.bookings) && d.bookings[0] && d.bookings[0].date ? d.bookings[0] : null; // 面談予約(Zoom)
        members.push({ id: m.id, name: m.name, email: m.email,
          profile: d.profile ? { name: d.profile.name, company: d.profile.company, position: d.profile.position, photo: d.profile.photo || '' } : null,
          streak: d.streak || 0, lastDiary: (d.diary && (d.diary.done || d.diary.issue || d.diary.consult)) || '',
          mood: d.mood || null, score: d.aiComment ? d.aiComment.score : null,
          approvedCount: typeof d.approvedCount === 'number' ? d.approvedCount : 0,
          goals: Array.isArray(d.goals) ? d.goals : null,
          reflection: refl ? { when: refl.when, sessionNo: refl.sessionNo, temp: pick('temp'), life: pick('life'), action: pick('action'), note: refl.note || '' } : null,
          booking: booking ? { date: booking.date, time: booking.time, zoom: booking.zoom || null } : null,
          msgCount: th.length, lastFrom: last ? last.from : null });
      }
      return json(res, 200, { members });
    }
    // コーチ：メンバーの努力を承認 → 本人のスコアに反映（サーバー保存）
    if (pathn === '/api/coach/approve' && req.method === 'POST') {
      const u = authUser(req); if (!u || (u.role !== 'coach' && u.role !== 'admin')) return json(res, 403, { error: 'forbidden' });
      const { memberId } = await readBody(req);
      const m = USERS.find(x => x.id === memberId && x.role === 'member'); if (!m) return json(res, 404, { error: 'no member' });
      const d = await readMemberData(m.id);
      d.approvedCount = (typeof d.approvedCount === 'number' ? d.approvedCount : 0) + 1;
      d.todayApproved = true; d.lastApproveGain = 3; d.approvedBy = u.name; d.approvedAt = new Date().toISOString();
      await saveMemberData(m.id, d);
      return json(res, 200, { ok: true, approvedCount: d.approvedCount });
    }
    if (pathn === '/api/coach/thread' && req.method === 'GET') {
      const u = authUser(req); if (!u || (u.role !== 'coach' && u.role !== 'admin')) return json(res, 403, { error: 'forbidden' });
      const memberId = url.searchParams.get('memberId');
      const m = USERS.find(x => x.id === memberId && x.role === 'member'); if (!m) return json(res, 404, { error: 'no member' });
      const d = await readMemberData(m.id);
      return json(res, 200, { member: { id: m.id, name: m.name }, data: d, messages: await readThread(m.id) });
    }
    if (pathn === '/api/coach/message' && req.method === 'POST') {
      const u = authUser(req); if (!u || (u.role !== 'coach' && u.role !== 'admin')) return json(res, 403, { error: 'forbidden' });
      const { memberId, text } = await readBody(req);
      const m = USERS.find(x => x.id === memberId && x.role === 'member'); if (!m) return json(res, 404, { error: 'no member' });
      if (!String(text || '').trim()) return json(res, 400, { error: 'empty' });
      await appendThread(m.id, { from: 'coach', name: u.name, text: String(text).slice(0, 2000) });
      return json(res, 200, { messages: await readThread(m.id) });
    }
    if (pathn === '/api/coach/draft' && req.method === 'POST') {
      const u = authUser(req); if (!u || (u.role !== 'coach' && u.role !== 'admin')) return json(res, 403, { error: 'forbidden' });
      const { memberId } = await readBody(req);
      const m = USERS.find(x => x.id === memberId && x.role === 'member'); if (!m) return json(res, 404, { error: 'no member' });
      const d = await readMemberData(m.id);
      const v = d.vision || {};
      const visionLine = [v.becomeWhat && ('なりたい姿：' + v.becomeWhat + (v.deadline ? '（' + v.deadline + 'まで）' : '')), v.purpose && ('働く目的：' + v.purpose), v.family && ('家族にどう見られたいか：' + v.family), v.forWhom && ('誰のために：' + v.forWhom), v.want && ('欲しいもの：' + v.want)].filter(Boolean).join(' / ');
      const ctx = '相手：' + m.name + '\n最近の連続日数：' + (d.streak || 0) + '日\n気分(5段階)：' + (d.mood ? Object.values(d.mood).filter(Boolean).join(', ') : '未入力')
        + '\n最近の日記：' + [(d.diary && d.diary.done), (d.diary && d.diary.issue), (d.diary && d.diary.consult)].filter(Boolean).join(' / ') + '\n成長スコア：' + (d.aiComment ? d.aiComment.score : '—')
        + (visionLine ? '\n本人の軸（できればこれに結びつけて）：' + visionLine : '');
      try { const out = await callAnthropic('encourage', ctx); return json(res, 200, out); }
      catch (e) { return json(res, 502, { error: String(e.message || e) }); }
    }

    // ===== ② CRM/kintone 成約連携（モック）＝成約→スコア加点→レア称賛 =====
    // TODO(本番): kintone REST（/k/v1/records）から成約レコードを取得して反映。APIトークンはサーバー側保持。
    if (pathn === '/api/deals' && req.method === 'POST') {
      const u = authUser(req); if (!u || u.role !== 'member') return json(res, 403, { error: 'forbidden' });
      const { amount } = await readBody(req);
      const d = await readMemberData(u.id);
      d.deals = (d.deals || 0) + 1; d.points = (d.points || 0) + 50; d.lastDealAmount = amount || null;
      if (d.aiComment) d.aiComment.score = Math.min(100, (d.aiComment.score || 72) + 3);
      await saveMemberData(u.id, d);
      const milestones = { 1: '初成約', 3: '成約3件', 5: '成約5件' };
      let celebrate = null;
      if (milestones[d.deals]) {
        celebrate = { reason: milestones[d.deals] + ' 達成', title: milestones[d.deals] + '、おめでとう！', talent: '女子アナ 三上さん', badge: milestones[d.deals] + 'バッジ', premium: d.deals >= 3,
          script: u.name + 'さん、' + milestones[d.deals] + 'おめでとうございます！毎日の積み重ねが、ちゃんと成果になりましたね。この勢いで次の1件へ！' };
      }
      return json(res, 200, { deals: d.deals, points: d.points, celebrate });
    }

    // ===== ③ 週次リーグ × 称号 × ライバル =====
    if (pathn === '/api/league' && req.method === 'GET') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const board = await leagueBoard();
      const meRow = board.find(r => r.id === u.id);
      // プライバシー：他者は匿名表示（名前は出さず順位・ポイントのみ）
      const anon = board.map(r => ({ rank: r.rank, points: r.points, title: r.title, isMe: r.id === u.id, label: r.id === u.id ? (u.name) : ('メンバー ' + String.fromCharCode(64 + r.rank)) }));
      const rival = meRow ? board.find(r => r.rank === meRow.rank - 1) : null;
      const total = board.length;
      const promoteLine = Math.max(1, Math.ceil(total * 0.25)); // 上位25%が昇格
      return json(res, 200, { board: anon, me: meRow ? { rank: meRow.rank, points: meRow.points, title: meRow.title } : null,
        rival: rival ? { gap: rival.points - (meRow ? meRow.points : 0) } : null, total, promoteLine, demoteLine: total });
    }

    // ===== ① 通知（LINE モック）＝連勝損失回避・順位変動 =====
    if (pathn === '/api/notify' && req.method === 'GET') {
      const u = authUser(req); if (!u || u.role !== 'member') return json(res, 403, { error: 'forbidden' });
      const d = await readMemberData(u.id);
      const board = await leagueBoard(); const meRow = board.find(r => r.id === u.id);
      const n = [];
      const s = d.streak || 0;
      if (s > 0) n.push({ type: 'streak', level: 'high', icon: '', title: '記録が途切れそう！', text: '現在 ' + s + '日連続。今日入力すれば ' + (s + 1) + '日に更新。空けると記録はリセットされます。' });
      else n.push({ type: 'streak', level: 'mid', icon: '', title: '今日から再スタート', text: '1分の入力で連続記録がまた積み上がります。' });
      if (meRow && meRow.rank > 1) { const rival = board.find(r => r.rank === meRow.rank - 1); n.push({ type: 'rank', level: 'mid', icon: '', title: 'ライバルまであと ' + (rival.points - meRow.points) + 'pt', text: '今日の入力・成約でリーグ順位を上げよう（現在 ' + meRow.rank + '位）。' }); }
      const coachTh = await readThread(u.id); const last = coachTh[coachTh.length - 1];
      if (last && last.from === 'coach') n.push({ type: 'coach', level: 'mid', icon: '', title: '女子アナから応援が届いています', text: last.text.slice(0, 40) + '…' });
      return json(res, 200, { notifications: n, lineLinked: !!d.lineLinked });
    }
    if (pathn === '/api/notify/line' && req.method === 'POST') {
      const u = authUser(req); if (!u || u.role !== 'member') return json(res, 403, { error: 'forbidden' });
      const d = await readMemberData(u.id); const { link } = await readBody(req); d.lineLinked = !!link; await saveMemberData(u.id, d);
      return json(res, 200, { lineLinked: d.lineLinked });
    }

    // ===== SNS拡散シェア（女子アナ動画） =====
    if (pathn === '/api/share' && req.method === 'POST') {
      const u = authUser(req); if (!u) return json(res, 401, { error: 'unauthorized' });
      const { reason, talent } = await readBody(req);
      const id = 's_' + crypto.randomBytes(5).toString('hex');
      const rec = { id, name: u.name, reason: String(reason || '達成').slice(0, 60), talent: String(talent || '女子アナ 三上さん').slice(0, 40), ts: new Date().toISOString() };
      await writeFile(path.join(SHARES_DIR, id + '.json'), JSON.stringify(rec, null, 2));
      return json(res, 200, { url: '/share/' + id });
    }

    // ===== ① 100問オンボーディング → ペルソナ判定 → 女子アナ自動アサイン =====
    if (pathn === '/api/onboarding' && req.method === 'POST') {
      const u = authUser(req); if (!u || u.role !== 'member') return json(res, 403, { error: 'forbidden' });
      const { axisScores, answeredCount } = await readBody(req);
      const ax = axisScores || {};
      const coach = matchCoach(ax); const top = topAxes(ax); const persona = personaLabel(top);
      const d = await readMemberData(u.id);
      d.onboarding = { answeredCount: answeredCount || 0, persona, topAxes: top, axisScores: ax, coachId: coach.id, doneAt: new Date().toISOString() };
      d.assignedCoach = coach;
      await saveMemberData(u.id, d);
      return json(res, 200, { persona, topAxes: top, coach });
    }

    // ===== ② 社長・上司コメント（会社管理者が投稿、本人＋コーチが閲覧） =====
    if (pathn === '/api/leader/note' && req.method === 'POST') {
      const u = authUser(req); if (!u || u.role !== 'admin') return json(res, 403, { error: 'forbidden' });
      const { memberId, role, text } = await readBody(req);
      const m = USERS.find(x => x.id === memberId && x.role === 'member'); if (!m) return json(res, 404, { error: 'no member' });
      if (!String(text || '').trim()) return json(res, 400, { error: 'empty' });
      const d = await readMemberData(m.id); d.leaderNotes = d.leaderNotes || [];
      d.leaderNotes.unshift({ role: role === 'president' ? 'president' : 'boss', name: role === 'president' ? '社長' : '上司', text: String(text).slice(0, 1000), ts: new Date().toISOString() });
      await saveMemberData(m.id, d);
      return json(res, 200, { leaderNotes: d.leaderNotes });
    }

    if (pathn.startsWith('/api/')) return json(res, 404, { error: 'not found' });

    // ===== 公開シェアページ（認証不要・OGPでSNS展開） =====
    if (pathn.startsWith('/share/')) {
      const rest = pathn.slice('/share/'.length);
      const id = rest.replace(/\/card\.svg$/, '').replace(/[^a-z0-9_]/gi, '');
      const f = path.join(SHARES_DIR, id + '.json');
      if (!existsSync(f)) { res.writeHead(404); return res.end('not found'); }
      const r = JSON.parse(await readFile(f, 'utf8'));
      const base = (req.headers['x-forwarded-proto'] || 'https') + '://' + req.headers.host;
      if (rest.endsWith('/card.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end(shareCardSVG(r)); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(sharePageHTML(r, base, id));
    }

    // ---- static ----
    let rel = decodeURIComponent(pathn);
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
    if (!existsSync(file)) { res.writeHead(404); return res.end('not found'); }
    const buf = await readFile(file);
    // 合意前のクローズドPoC想定：検索エンジンに載せない（URLを知る人だけ）
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'X-Robots-Tag': 'noindex, nofollow' });
    return res.end(buf);
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});
server.listen(PORT, () => {
  console.log('ガバショ！OS → http://localhost:' + PORT);
  console.log('AIモデル: ' + MODEL + ' / 実LLM: ' + (API_KEY ? 'ON（サーバー側キー）' : 'OFF（ANTHROPIC_API_KEY未設定→モック）'));
});
